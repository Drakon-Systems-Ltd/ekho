import path from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

/** Register the console and the relay's final not-found handler. */
export async function registerUiRoutes(app: FastifyInstance, uiRoot = path.join(__dirname, "..", "ui-dist")) {
  await app.register(fastifyStatic, {
    root: uiRoot,
    prefix: "/ui/",
    cacheControl: false, // we set Cache-Control ourselves below (no-cache for html, immutable for assets)
    // @fastify/static v10 hands this callback a FastifyReply (v9 passed the raw
    // ServerResponse), so headers are set with reply.header, not res.setHeader.
    setHeaders: (reply, filePath) => {
      // index.html must always revalidate so a new build is picked up on reload;
      // hashed assets are content-addressed and safe to cache forever.
      if (filePath.endsWith("index.html")) {
        reply.header("Cache-Control", "no-cache");
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    }
  });

  app.get("/ui", async (_request, reply) => reply.redirect("/ui/"));

  app.setNotFoundHandler((request, reply) => {
    const requestedPath = String(request.url);
    if (requestedPath.startsWith("/ui/") && !requestedPath.includes(".")) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ message: `Route ${request.method}:${requestedPath} not found` });
  });
}
