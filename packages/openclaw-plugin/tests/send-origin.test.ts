import { describe, it, expect, beforeEach, vi } from "vitest";
import { EKHO_ORIGIN_STAMP } from "../src/autoreply";

/**
 * End-to-end wiring proof for #17: the metadata that actually reaches
 * client.sendMessage carries origin_session_id when — and only when — the host's
 * tool context supplied a session identity.
 *
 * The relay is never touched: connection.js is mocked, so ekho_send runs against
 * a fake client that records the wire payload. The host is stood in for by
 * tests/stubs/openclaw-tool-plugin.ts (aliased in vitest.config.ts), which
 * mirrors openclaw 2026.7.1-2's registration: factory tools are registered as a
 * function of the toolContext, which is the only place sessionKey/sessionId
 * exist.
 */

const sentPayloads: Array<Record<string, unknown>> = [];

vi.mock("../src/connection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/connection.js")>();
  return {
    ...actual,
    // No fleetId => the best-effort signing block is skipped (as on an unsigned agent).
    ensureConnected: async () => ({
      client: {
        sendMessage: async (payload: Record<string, unknown>) => {
          sentPayloads.push(payload);
          return { message_id: "msg_1" };
        },
        uploadAttachment: async () => ({ id: "att_1" })
      },
      credentials: { agentId: "agent_self", secret: "s", relayBaseUrl: "http://relay.test", fleetId: "" }
    }),
    getEkhoIdentity: () => null
  };
});

type ToolLike = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
};

/**
 * Register the plugin against a fake host and hand back ekho_send's factory —
 * the same function object the gateway would call with its tool context.
 */
async function ekhoSendFactory(): Promise<(toolContext: unknown) => ToolLike> {
  const plugin = (await import("../src/index.js")).default;
  const registered: Array<{ tool: unknown; opts?: { name?: string } }> = [];
  plugin.register({
    pluginConfig: {}, // no relayBaseUrl => no startup connect
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    registerTool: (tool: unknown, opts?: { name?: string }) => registered.push({ tool, opts })
  } as never);

  const entry = registered.find((r) => r.opts?.name === "ekho_send");
  expect(entry, "ekho_send was not registered").toBeTruthy();
  expect(typeof entry!.tool, "ekho_send must register as a factory to see the session").toBe("function");
  return entry!.tool as (toolContext: unknown) => ToolLike;
}

async function sendWith(toolContext: unknown) {
  const tool = (await ekhoSendFactory())(toolContext);
  const result = await tool.execute("call_1", { recipient_agent_id: "agent_b", message: "hi" });
  return { result, payload: sentPayloads.at(-1)! };
}

describe("ekho_send origin stamping (#17)", () => {
  beforeEach(() => {
    sentPayloads.length = 0;
  });

  it("stamps the host's sessionKey on the outbound send", async () => {
    const { payload } = await sendWith({ sessionKey: "sk_stable", sessionId: "uuid_ephemeral" });
    expect(payload.metadata).toEqual({
      ekho_origin: EKHO_ORIGIN_STAMP,
      origin_session_id: "sk_stable"
    });
  });

  it("falls back to sessionId when the host exposes only that", async () => {
    const { payload } = await sendWith({ sessionId: "uuid_ephemeral" });
    expect(payload.metadata).toEqual({
      ekho_origin: EKHO_ORIGIN_STAMP,
      origin_session_id: "uuid_ephemeral"
    });
  });

  it("omits origin_session_id when the host supplies no session identity", async () => {
    for (const ctx of [{}, undefined, { sessionKey: "", sessionId: "  " }]) {
      sentPayloads.length = 0;
      const { payload } = await sendWith(ctx);
      expect(payload.metadata).toEqual({ ekho_origin: EKHO_ORIGIN_STAMP });
    }
  });

  it("keeps the rest of the send unchanged by the factory move", async () => {
    const { result, payload } = await sendWith({ sessionKey: "sk_stable" });
    expect(payload.recipient).toEqual({ kind: "agent", id: "agent_b" });
    expect(payload.body).toEqual({ text: "hi" });
    expect(payload.message_type).toBe("direct");
    // A factory tool wraps its own result: same JSON text + details the host's
    // execute wrapper produced before the move.
    expect(JSON.parse(result.content[0].text)).toMatchObject({ sent: true, message_id: "msg_1" });
    expect(result.details).toMatchObject({ sent: true, message_id: "msg_1" });
  });

  it("registers the factory tool under the same name/description the host catalogued", async () => {
    const tool = (await ekhoSendFactory())({ sessionKey: "sk_stable" });
    expect(tool.name).toBe("ekho_send");
    expect(tool.description).toContain("Send a message to another agent in your fleet");
    expect(tool.parameters).toBeTruthy();
  });
});
