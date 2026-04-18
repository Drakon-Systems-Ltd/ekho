import type { FastifyInstance } from "fastify";
import { db } from "./db";
import { getLoadedLicense } from "./license";

const RELAY_VERSION = "0.1.0";

interface CountRow {
  label: string;
  count: number;
}

function readCountsBy(sql: string): CountRow[] {
  try {
    return db.raw().prepare(sql).all() as CountRow[];
  } catch {
    return [];
  }
}

function readScalar(sql: string): number {
  try {
    const row = db.raw().prepare(sql).get() as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

function renderMetric(opts: {
  name: string;
  help: string;
  type: "gauge" | "counter";
  samples: Array<{ labels?: Record<string, string>; value: number }>;
}): string {
  const lines: string[] = [];
  lines.push(`# HELP ${opts.name} ${opts.help}`);
  lines.push(`# TYPE ${opts.name} ${opts.type}`);
  for (const s of opts.samples) {
    if (s.labels && Object.keys(s.labels).length > 0) {
      const labelStr = Object.entries(s.labels)
        .map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
        .join(",");
      lines.push(`${opts.name}{${labelStr}} ${s.value}`);
    } else {
      lines.push(`${opts.name} ${s.value}`);
    }
  }
  return lines.join("\n");
}

export function renderPrometheus(): string {
  const license = getLoadedLicense();

  const blocks: string[] = [];

  // ekho_up
  blocks.push(
    renderMetric({
      name: "ekho_up",
      help: "1 if the relay is running.",
      type: "gauge",
      samples: [{ value: 1 }],
    })
  );

  // ekho_relay_info
  blocks.push(
    renderMetric({
      name: "ekho_relay_info",
      help: "Static information about the relay build.",
      type: "gauge",
      samples: [
        {
          labels: { version: RELAY_VERSION, tier: license.tier, org: license.org },
          value: 1,
        },
      ],
    })
  );

  // ekho_fleets_total
  blocks.push(
    renderMetric({
      name: "ekho_fleets_total",
      help: "Number of fleets configured in the relay.",
      type: "gauge",
      samples: [{ value: readScalar("SELECT COUNT(*) AS count FROM fleets") }],
    })
  );

  // ekho_agents_total{status}
  const agents = readCountsBy(
    "SELECT COALESCE(status,'unknown') AS label, COUNT(*) AS count FROM agents WHERE revoked_at IS NULL GROUP BY label"
  );
  blocks.push(
    renderMetric({
      name: "ekho_agents_total",
      help: "Active (non-revoked) agents grouped by status.",
      type: "gauge",
      samples: agents.map((r) => ({ labels: { status: r.label }, value: r.count })),
    })
  );

  // ekho_messages_total{status} — messages lifetime
  const messages = readCountsBy(
    "SELECT COALESCE(status,'unknown') AS label, COUNT(*) AS count FROM messages GROUP BY label"
  );
  blocks.push(
    renderMetric({
      name: "ekho_messages_total",
      help: "Messages grouped by status.",
      type: "gauge",
      samples: messages.map((r) => ({ labels: { status: r.label }, value: r.count })),
    })
  );

  // ekho_deliveries_total{status}
  const deliveries = readCountsBy(
    "SELECT COALESCE(status,'unknown') AS label, COUNT(*) AS count FROM message_deliveries GROUP BY label"
  );
  blocks.push(
    renderMetric({
      name: "ekho_deliveries_total",
      help: "Message deliveries grouped by status.",
      type: "gauge",
      samples: deliveries.map((r) => ({ labels: { status: r.label }, value: r.count })),
    })
  );

  // ekho_dead_letters_total
  blocks.push(
    renderMetric({
      name: "ekho_dead_letters_total",
      help: "Total archived dead-letter messages.",
      type: "gauge",
      samples: [{ value: readScalar("SELECT COUNT(*) AS count FROM dead_letters") }],
    })
  );

  // ekho_rate_violations_total (last 24h)
  const violationsSql = `
    SELECT COUNT(*) AS count
    FROM rate_limit_violations
    WHERE created_at >= datetime('now','-1 day')
  `;
  blocks.push(
    renderMetric({
      name: "ekho_rate_violations_24h",
      help: "Rate-limit violations recorded in the last 24 hours.",
      type: "gauge",
      samples: [{ value: readScalar(violationsSql) }],
    })
  );

  // ekho_heartbeats_recent — heartbeats in last 5 minutes as liveness indicator
  const heartbeatsSql = `
    SELECT COUNT(*) AS count
    FROM heartbeats
    WHERE received_at >= datetime('now','-5 minutes')
  `;
  blocks.push(
    renderMetric({
      name: "ekho_heartbeats_recent",
      help: "Heartbeats received in the last 5 minutes (cross-fleet).",
      type: "gauge",
      samples: [{ value: readScalar(heartbeatsSql) }],
    })
  );

  // ekho_a2a_tasks_total{state} — only if table exists
  const a2aTasks = readCountsBy(
    "SELECT state AS label, COUNT(*) AS count FROM a2a_tasks GROUP BY state"
  );
  if (a2aTasks.length > 0) {
    blocks.push(
      renderMetric({
        name: "ekho_a2a_tasks_total",
        help: "A2A tasks grouped by lifecycle state.",
        type: "gauge",
        samples: a2aTasks.map((r) => ({ labels: { state: r.label }, value: r.count })),
      })
    );
  }

  return blocks.join("\n\n") + "\n";
}

export function registerMetricsRoute(app: FastifyInstance) {
  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return renderPrometheus();
  });
}
