import { describe, it, expect } from "vitest";
// Pure @-mention helpers for the composer. No React/DOM, so they unit-test cleanly.
import { mentionContext, insertMention, parseMentions, filterAgents } from "../frontend/src/mentions.js";

const roster = [
  { agent_id: "agent_vision", display_name: "Vision" },
  { agent_id: "agent_jarvis", display_name: "Jarvis" },
  { agent_id: "agent_tars", display_name: "Tars" },
];

describe("mentionContext", () => {
  it("detects an active @-token at the caret", () => {
    const ctx = mentionContext("hi @Ja", 6);
    expect(ctx.active).toBe(true);
    expect(ctx.query).toBe("Ja");
    expect(ctx.start).toBe(3);
  });

  it("is active right after a bare @", () => {
    const ctx = mentionContext("hi @", 4);
    expect(ctx.active).toBe(true);
    expect(ctx.query).toBe("");
  });

  it("does not trigger on an @ glued to a word (e.g. an email)", () => {
    const ctx = mentionContext("mail me@host", 12);
    expect(ctx.active).toBe(false);
  });

  it("is inactive once the token is closed by a space", () => {
    const ctx = mentionContext("hi @Jarvis done", 15);
    expect(ctx.active).toBe(false);
  });

  it("is active for an @ at the very start", () => {
    const ctx = mentionContext("@Vis", 4);
    expect(ctx.active).toBe(true);
    expect(ctx.query).toBe("Vis");
    expect(ctx.start).toBe(0);
  });
});

describe("insertMention", () => {
  it("replaces the partial token with the full handle plus a trailing space", () => {
    const r = insertMention("hi @Ja", 6, "Jarvis");
    expect(r.text).toBe("hi @Jarvis ");
    expect(r.caret).toBe(11);
  });

  it("keeps text after the caret intact", () => {
    const r = insertMention("@Vi and go", 3, "Vision");
    expect(r.text).toBe("@Vision  and go");
  });
});

describe("parseMentions", () => {
  it("resolves @handles in the text to agent ids (case-insensitive)", () => {
    expect(parseMentions("@Jarvis where are you?", roster)).toEqual(["agent_jarvis"]);
    expect(parseMentions("hey @vision and @TARS", roster)).toEqual(["agent_vision", "agent_tars"]);
  });

  it("ignores unknown handles and de-dupes repeats", () => {
    expect(parseMentions("@ghost @Tars @Tars", roster)).toEqual(["agent_tars"]);
  });

  it("returns an empty array when there are no mentions", () => {
    expect(parseMentions("just a normal message", roster)).toEqual([]);
  });
});

describe("filterAgents", () => {
  it("filters by case-insensitive substring of the display name", () => {
    expect(filterAgents(roster, "ar").map((a) => a.agent_id)).toEqual(["agent_jarvis", "agent_tars"]);
  });

  it("returns the roster (capped) for an empty query", () => {
    expect(filterAgents(roster, "").length).toBe(3);
  });
});
