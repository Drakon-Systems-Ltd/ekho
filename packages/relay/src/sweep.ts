import type { EkhoDb } from "./db";
import { config } from "./config";
import { fetchFeedUrl } from "./feeds";
import { loginThrottle } from "./login-throttle";

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

    try {
      // In-memory login failure buckets: drop expired windows so a sustained
      // spray across many accounts/IPs can't grow the map without bound.
      loginThrottle.sweep();
    } catch (err) {
      console.error("[sweep] login throttle cleanup failed:", err);
    }

    try {
      const nonces = db.sweepStaleNonces();
      if (nonces > 0) {
        console.log(`[sweep] replay nonces: ${nonces} pruned`);
      }
    } catch (err) {
      console.error("[sweep] nonce cleanup failed:", err);
    }

    // Feeds: poll any source whose interval has elapsed. Fire-and-forget — the
    // network fetch is async; pollFeed stamps last_polled_at up-front so a feed
    // can't be double-polled across ticks.
    try {
      for (const f of db.feedsDueForPoll(Date.now())) {
        void db
          .pollFeed(f.id, fetchFeedUrl)
          .then((r) => {
            if (r.delivered > 0) console.log(`[sweep] feed ${f.id}: delivered ${r.delivered} new item(s)`);
          })
          .catch((err) => console.error("[sweep] feed poll failed:", err));
      }
    } catch (err) {
      console.error("[sweep] feed scan failed:", err);
    }
  }, config.sweepIntervalMs);

  return {
    stop() {
      clearInterval(handle);
    }
  };
}
