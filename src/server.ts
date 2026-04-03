import path from "node:path";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "./config";
import { db } from "./db";
import { registerAgentRoutes } from "./routes-agent";
import { registerOperatorRoutes } from "./routes-operator";
import { startSweepJob } from "./sweep";

async function buildServer() {
  const app = fastify({ logger: true });
  const uiRoot = path.join(process.cwd(), "ui-dist");

  await app.register(fastifyStatic, {
    root: uiRoot,
    prefix: "/ui/"
  });

  app.get("/ui", async (_request, reply) => reply.redirect("/ui/"));

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/", async () => ({
    service: "ekho-relay",
    version: "0.1.0",
    setup_required: !db.findFleetByName("default"),
    docs: {
      architecture: "/ARCHITECTURE.md",
      ui: "/ui/"
    }
  }));

  await registerAgentRoutes(app);
  await registerOperatorRoutes(app);

  app.setNotFoundHandler((request, reply) => {
    const requestedPath = String(request.url);
    if (requestedPath.startsWith("/ui/") && !requestedPath.includes(".")) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ message: `Route ${request.method}:${requestedPath} not found` });
  });

  return app;
}

buildServer()
  .then(async (app) => {
    await app.listen({ host: config.host, port: config.port });
    const sweep = startSweepJob(db);
    app.addHook("onClose", () => sweep.stop());
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
