/**
 * Writer agent — drafts an article and sends it to the reviewer.
 *
 * Flow:
 *   1. Enroll using EKHO_WRITER_TOKEN.
 *   2. Wait for the reviewer's agent_id (provided via EKHO_REVIEWER_AGENT_ID
 *      so the two processes can find each other).
 *   3. Send a `direct` message with a DraftMessage body.
 *   4. Poll inbox via the adapter until a ReviewMessage comes back.
 *   5. Print the verdict and exit cleanly.
 */

import { EkhoAgentAdapter, type InboxMessage } from "@drakon-systems/ekho-sdk";
import { enrollAgent } from "./enroll";
import {
  colour,
  DEMO_CONVERSATION_ID,
  DEMO_CORRELATION_ID,
  DRAFT_ARTICLE,
  type DraftMessage,
  type ReviewMessage
} from "./shared";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function log(msg: string) {
  console.log(`${colour.writer(colour.bold("[writer]  "))} ${msg}`);
}

async function waitForEnv(name: string, timeoutMs = 20000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = process.env[name];
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${name}`);
}

async function main() {
  const relayBaseUrl = process.env.EKHO_RELAY_URL ?? "http://127.0.0.1:4000";
  const fleetId = requireEnv("EKHO_FLEET_ID");
  const token = requireEnv("EKHO_WRITER_TOKEN");

  log(colour.dim("enrolling with relay..."));
  const credentials = await enrollAgent({
    relayBaseUrl,
    fleetId,
    token,
    displayName: "Writer Agent"
  });
  log(`enrolled as ${colour.bold(credentials.agentId)}`);

  // Publish our agent_id for the orchestrator / reviewer.
  if (process.send) process.send({ type: "writer_ready", agentId: credentials.agentId });

  // Wait until the reviewer has enrolled and its id has been shared back.
  const reviewerAgentId = await waitForEnv("EKHO_REVIEWER_AGENT_ID");
  log(`will review via ${colour.bold(reviewerAgentId)}`);

  let reviewReceived: ReviewMessage | null = null;

  const adapter = new EkhoAgentAdapter(credentials, {
    async onMessage(message: InboxMessage) {
      if (message.message_type !== "direct") return;
      const body = message.body as Partial<ReviewMessage>;
      if (body.kind !== "review") return;

      reviewReceived = body as ReviewMessage;
      const verdictColour = body.verdict === "approve" ? colour.success : colour.error;
      log(`review received: ${verdictColour(colour.bold(body.verdict!.toUpperCase()))}`);
      log(colour.dim(`  comment: ${body.comment}`));
    }
  });

  await adapter.start();

  const draft: DraftMessage = {
    kind: "draft",
    title: DRAFT_ARTICLE.title,
    body: DRAFT_ARTICLE.body,
    author: credentials.agentId,
    submitted_at: new Date().toISOString()
  };

  log(`sending draft "${colour.bold(draft.title)}" for review...`);
  await adapter.send({
    recipient: { kind: "agent", id: reviewerAgentId },
    message_type: "direct",
    priority: "normal",
    ttl_seconds: 300,
    body: draft as unknown as Record<string, unknown>,
    metadata: { example: "writer-reviewer" },
    conversation_id: DEMO_CONVERSATION_ID,
    correlation_id: DEMO_CORRELATION_ID
  });

  // Wait up to 25s for a review to come back.
  const deadline = Date.now() + 25000;
  while (!reviewReceived && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  adapter.stop();

  if (!reviewReceived) {
    log(colour.error("no review received within 25s — giving up."));
    process.exit(1);
  }

  log(colour.success("conversation complete. exiting."));
  // Small grace period to let any in-flight ack finish.
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error(`${colour.writer("[writer]")} ${colour.error("fatal:")}`, err);
  process.exit(1);
});
