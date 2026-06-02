import type { FastifyInstance } from "fastify";
import { db } from "./db";

/**
 * Liveness and readiness probes.
 *
 * /healthz is a cheap "the process is up" liveness check.
 * /readyz verifies the relay can actually serve traffic by pinging the
 * database, returning 503 if the store is unreachable so orchestrators can
 * hold traffic until the relay is truly ready.
 */
export function registerHealthRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_request, reply) => {
    try {
      db.raw().prepare("SELECT 1").get();
      return { ready: true };
    } catch (err) {
      return reply.code(503).send({
        ready: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });
}
