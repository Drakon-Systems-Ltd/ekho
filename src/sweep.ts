import type { EkhoDb } from "./db";
import { config } from "./config";

export function startSweepJob(db: EkhoDb): { stop: () => void } {
  const handle = setInterval(() => {
    try {
      const retry = db.sweepRetryDeliveries();
      if (retry.retried > 0 || retry.deadLettered > 0) {
        console.log(`[sweep] retry: ${retry.retried} requeued, ${retry.deadLettered} dead-lettered`);
      }
    } catch (err) {
      console.error("[sweep] retry sweep failed:", err);
    }

    try {
      const expired = db.sweepExpiredMessages();
      if (expired > 0) {
        console.log(`[sweep] expired: ${expired} messages`);
      }
    } catch (err) {
      console.error("[sweep] expiry sweep failed:", err);
    }

    try {
      const liveness = db.sweepHeartbeatLiveness();
      if (liveness > 0) {
        console.log(`[sweep] heartbeat liveness: ${liveness} agents auto-quarantined`);
      }
    } catch (err) {
      console.error("[sweep] heartbeat liveness sweep failed:", err);
    }

    try {
      db.sweepStaleRateLimitCounters();
    } catch (err) {
      console.error("[sweep] rate limit counter cleanup failed:", err);
    }
  }, config.sweepIntervalMs);

  return {
    stop() {
      clearInterval(handle);
    }
  };
}
