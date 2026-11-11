# `ekho update` (#118) — design, with the C4 heartbeat-completion rule

Status: design only. No implementation, install or canary is authorised by this document. Written fresh on 2026-11-11 from issue #118 and its design-review status comment (6071896841), because the round-3 design text was not recoverable by the ruling's deadline (2026-11-11T13:35Z). Base: `main` `5303fda`. Source line numbers below are from that commit.

Anything this document says about C1–C3, C5, C6 and F1/F5/F6/F7/F10 is a **restatement of the one-line summaries in comment 6071896841**, not the reviewed round-3 text. Where the original text would differ, the original wins and this file is reconciled to it.

## Problem

`packages/hermes-plugin/plugin.yaml` says `version: 0.1.0` while the OpenClaw plugin is 0.7.x, and there is no CLI package. A fleet operator has no one command to bring a runtime (OpenClaw plugin, Hermes plugin, relay) to the latest release and to know afterwards that the new code is what is running.

## Scope (v1)

- `ekho update` per runtime: detect installed runtime and version, fetch the target release artifact, install it, restart through the host's own unit, then `ekho verify`.
- `--dry-run` writes nothing and prints the plan.
- Summaries only, restated from the review status: C1 shared-SDK scope is conservative in v1 (the updater does not move a shared SDK another consumer depends on); C2 the SDK artifact and its dependency set are gated before install; C3 root, interpreter and restart-unit identity are resolved and printed before any change; C5 the installed artifact and the install root are bound (verify compares what is loaded with what was just installed); C6 no-op and failure outcomes have a fixed precedence.
- The updater never creates, rotates, pins or unpins a key, and refuses if the operation would write identity or credential files (R8).
- Nothing in this document authorises an install or canary on a live box (R8).

## `ekho verify` and the C4 residual

`verify` opens a window at time `T_v` (taken after the install and restart request) and reports one of:

- `verified` — the artifact just installed is the one **currently producing** for this agent;
- `loaded` — the new code is loaded but not proven to be the live producer;
- `previous-generation-resumed` — the old copy is the live producer (new, see R4);
- `unverified` — no evidence inside the window.

The proposed `client.heartbeat(...).then(() => markHeartbeat(load_id))` is unsafe: it records a completion with no check that the issuing copy still owns the runtime. `shutdown` clears the interval (`packages/openclaw-plugin/src/connection.ts` 779–), but an in-flight request is not cancelled, and the SDK `heartbeat()` takes no abort signal (`packages/sdk/src/client.ts` 123–125).

### Why the 9 Oct wording is not enough on main

"Record only if dispatched after `T_v` and the issuing copy is still the live, unretired holder, checked against the in-memory retired flag" assumes `retired` only moves one way. It does not:

- `activateRuntime()` sets `retired = false` and `hostStopped = false` (`connection.ts` 837–840);
- `resumeRuntime()` (`connection.ts` 618–660, added by #162) sets `retired = false` and starts a heartbeat at once; the registry calls it synchronously inside the successor's release (`runtime-registry.ts` 124–).

The holder object is built inline in `claimRuntime` (`connection.ts` 588–606) and is not kept by the module; the only exported registry read is `agentRuntimeGeneration` (`runtime-registry.ts` 189), commented "Test seam". The beat itself is `connection.ts` 684: `void client.heartbeat(...).catch(() => {})`, with the first call made immediately and then on `setInterval`.

### R1 — completion rule

A heartbeat completion is recorded as evidence for `verified` only if **all** hold:

1. it was dispatched at or after `T_v`;
2. the copy's **claim counter** captured at dispatch equals the copy's current counter at completion (the counter increments in `claimRuntime` on every successful claim, in `resumeRuntime` on every un-retire, and in `activateRuntime`; a boolean cannot detect stop-then-resume, a counter can);
3. at completion the registry holder for this agent is this copy's generation.

Holder read: **promote `agentRuntimeGeneration` from test seam to a supported read** (rename or re-comment, same behaviour), and have `connection.ts` compare it with its own `generation`. Chosen over keeping the holder object in the module because the registry is the single source of truth across module copies; a copy cannot see a newer copy's state any other way.

The completion record carries `{generation, claim_counter, dispatched_at, completed_at}`, and the **load identity** (R7).

### R2 — G-7 and G-8 (restated)

The original text of G-7 and G-8 was not recovered. Re-stated from the comment's counterexample, pointed at main lines:

- **G-7 (late completion from an unloaded generation).** Copy G1 dispatches a beat (`connection.ts` 684), is stopped by the host (`shutdown`, `retired = true`, `hostStopped = true`), and the beat completes after `T_v`. Expected: not recorded; outcome `loaded` or `unverified`, never `verified`.
- **G-8 (late completion after supersession).** G1 dispatches, a newer copy G2 claims the agent (`runtime-registry.ts` 84–), G1's beat completes after `T_v`. Expected: not recorded for G1 (holder is G2, rule 3).

### R3 — G-9, claim-generation ABA (new)

G1 dispatches a beat at `T_d >= T_v`; G1 is stopped by supersession (`retired = true`); G1 is un-retired by `resumeRuntime` or `activateRuntime`; the old beat completes. `retired` is false and G1 is the holder, so a boolean check passes, but the beat belongs to an earlier holding period. Counter captured at dispatch differs from the current counter, so rule 2 fails. Expected outcome: `loaded`, never `verified`.

### R4 — G-10, previous generation resumed (new)

An update loads G2; G1 goes to standby. The host disposes G2; inside G2's release G1 resumes, un-retires and beats at once (`connection.ts` 618–660). G1 is now a live, unretired holder dispatching after `T_v`, so it satisfies rules 1–3 in full.

The defence is **load identity**: every completion record carries the identity of the code that issued it, and `verify` compares it with the artifact it just installed (the C5 binding, re-confirmed under #162, not reopened). Identity of a copy is the pair `{build sha256, generation}` as already reported by `ekho_inbox` (`build.built_sha256` / `running_sha256`); verify requires the build hash of the completing copy to equal the hash of the installed artifact. G1 carries the old hash, so G-10 yields the distinct outcome `previous-generation-resumed`, never `verified`.

### R5 — G-11, verified then disposed in the window (new)

G2's beat completes and is recorded; G2 is then disposed and G1 resumes. A recorded `verified` now describes a copy that is not producing. A completion-time check cannot see this.

Chosen: **re-read at window close**. When the verify window closes, `verify` re-reads the registry holder generation and the copy's claim counter and downgrades `verified` to `previous-generation-resumed` or `unverified` if they no longer match the recorded completion. Chosen over invalidation-on-shutdown because `shutdown` is not guaranteed to run when the host tears a copy down abruptly (process kill), whereas a window-close re-read observes the live state regardless of how the copy went away. Cost: `verified` is only as fresh as the window close, and the report says so.

### R6 — Hermes

`_heartbeat_loop` (`packages/hermes-plugin/ekho_hermes/connection.py` 193–201) uses the module-level `_heartbeat_stop` Event; `shutdown()` (394–418) sets it, joins with `timeout=5.0`, then drops the thread reference. A beat blocked in `client.heartbeat` can complete after `shutdown()` returns. Worse, a later start calls `_heartbeat_stop.clear()` (around line 311), so a straggler that wakes after a restart sees an un-set event: the same ABA as G-9.

Same rule, with a **stop token captured before the request**: each loop start gets its own token object (a fresh `threading.Event` or an incrementing integer), the loop closes over its own token instead of the module-level event, and a completion is recorded only if the token is still the live one and not set. A thread that outlives `join(timeout=5.0)` therefore cannot record.

### R7 — local record or relay view

`verify` reads the **relay's view**: the relay already stores `last_heartbeat_at` per agent (`packages/relay/src/db.ts` 3024–3063), and the relay is the only observer that cannot be fooled by a stale in-process record. So the heartbeat must carry the load identity (build hash and generation) in its payload metrics; the relay-side change that stores it is part of the implementation slice, not this document. Until that lands, `verify` has only the local record and must say `loaded`, not `verified`.

### R8 — keys, installs

The updater never creates, rotates, pins or unpins a key and refuses if the operation would write identity or credential files (operator-key rule recorded in the workspace DECISIONS ledger, 2026-10-18 13:55Z). Nothing here authorises an install, a restart or a canary on a live box.

## Implementation slicing (unchanged by this document)

- **S1** may start from current main in **new files only** (CLI package: detection, `version`, `--dry-run`). It must not edit `connection.ts`, `runtime-registry.ts`, `autoreply.ts` or Hermes `connection.py`.
- **S2** (heartbeat completion record: R1, R3–R7) edits `connection.ts`, `runtime-registry.ts`, the SDK and Hermes `connection.py`. It waits until #121 is merged or closed, #164 is built or re-scoped and the private hrj7 fix has landed.
- Everything runtime (install/restore round trip, `npm pack`, no-write checks, per-host canaries) stays unexecuted until an implementation PR and its CI.

## Not covered

First publication of a new npm package name, installs or canaries on a live box, any key or pin change. Interleavings A–C above (G-9, G-10, G-11) were derived by reading `main`, **not run**.
