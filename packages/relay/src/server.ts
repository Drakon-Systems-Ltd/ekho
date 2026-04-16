import path from "node:path";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "./config";
import { db } from "./db";
import { registerAgentRoutes } from "./routes-agent";
import { registerOperatorRoutes } from "./routes-operator";
import { registerA2ARoutes } from "./a2a/routes";
import { startSweepJob } from "./sweep";
import { loadLicense, registerExtension } from "./license";

async function buildServer() {
  const app = fastify({ logger: true });
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

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/", async () => ({
    service: "ekho-relay",
    version: "0.1.0",
    tier: license.tier,
    setup_required: !db.findFleetByName("default"),
    docs: {
      architecture: "/ARCHITECTURE.md",
      ui: "/ui/",
      a2a_agent_card: "/.well-known/agent-card.json"
    }
  }));

  await registerAgentRoutes(app);
  await registerOperatorRoutes(app);
  await registerA2ARoutes(app);

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
    await app.listen({ host: config.host, port: config.port });
    startSweep();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
