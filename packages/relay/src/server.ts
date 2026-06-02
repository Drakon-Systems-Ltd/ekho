import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
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

  const uiRoot = path.join(__dirname, "..", "ui-dist");

  await app.register(fastifyStatic, {
    root: uiRoot,
    prefix: "/ui/"
  });

  app.get("/ui", async (_request, reply) => reply.redirect("/ui/"));

  registerHealthRoutes(app);
  app.get("/", async () => ({
    service: "ekho-relay",
    version: "0.2.1",
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

  app.setNotFoundHandler((request, reply) => {
    const requestedPath = String(request.url);
    if (requestedPath.startsWith("/ui/") && !requestedPath.includes(".")) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ message: `Route ${request.method}:${requestedPath} not found` });
  });

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
