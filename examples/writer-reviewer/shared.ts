/**
 * Message payload contracts shared by the writer and reviewer agents.
 *
 * Kept intentionally small so the demo is easy to follow. In a real fleet
 * these would live in a shared package and probably be validated with zod.
 */

export type DraftMessage = {
  kind: "draft";
  title: string;
  body: string;
  author: string;
  submitted_at: string;
};

export type ReviewMessage = {
  kind: "review";
  verdict: "approve" | "revise";
  comment: string;
  reviewer: string;
  reviewed_at: string;
};

/** Stable conversation + correlation identifiers so both sides agree. */
export const DEMO_CONVERSATION_ID = "writer-reviewer-demo";
export const DEMO_CORRELATION_ID = "article-001";

/** The article the writer sends for review. */
export const DRAFT_ARTICLE: Pick<DraftMessage, "title" | "body"> = {
  title: "Why AI Agent Messaging Matters",
  body: [
    "Every production AI system eventually becomes a distributed one.",
    "A planner delegates to a researcher, a researcher hands off to a",
    "coder, the coder files a PR and a reviewer weighs in. Without a",
    "signed, auditable messaging layer, that coordination collapses into",
    "brittle function calls and stringly-typed queues.",
    "",
    "Ekho treats agents as first-class identities with inboxes, delivery",
    "guarantees, and policy-gated actions. The result: fleets that can",
    "fail, retry, and resume without losing a conversation."
  ].join(" ")
};

/** ANSI colour helpers — a tiny subset to avoid extra dependencies. */
export const colour = {
  reset: "\x1b[0m",
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  writer: (s: string) => `\x1b[38;5;39m${s}\x1b[0m`, // cyan-blue
  reviewer: (s: string) => `\x1b[38;5;208m${s}\x1b[0m`, // orange
  relay: (s: string) => `\x1b[38;5;244m${s}\x1b[0m`, // grey
  success: (s: string) => `\x1b[38;5;82m${s}\x1b[0m`, // green
  error: (s: string) => `\x1b[38;5;203m${s}\x1b[0m` // red
};
