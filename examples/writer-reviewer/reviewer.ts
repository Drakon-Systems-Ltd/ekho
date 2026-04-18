/**
 * Reviewer agent — waits for a draft, critiques it, and replies with a verdict.
 *
 * Flow:
 *   1. Enroll using EKHO_REVIEWER_TOKEN.
 *   2. Publish its own agent_id so the writer knows where to send the draft.
 *   3. Poll inbox via the adapter. On receipt of a DraftMessage, run a
 *      deterministic "review" against it and reply with a ReviewMessage.
 *   4. Exit cleanly after the reply is sent.
 */

import { EkhoAgentAdapter, type InboxMessage } from "@ekho/sdk";
import { enrollAgent } from "./enroll";
import {
  colour,
  DEMO_CONVERSATION_ID,
  DEMO_CORRELATION_ID,
  type DraftMessage,
  type ReviewMessage
} from "./shared";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function log(msg: string) {
  console.log(`${colour.reviewer(colour.bold("[reviewer]"))} ${msg}`);
}

/**
 * Tiny deterministic reviewer: looks at the draft length and whether it
 * mentions the core value prop. In a real fleet this would be an LLM call.
 */
function critique(draft: DraftMessage): { verdict: ReviewMessage["verdict"]; comment: string } {
  const wordCount = draft.body.split(/\s+/).length;
  const mentionsDelivery = /deliver|retry|inbox|signed/i.test(draft.body);

  if (wordCount < 40) {
    return { verdict: "revise", comment: `Draft is only ${wordCount} words — expand the argument.` };
  }
  if (!mentionsDelivery) {
    return { verdict: "revise", comment: "Missing the delivery-guarantee angle — worth calling out explicitly." };
  }
  return {
    verdict: "approve",
    comment: `Clear thesis, covers identity and delivery guarantees, ${wordCount} words — ship it.`
  };
}

async function main() {
  const relayBaseUrl = process.env.EKHO_RELAY_URL ?? "http://127.0.0.1:4000";
  const fleetId = requireEnv("EKHO_FLEET_ID");
  const token = requireEnv("EKHO_REVIEWER_TOKEN");

  log(colour.dim("enrolling with relay..."));
  const credentials = await enrollAgent({
    relayBaseUrl,
    fleetId,
    token,
    displayName: "Reviewer Agent"
  });
  log(`enrolled as ${colour.bold(credentials.agentId)}`);

  // Announce our id so the writer knows where to send the draft.
  if (process.send) process.send({ type: "reviewer_ready", agentId: credentials.agentId });

  let replied = false;

  const adapter = new EkhoAgentAdapter(credentials, {
    async onMessage(message: InboxMessage, self) {
      if (message.message_type !== "direct") return;
      const body = message.body as Partial<DraftMessage>;
      if (body.kind !== "draft") return;

      const draft = body as DraftMessage;
      log(`draft received: "${colour.bold(draft.title)}" from ${draft.author}`);

      const { verdict, comment } = critique(draft);
      const verdictColour = verdict === "approve" ? colour.success : colour.error;
      log(`verdict: ${verdictColour(colour.bold(verdict.toUpperCase()))} — ${colour.dim(comment)}`);

      const review: ReviewMessage = {
        kind: "review",
        verdict,
        comment,
        reviewer: credentials.agentId,
        reviewed_at: new Date().toISOString()
      };

      await self.send({
        recipient: { kind: "agent", id: message.sender_agent_id },
        message_type: "direct",
        priority: "normal",
        ttl_seconds: 300,
        body: review as unknown as Record<string, unknown>,
        metadata: { example: "writer-reviewer" },
        conversation_id: DEMO_CONVERSATION_ID,
        correlation_id: DEMO_CORRELATION_ID
      });

      log(colour.success("review sent. exiting."));
      replied = true;
    }
  });

  await adapter.start();

  // Exit once we've replied. Also exit after 25s regardless so the demo
  // never hangs an orchestrator.
  const deadline = Date.now() + 25000;
  while (!replied && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  adapter.stop();

  if (!replied) {
    log(colour.error("no draft received within 25s — giving up."));
    process.exit(1);
  }

  setTimeout(() => process.exit(0), 300);
}

main().catch((err) => {
  console.error(`${colour.reviewer("[reviewer]")} ${colour.error("fatal:")}`, err);
  process.exit(1);
});
