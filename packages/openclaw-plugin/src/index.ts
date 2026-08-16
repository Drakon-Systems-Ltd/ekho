import crypto from "node:crypto";
import fs from "node:fs";
import type { EkhoAgentClient } from "@drakon-systems/ekho-sdk";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { ensureConnected, getEkhoIdentity, noteObservedModel, noteModelCallEnded, seedConfigModelFromOpenClawConfig, type EkhoPluginConfig } from "./connection.js";
import { getCachedInbox, EKHO_ORIGIN_STAMP } from "./autoreply.js";
import { buildSignedSendFields } from "./verification.js";
import { inboxMessageView } from "./inbox-trust.js";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  attachmentLocalPath,
  attachmentsDownloadDir,
  readUploadFile,
  sanitizeFilename
} from "./attachments.js";

/** Attachment metadata as the relay surfaces it on an inbox message (never bytes). */
interface InboxAttachmentMeta {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
}

/** What the agent sees per attachment after we download it to disk. */
interface LocalAttachment {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  local_path: string;
}

/**
 * For each inbox message, download its attachments to the scoped local dir and
 * return a parallel array (index-aligned to `messages`) of the local attachment
 * descriptors. Each download is wrapped in try/catch so a single failure (bad
 * id, oversize, network) drops just that attachment and never fails the whole
 * inbox read. Already-present files are not re-downloaded (id-keyed path).
 */
async function resolveLocalAttachments(
  messages: Array<Record<string, unknown>>,
  client: EkhoAgentClient
): Promise<LocalAttachment[][]> {
  const dir = attachmentsDownloadDir();
  let dirReady = false;
  const ensureDir = () => {
    if (!dirReady) {
      fs.mkdirSync(dir, { recursive: true });
      dirReady = true;
    }
  };

  return Promise.all(
    messages.map(async (m) => {
      const metas = Array.isArray(m.attachments) ? (m.attachments as InboxAttachmentMeta[]) : [];
      const out: LocalAttachment[] = [];
      for (const meta of metas) {
        if (!meta || typeof meta.id !== "string") continue;
        // Size guard mirrors the upload cap — never write more than the cap to disk.
        if (typeof meta.size_bytes === "number" && meta.size_bytes > ATTACHMENT_MAX_BYTES) {
          continue;
        }
        const filename = sanitizeFilename(typeof meta.filename === "string" ? meta.filename : meta.id);
        const localPath = attachmentLocalPath(meta.id, filename);
        try {
          if (!fs.existsSync(localPath)) {
            const { bytes } = await client.downloadAttachment(meta.id);
            if (bytes.length > ATTACHMENT_MAX_BYTES) continue; // defence: trust decoded length too
            ensureDir();
            fs.writeFileSync(localPath, bytes, { mode: 0o600 });
          }
          out.push({
            id: meta.id,
            filename,
            mime: typeof meta.mime === "string" ? meta.mime : "application/octet-stream",
            size_bytes: typeof meta.size_bytes === "number" ? meta.size_bytes : 0,
            local_path: localPath
          });
        } catch {
          // One bad attachment must not fail the inbox read — skip it silently.
        }
      }
      return out;
    })
  );
}

/**
 * Ekho relay adapter for OpenClaw.
 *
 * Gives the agent two tools to coordinate with the rest of an Ekho fleet:
 *   - ekho_send:  message another agent or a topic room (delegate, ask, coordinate) + attach files
 *   - ekho_open_room: open a named topic room and continue a multi-step thread there
 *   - ekho_inbox: read pending messages from other agents (+ download attachments)
 *
 * On startup (and again lazily on first tool use) it enrolls (or loads saved
 * credentials) and starts a background heartbeat so the agent appears healthy
 * in the operator console without having to call a tool first. All identity
 * (relay URL, fleet, token) comes from per-agent config — nothing is hardcoded.
 */
const plugin = defineToolPlugin({
  id: "ekho-adapter",
  name: "Ekho Relay Adapter",
  description: "Connect this agent to an Ekho relay to message and coordinate with other agents in the fleet.",
  activation: { onStartup: true },
  configSchema: Type.Object({
    relayBaseUrl: Type.String({ description: "Ekho relay base URL, e.g. https://relay.example.ts.net" }),
    fleetId: Type.Optional(Type.String({ description: "Fleet ID to enroll into (with enrollmentToken on first run)" })),
    enrollmentToken: Type.Optional(Type.String({ description: "One-time operator enrollment token (first run only)" })),
    agentId: Type.Optional(Type.String({ description: "Pre-provisioned agent id (skips enrollment)" })),
    agentSecret: Type.Optional(Type.String({ description: "Pre-provisioned agent secret (skips enrollment)" })),
    displayName: Type.Optional(Type.String({ description: "Display name shown in the operator console" })),
    heartbeatIntervalMs: Type.Optional(Type.Number({ description: "Heartbeat interval in ms (default 30000)" })),
    peerAutoreply: Type.Optional(Type.Boolean({ description: "Enable bounded agent-to-agent delegation — let teammates wake this agent (default true; set false to opt out)" })),
    peerTurnBudget: Type.Optional(Type.Number({ description: "Max times a teammate may wake this agent per conversation before the latch closes (default 25)" }))
  }),
  tools: (tool) => [
    tool({
      name: "ekho_send",
      description:
        "Send a message to another agent in your fleet via the Ekho relay. Use this to delegate a task, ask a question, hand off work, or coordinate. Set recipient_agent_id to 'broadcast' to reach the whole fleet. To post into a topic room (see ekho_open_room), set room_id instead — the message goes to every room member.",
      parameters: Type.Object({
        recipient_agent_id: Type.Optional(Type.String({ description: "Ekho agent_id of the recipient, or 'broadcast' for the whole fleet. Omit when sending to a room (use room_id)." })),
        room_id: Type.Optional(Type.String({ description: "Send to a topic room: its members all receive the message. Takes precedence over recipient_agent_id." })),
        message: Type.String({ description: "The message text to send." }),
        conversation_id: Type.Optional(Type.String({ description: "Existing conversation id to thread under (optional; ignored when room_id is set — the room is the conversation)." })),
        attachment_paths: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Local file path(s) to attach. Each is read, base64-encoded, and uploaded; must be an allowed type (images png/jpg/gif/webp, or pdf/txt/md/csv/json) under the 25 MiB size cap. Max 10 per message."
          })
        )
      }),
      execute: async ({ recipient_agent_id, room_id, message, conversation_id, attachment_paths }, config: EkhoPluginConfig) => {
        const roomId = typeof room_id === "string" ? room_id.trim() : "";
        if (!roomId && !recipient_agent_id) {
          throw new Error("provide recipient_agent_id (an agent id or 'broadcast') or room_id");
        }
        const { client, credentials } = await ensureConnected(config);
        // A room send threads under the room id (the room IS the conversation);
        // otherwise use the supplied conversation id or mint a fresh one.
        const conversationId = roomId || conversation_id || `oc-${Date.now()}`;
        const stamp = `oc-${Date.now()}`;

        // Upload any attachments first; collect their server-issued ids to bind
        // into the (HMAC-signed) message body as body.attachments. Validate the
        // count + each file locally for a fast, clear error — the relay is still
        // authoritative and re-checks everything.
        const paths = Array.isArray(attachment_paths) ? attachment_paths : [];
        if (paths.length > ATTACHMENT_MAX_PER_MESSAGE) {
          throw new Error(`too many attachments (${paths.length}); max ${ATTACHMENT_MAX_PER_MESSAGE} per message`);
        }
        const attachmentIds: string[] = [];
        for (const p of paths) {
          const { bytes, mime, filename } = readUploadFile(p);
          const up = await client.uploadAttachment({ filename, mime, dataBase64: bytes.toString("base64") });
          attachmentIds.push(up.id);
        }

        const recipient =
          roomId
            ? { kind: "group", id: roomId }
            : recipient_agent_id === "broadcast"
            ? { kind: "broadcast" }
            : { kind: "agent", id: recipient_agent_id };
        const sendPayload: Record<string, unknown> = {
          recipient,
          message_type: "direct",
          // body.attachments rides inside the signed body — the relay binds it to
          // the message and validates ownership against this agent.
          body: { text: message, ...(attachmentIds.length ? { attachments: attachmentIds } : {}) },
          // Stamp every agent send so peers' auto-reply loops (and ours) can tell
          // a machine reply from a human/operator one and avoid echo ping-pong.
          metadata: { ekho_origin: EKHO_ORIGIN_STAMP },
          conversation_id: conversationId,
          correlation_id: stamp
        };

        // Best-effort: sign the outbound message so recipients can verify it's us.
        try {
          const ident = getEkhoIdentity();
          if (ident && credentials.fleetId) {
            Object.assign(
              sendPayload,
              buildSignedSendFields({
                identity: ident,
                fleetId: credentials.fleetId,
                selfAgentId: credentials.agentId,
                recipient,
                conversationId,
                bodyText: message,
                nonce: crypto.randomBytes(16).toString("base64url"),
                sentAt: new Date().toISOString(),
                // v2 (#9): bind what the relay could otherwise relabel/swap.
                messageType: "direct",
                priority: "normal",
                attachments: attachmentIds
              })
            );
          }
        } catch {
          /* unsigned send is still valid (graceful) */
        }

        const result = await client.sendMessage(sendPayload as Parameters<typeof client.sendMessage>[0]);
        return {
          sent: true,
          message_id: result.message_id,
          conversation_id: conversationId,
          ...(roomId ? { room_id: roomId } : {}),
          attachments: attachmentIds
        };
      }
    }),
    tool({
      name: "ekho_open_room",
      description:
        "Open a named topic room for a multi-step collaboration or a handoff you'll iterate on, then continue there instead of repeated direct messages. The room is scoped to the agents you list (you are added automatically) and is visible to the operator, who can follow and chime in. Returns the room id — send into it with ekho_send using room_id.",
      parameters: Type.Object({
        topic: Type.String({ description: "The room name — a short, specific topic (e.g. 'Invoice sync rollout')." }),
        member_agent_ids: Type.Optional(
          Type.Array(Type.String(), {
            description: "Ekho agent_ids of the OTHER agents to include (you are added automatically). Must be agents in your fleet."
          })
        )
      }),
      execute: async ({ topic, member_agent_ids }, config: EkhoPluginConfig) => {
        const name = typeof topic === "string" ? topic.trim() : "";
        if (!name) throw new Error("topic is required");
        const { client } = await ensureConnected(config);
        const members = Array.isArray(member_agent_ids) ? member_agent_ids.filter((m) => typeof m === "string" && m) : [];
        const room = await client.createRoom({ name, member_agent_ids: members });
        return {
          opened: true,
          room_id: room.id,
          name: room.name,
          members: room.members,
          // Tell the agent how to continue in the room it just opened.
          next: `Send into this room with ekho_send using room_id="${room.id}".`
        };
      }
    }),
    tool({
      name: "ekho_inbox",
      description:
        "Re-list the Ekho messages you are currently handling. You receive messages automatically — new fleet messages are delivered to you as turns, so you do not need to poll. Use this only to re-read the messages from your most recent inbound batch (e.g. to recall sender ids or conversation ids while replying via ekho_send).",
      parameters: Type.Object({}),
      execute: async (_params, config: EkhoPluginConfig) => {
        // The background auto-reply loop is the single consumer of the inbox: it
        // calls getInbox() (which consumes + delivers) and acks. This tool reads
        // the loop's cached view of the most recent batch instead of calling
        // getInbox() again, so a manual call during a turn can never double-
        // consume rows the loop is mid-processing. No ack here for the same
        // reason — the loop already acked.
        const { client } = await ensureConnected(config);
        const cached = getCachedInbox();
        // Entries pair each message with ITS OWN verdict. `messages` is a
        // positional mirror (index i matches) used only for attachment resolution.
        const entries = cached.entries;
        const messages = cached.messages as unknown as Array<Record<string, unknown>>;
        const operatorTrusted = Boolean(cached.operator_trusted);
        const roster = (cached.roster ?? []) as unknown as Array<Record<string, unknown>>;
        const controls = (cached.controls ?? []) as unknown as Array<Record<string, unknown>>;
        const peerAutoreply = Boolean(cached.peer_autoreply);
        const peerTurnBudget = Number(cached.peer_turn_budget) || 0;
        const peerTurnsUsed = cached.peer_turns_used ?? {};

        // Download each message's attachments to a scoped local dir and surface
        // the local_path so the agent's file tools can open them. Done here (on
        // demand) — not in the background poll loop — so we don't write disk on
        // every poll. Each download is isolated: one bad attachment never fails
        // the whole inbox read. Bytes are written 0o600 under an id-prefixed,
        // sanitized filename (no collisions, no path traversal).
        const localAttachments = await resolveLocalAttachments(messages, client);

        return {
          count: messages.length,
          // When ON, the relay vouches that the console operator is this agent's
          // verified principal. Surfaced top-level so the agent can reason about
          // operator messages even before reading them.
          operator_trusted: operatorTrusted,
          // Bounded delegation, surfaced top-level so the agent can reason about
          // its peer budget even before reading individual messages.
          peer_autoreply: peerAutoreply,
          peer_turn_budget: peerTurnBudget > 0 ? peerTurnBudget : null,
          // One pure, unit-tested projection per message (ekho#20). The verdict
          // travels with the message from the cache, so a dead-lettered item can
          // never be served as an ordinary one — and the mapping lives in
          // inbox-trust.ts where a test can execute it without a live relay.
          messages: entries.map((e, i) =>
            inboxMessageView(e.message as unknown as Record<string, unknown>, e.verification, {
              operatorTrusted,
              attachments: localAttachments[i],
              peerTurnBudget,
              peerTurnsUsed: peerTurnsUsed as Record<string, number>
            })
          ),
          // Teammates the agent can delegate to / coordinate with.
          roster: roster.map((r) => ({
            agent_id: r.agent_id,
            display_name: r.display_name,
            runtime: r.runtime,
            status: r.status
          })),
          controls,
          // Recent thread per room conversation, so a manual inbox read shows the
          // agent the room context, not just the messages aimed at it.
          conversation_history: cached.conversation_history ?? {}
        };
      }
    })
  ]
});

// Extend the tool plugin's register() so the agent connects on gateway startup —
// enroll/load credentials, begin heartbeating, and start the background auto-reply
// loop immediately, so it shows healthy in the operator console and reacts to
// inbound fleet messages without waiting for the first tool call. We thread `api`
// through so the loop can reach the host's turn-trigger primitives. Failure here
// is non-fatal: the tools still connect lazily on first use.
const registerTools = plugin.register;
plugin.register = (api) => {
  registerTools(api);

  // Auto-detect the active model for the operator health board (so OpenClaw agents
  // show their model without per-host EKHO_REPORT_MODEL config). Seed from the
  // resolved config now — the first heartbeat fires before any model call — then
  // keep it live via the host's model_call hook. Both feature-detected and
  // wrapped: a host/SDK lacking these surfaces just falls back to the env var (or
  // reports no model, exactly as before). Never let detection break startup.
  try {
    seedConfigModelFromOpenClawConfig(api.config);
  } catch (err) {
    api.logger?.debug?.(`[ekho-adapter] model config seed unavailable: ${String(err)}`);
  }
  try {
    api.registerHook?.("model_call_started", (event) => {
      const e = event as { model?: string; provider?: string } | undefined;
      noteObservedModel(e?.model, e?.provider);
    });
  } catch (err) {
    api.logger?.debug?.(`[ekho-adapter] model_call hook unavailable: ${String(err)}`);
  }
  // Turn-outcome telemetry: fold each finished model call into the rolling
  // health window so the heartbeat carries a truthful cognitive-health signal
  // (an agent whose every turn 404s reads red on the board, not green).
  try {
    api.registerHook?.("model_call_ended", (event) => {
      const e = event as { outcome?: string; errorCategory?: string; failureKind?: string } | undefined;
      noteModelCallEnded(e?.outcome, e?.errorCategory ?? e?.failureKind);
    });
  } catch (err) {
    api.logger?.debug?.(`[ekho-adapter] model_call_ended hook unavailable: ${String(err)}`);
  }

  const config = api.pluginConfig as EkhoPluginConfig | undefined;
  if (config?.relayBaseUrl) {
    void ensureConnected(config, api.logger, api).catch((err) => {
      api.logger?.warn?.(`[ekho-adapter] startup connect failed: ${String(err)}`);
    });
  }
};

export default plugin;
