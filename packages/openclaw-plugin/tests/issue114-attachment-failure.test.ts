import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalAttachments } from "../src/index";
import { inboxMessageView } from "../src/inbox-trust";

// ekho#114: an attachment the relay advertised but the recipient could not fetch
// must be reported, not silently dropped (the "empty inbox" symptom).
const meta = (id: string, size = 5) => ({ id, filename: `${id}.txt`, mime: "text/plain", size_bytes: size });

describe("ekho_inbox reports attachments it could not download (#114)", () => {
  it("lists a failed and an oversize attachment as unavailable and keeps the good sibling", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho114-"));
    const client = {
      downloadAttachment: async (id: string) => {
        if (id === "bad") throw new Error("boom https://relay.invalid/secret-detail");
        return { bytes: Buffer.from("hello"), filename: `${id}.txt`, mime: "text/plain" };
      }
    };
    const messages = [{ message_id: "m1", attachments: [meta("good"), meta("bad"), meta("huge", 10 ** 9)] }];
    const out = await resolveLocalAttachments(messages, client as never, { stateDir });
    expect(out.attachments[0].map((a) => a.id)).toEqual(["good"]);
    expect(out.unavailable[0]).toEqual([
      { id: "bad", filename: "bad.txt", reason: "download-failed" },
      { id: "huge", filename: "huge.txt", reason: "too-large" }
    ]);
    expect(JSON.stringify(out.unavailable)).not.toContain("secret-detail");
  });

  it("surfaces attachments_unavailable on the message view, and omits it when empty", () => {
    const msg = { message_id: "m1", message_type: "direct", sender_kind: "agent", sender_agent_id: "p", body: { text: "x" }, conversation_id: "c" };
    const un = [{ id: "bad", filename: "bad.txt", reason: "download-failed" }];
    expect(inboxMessageView(msg, null, { operatorTrusted: false, attachments: [], attachmentsUnavailable: un })).toMatchObject({ attachments_unavailable: un });
    expect(inboxMessageView(msg, null, { operatorTrusted: false, attachments: [] })).not.toHaveProperty("attachments_unavailable");
  });
});
