import fastify, { type FastifyInstance } from "fastify";
import { config, assertOperatorSecret, isInsecureSecret } from "./config";
import { db } from "./db";
import { registerAgentRoutes } from "./routes-agent";
import { registerOperatorRoutes } from "./routes-operator";
import { registerA2ARoutes } from "./a2a/routes";
import { registerMetricsRoute } from "./metrics";
import { registerHealthRoutes } from "./health";
import { buildHttpsOptions } from "./tls";
import { startSweepJob } from "./sweep";
import { loadLicense, registerExtension } from "./license";
import { registerSecurityHeaders } from "./security-headers";
import { registerUiRoutes } from "./ui-routes";

async function buildServer() {
  assertOperatorSecret(config.operatorSessionSecret, Boolean(process.env.EKHO_DEV_INSECURE));

  const https = buildHttpsOptions();
  // The HTTPS server exposes the same route API; pin to the default instance
  // type so the route registrars accept it regardless of TLS.
  const app: FastifyInstance = https
    ? (fastify({ logger: true, https }) as unknown as FastifyInstance)
    : fastify({ logger: true });
  if (https) {
    app.log.info("TLS enabled — serving HTTPS");
  }

  // Baseline security headers on EVERY response (console, API, errors, 404s).
  registerSecurityHeaders(app);

  // Tolerate an empty body on application/json requests (e.g. a bodyless DELETE
  // that still carries a content-type header) instead of 400-ing on it.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "" || body == null) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });
  if (isInsecureSecret(config.operatorSessionSecret)) {
    app.log.warn("EKHO_OPERATOR_SESSION_SECRET is insecure — running only because EKHO_DEV_INSECURE is set. Do NOT use in production.");
  }
  const license = loadLicense();
  app.log.info({ tier: license.tier, org: license.org }, "ekho license loaded");

  // Load ShieldCortex bridge if configured
  if (config.shieldcortexPath) {
    try {
      const { createShieldCortexExtension } = await import("@ekho/shieldcortex-bridge");
      registerExtension(createShieldCortexExtension({
        cortexBinaryPath: config.shieldcortexPath,
        defenceProfile: config.shieldcortexProfile,
        enableMemoryExtraction: true,
        enableIronDome: true
      }));
      app.log.info({ profile: config.shieldcortexProfile }, "shieldcortex bridge loaded");
    } catch (err) {
      app.log.warn({ err }, "failed to load shieldcortex bridge");
    }
  }

  registerHealthRoutes(app);
  app.get("/", async () => ({
    service: "ekho-relay",
    version: "0.6.0",
    tier: license.tier,
    setup_required: !db.findFleetByName("default"),
    docs: {
      architecture: "/ARCHITECTURE.md",
      ui: "/ui/",
      a2a_agent_card: "/.well-known/agent-card.json",
      metrics: "/metrics"
    }
  }));

  await registerAgentRoutes(app);
  await registerOperatorRoutes(app);
  await registerA2ARoutes(app);
  registerMetricsRoute(app);

  await registerUiRoutes(app);

  // Register sweep job shutdown hook before listening
  let sweep: ReturnType<typeof startSweepJob> | null = null;
  app.addHook("onClose", () => { if (sweep) sweep.stop(); });

  return { app, startSweep: () => { sweep = startSweepJob(db); } };
}

buildServer()
  .then(async ({ app, startSweep }) => {
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      app.log.info({ signal }, "shutting down");
      try {
        await app.close();
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      }
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));

    await app.listen({ host: config.host, port: config.port });
    startSweep();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
