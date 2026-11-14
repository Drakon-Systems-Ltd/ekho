import { McpClient, type McpToolResult } from "./mcp-client";

export interface BeforeMessageContext {
  fleetId: string;
  senderAgentId: string;
  recipientId: string | null;
  messageType: string;
  priority: string;
  body: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface EkhoExtension {
  name: string;
  onBeforeMessage?(ctx: BeforeMessageContext): Promise<void>;
}

export interface ShieldCortexBridgeConfig {
  cortexBinaryPath: string;
  defenceProfile: "strict" | "balanced" | "permissive";
  enableMemoryExtraction: boolean;
  enableIronDome: boolean;
}

export interface ShieldCortexSelfTestResult {
  /** Tool names the ShieldCortex server advertised. */
  tools: string[];
}

export interface ShieldCortexExtension extends EkhoExtension {
  /**
   * Liveness self-test: start ShieldCortex, complete the MCP handshake and
   * confirm it advertises the tools the hook relies on (`iron_dome_scan`, and
   * `iron_dome_check` when the action gate is enabled). Resolves with the
   * advertised tool names; rejects with the reason when the server cannot be
   * reached or lacks a required tool.
   */
  selfTest(): Promise<ShieldCortexSelfTestResult>;
  /** Stop the ShieldCortex process, if one is running. */
  close(): void;
}

export type ScanRiskLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ScanVerdict {
  riskLevel: ScanRiskLevel;
  summary?: string;
}

export type GateDecision = "approved" | "requires_approval" | "blocked";

export interface GateVerdict {
  decision: GateDecision;
  reason?: string;
}

const RISK_LEVELS: ReadonlySet<string> = new Set(["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const GATE_DECISIONS: ReadonlySet<string> = new Set(["approved", "requires_approval", "blocked"]);

/** Text of a tool result, or null when the result carries no text or reports a tool error. */
function resultText(result: McpToolResult | null | undefined): string | null {
  if (!result || result.isError) return null;
  const text = result.content?.[0]?.text;
  return typeof text === "string" ? text : null;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Lines of a Markdown report, without trailing carriage returns. */
function reportLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\r$/, ""));
}

const GATE_RESTRICTIVENESS: Record<GateDecision, number> = { approved: 0, requires_approval: 1, blocked: 2 };

/**
 * Read a scan verdict from an `iron_dome_scan` result. Accepts the server's
 * Markdown report (`**Risk Level:** CRITICAL`, `**Summary:** ...`) and a JSON
 * object with `riskLevel`. In Markdown the risk level is read only from the
 * report's field block (the lines before the first `### ` section), where it
 * must be a whole line and appear exactly once; a report with no such line,
 * with more than one, or with an unknown level has no verdict. Returns null
 * when no risk level can be read, so the caller never mistakes "no verdict"
 * for "clean".
 */
export function parseScanVerdict(text: string | null): ScanVerdict | null {
  if (text === null) return null;
  const json = tryParseJson(text);
  if (json) {
    const level = typeof json.riskLevel === "string" ? json.riskLevel.toUpperCase() : null;
    if (!level || !RISK_LEVELS.has(level)) return null;
    return { riskLevel: level as ScanRiskLevel, summary: typeof json.summary === "string" ? json.summary : undefined };
  }
  const lines = reportLines(text);
  const sectionStart = lines.findIndex((line) => line.startsWith("### "));
  const fields = sectionStart === -1 ? lines : lines.slice(0, sectionStart);
  const levelLines = fields.filter((line) => line.startsWith("**Risk Level:**"));
  if (levelLines.length !== 1) return null;
  const level = levelLines[0].match(/^\*\*Risk Level:\*\*\s*([A-Za-z]+)\s*$/)?.[1]?.toUpperCase();
  if (!level || !RISK_LEVELS.has(level)) return null;
  const summaryLine = fields.find((line) => line.startsWith("**Summary:**"));
  const summary = summaryLine?.slice("**Summary:**".length).trim();
  return { riskLevel: level as ScanRiskLevel, summary: summary || undefined };
}

/**
 * Read an action-gate verdict from an `iron_dome_check` result. Accepts the
 * server's Markdown report (`**Action Gate:** blocked — reason`, or
 * `**Result:** BLOCKED by gateway ...`) and a JSON object with `decision`.
 * Markdown fields count only as whole lines. A gateway block line always
 * means blocked. When several action-gate lines are present the most
 * restrictive decision is the verdict, and an unrecognised decision on any of
 * them means no verdict unless another one blocks. "Iron Dome is not active"
 * (the server has no gate to apply) counts as approved only when that notice
 * is the whole report under its heading; next to any other field it is not a
 * verdict. Returns null when no decision can be read.
 */
export function parseGateVerdict(text: string | null): GateVerdict | null {
  if (text === null) return null;
  const json = tryParseJson(text);
  if (json) {
    const decision = typeof json.decision === "string" ? json.decision.toLowerCase() : null;
    if (!decision || !GATE_DECISIONS.has(decision)) return null;
    return { decision: decision as GateDecision, reason: typeof json.reason === "string" ? json.reason : undefined };
  }
  const lines = reportLines(text);
  for (const line of lines) {
    const gatewayBlock = line.match(/^\*\*Result:\*\*\s*BLOCKED by gateway\.?\s*(.*)$/);
    if (gatewayBlock) {
      return { decision: "blocked", reason: `blocked by gateway. ${gatewayBlock[1]?.trim() ?? ""}`.trim() };
    }
  }
  const gateLines = lines.filter((line) => line.startsWith("**Action Gate:**"));
  if (gateLines.length > 0) {
    let verdict: GateVerdict | null = null;
    let unreadable = false;
    for (const line of gateLines) {
      const gateMatch = line.match(/^\*\*Action Gate:\*\*\s*([a-z_]+)\s*(?:[—-]+\s*(.*))?$/);
      const decision = gateMatch?.[1];
      if (!decision || !GATE_DECISIONS.has(decision)) {
        unreadable = true;
        continue;
      }
      const candidate: GateVerdict = { decision: decision as GateDecision, reason: gateMatch?.[2]?.trim() || undefined };
      if (!verdict || GATE_RESTRICTIVENESS[candidate.decision] > GATE_RESTRICTIVENESS[verdict.decision]) verdict = candidate;
    }
    if (verdict?.decision === "blocked") return verdict;
    if (unreadable) return null;
    if (verdict?.decision === "approved" && lines.some((line) => /^Iron Dome is not active\./.test(line))) return null;
    return verdict;
  }
  const content = lines.filter((line) => line.trim() !== "" && line !== "## Iron Dome Check");
  if (content.length === 1 && /^Iron Dome is not active\.(?: All actions are allowed\.)?\s*$/.test(content[0])) {
    return { decision: "approved", reason: "Iron Dome is not active on the ShieldCortex server" };
  }
  return null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createShieldCortexExtension(config: ShieldCortexBridgeConfig): ShieldCortexExtension {
  let client: McpClient | null = null;
  const strict = config.defenceProfile === "strict";

  function getClient(): McpClient {
    if (!client) {
      client = new McpClient(config.cortexBinaryPath);
    }
    return client;
  }

  return {
    name: "shieldcortex-bridge",

    async selfTest(): Promise<ShieldCortexSelfTestResult> {
      const tools = await getClient().listTools();
      const required = ["iron_dome_scan", ...(config.enableIronDome ? ["iron_dome_check"] : [])];
      const missing = required.filter((name) => !tools.includes(name));
      if (missing.length > 0) {
        throw new Error(`ShieldCortex server does not provide required tool(s): ${missing.join(", ")}`);
      }
      return { tools };
    },

    close() {
      client?.close();
    },

    async onBeforeMessage(ctx: BeforeMessageContext): Promise<void> {
      const mcp = getClient();
      const bodyText = typeof ctx.body === "string" ? ctx.body : JSON.stringify(ctx.body);
      const source = { type: "agent", identifier: ctx.senderAgentId };

      // 1. Injection scan. `strict` rejects on a HIGH/CRITICAL verdict and
      //    also when no verdict could be obtained (transport failure, timeout,
      //    server error, unreadable result): a gate that cannot scan does not
      //    pass messages. `balanced`/`permissive` log and continue.
      let scanFailure: string | null = null;
      let verdict: ScanVerdict | null = null;
      try {
        const scanResult = await mcp.callTool("iron_dome_scan", { text: bodyText });
        verdict = parseScanVerdict(resultText(scanResult));
        if (!verdict) {
          scanFailure = scanResult?.isError
            ? `scan tool error: ${scanResult.content?.[0]?.text ?? "no detail"}`
            : "no verdict in scan result";
        }
      } catch (err) {
        scanFailure = describe(err);
      }

      if (scanFailure !== null) {
        console.warn(`[shieldcortex-bridge] scan failed: ${scanFailure}`);
        if (strict) {
          throw new Error(`scan unavailable: ${scanFailure}`);
        }
      } else if (verdict && (verdict.riskLevel === "CRITICAL" || verdict.riskLevel === "HIGH")) {
        if (strict) {
          throw new Error(`threat detected: ${verdict.summary ?? "high-risk content"}`);
        }
        // Balanced/permissive: log but allow
        console.warn(`[shieldcortex-bridge] threat in message from ${ctx.senderAgentId}: ${verdict.summary ?? verdict.riskLevel}`);
      }

      // 2. Iron Dome action gate. A `blocked` or `requires_approval` decision
      //    rejects in every profile; `strict` also rejects when no decision
      //    could be obtained.
      if (config.enableIronDome) {
        let gateFailure: string | null = null;
        let gate: GateVerdict | null = null;
        try {
          const gateResult = await mcp.callTool("iron_dome_check", {
            action: `send_message:${ctx.messageType}`,
            source
          });
          gate = parseGateVerdict(resultText(gateResult));
          if (!gate) {
            gateFailure = gateResult?.isError
              ? `action gate tool error: ${gateResult.content?.[0]?.text ?? "no detail"}`
              : "no decision in action gate result";
          }
        } catch (err) {
          gateFailure = describe(err);
        }

        if (gateFailure !== null) {
          console.warn(`[shieldcortex-bridge] action gate failed: ${gateFailure}`);
          if (strict) {
            throw new Error(`action gate unavailable: ${gateFailure}`);
          }
        } else if (gate?.decision === "blocked") {
          throw new Error(`Iron Dome blocked: ${gate.reason ?? "action not allowed"}`);
        } else if (gate?.decision === "requires_approval") {
          throw new Error(`Iron Dome requires approval: ${gate.reason ?? "action needs operator review"}`);
        }
      }

      // 3. Memory extraction (fire-and-forget)
      if (config.enableMemoryExtraction) {
        void (async () => {
          try {
            await mcp.callTool("remember", {
              title: `Agent ${ctx.senderAgentId} → ${ctx.recipientId ?? "broadcast"}: ${ctx.messageType}`,
              content: bodyText.slice(0, 2000),
              category: "pattern",
              tags: ["ekho", "agent-communication", ctx.messageType],
              source
            });
          } catch {
            // Fire-and-forget — don't block message delivery
          }
        })();
      }
    }
  };
}

export { McpClient } from "./mcp-client";
