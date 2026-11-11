# `ekho update` (#118) — design, with the C4 heartbeat-completion rule

Status: design only. No implementation, install or canary is authorised by this document. Written fresh on 2026-11-11 from issue #118 and its design-review status comment (6071896841), because the round-3 design text was not recoverable by the ruling's deadline (2026-11-11T13:35Z). Base: `main` `5303fda`. Source line numbers below are from that commit, re-checked at `2a9a011` (`connection.ts` and `runtime-registry.ts` are unchanged between the two; `db.ts` references are given at `2a9a011`).

Revised 2026-11-11 after the exact-head panel on `6015753` (three FIX verdicts). Changed: R1, R2, R5, R6, R7, the `verified` definition and the slicing. Added: I1, the relay verify session, G-12, G-13, G-14. A second panel on `8cb9c75` (two APPROVE, one FIX) found the R5 proof wrongly said the close beat itself completed live when beats overlap; R5 now rests on the acknowledged beat, and G-13c is added. The earlier "re-read the in-process registry at window close" is withdrawn: `verify` is a separate process and cannot read it.

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

`verify` runs as its own process (the CLI). It cannot read a gateway's in-process state, so every fact it relies on must be something it can query. It opens a window at time `T_v` (after the install and restart request), asks for the window to be closed at `T_c`, and reports one of:

- `verified` — the artifact just installed was the **live holder** for this agent at an instant after `T_c`, proven by the relay verify session (R7). The report carries that instant as `live_between`;
- `loaded` — the new code is loaded and beating but not proven to be the live holder after `T_c`;
- `previous-generation-resumed` — the most recent producer the relay saw is not the installed artifact (R4);
- `unverified` — no evidence inside the window.

`verified` is a statement about an instant, not about the future. R5 states the bound exactly.

The proposed `client.heartbeat(...).then(() => markHeartbeat(load_id))` is unsafe: it records a completion with no check that the issuing copy still owns the runtime. `shutdown` clears the interval (`packages/openclaw-plugin/src/connection.ts` 778–), but an in-flight request is not cancelled, and the SDK `heartbeat()` takes no abort signal (`packages/sdk/src/client.ts` 123–125).

### Why the 9 Oct wording is not enough on main

"Record only if dispatched after `T_v` and the issuing copy is still the live, unretired holder, checked against the in-memory retired flag" assumes `retired` only moves one way. It does not:

- `activateRuntime()` sets `retired = false` and `hostStopped = false` (`connection.ts` 837–840);
- `resumeRuntime()` (`connection.ts` 618–660, added by #162) sets `retired = false` and starts a heartbeat at once; the registry calls it synchronously inside the successor's release (`runtime-registry.ts` 124–).

The holder object is built inline in `claimRuntime` (`connection.ts` 588–606) and is not kept by the module; the only exported registry read is `agentRuntimeGeneration` (`runtime-registry.ts` 189), commented "Test seam". The beat itself is `connection.ts` 684: `void client.heartbeat(...).catch(() => {})`, with the first call made immediately and then on `setInterval`.

The flag is still necessary. The first revision of this document replaced it with a counter and a registry read and so dropped it; that reopened G-7 (see G-12). R1 below needs both: the flags say whether the copy is live **now**, the epoch says whether it has been live **without interruption**.

### R1 — liveness predicate, holding epoch, dispatch and completion checks

**Liveness predicate.** `L(agent)` is true for a module copy at an instant only if **all** hold:

1. `retired` is false;
2. `hostStopped` is false;
3. `claimedAgentId === agent`;
4. the registry holder for `agent` is this copy's generation.

For 4, **promote `agentRuntimeGeneration` from test seam to a supported read** (rename or re-comment, same behaviour) and have `connection.ts` compare it with its own `generation`. The registry is the single source of truth across module copies; a copy cannot see a newer copy's claim any other way. Conditions 1–3 are the copy's own state and do not depend on the registry being right.

**Holding epoch.** A per-copy integer that increments on **every** change to an input of `L`:

- in `claimRuntime`, on a successful claim and on a refused claim (which sets `retired`);
- in `resumeRuntime`, on every un-retire, and again if the claim then fails and it re-retires;
- in `activateRuntime`;
- in `shutdown`, **on every call and for every reason** (host stop and supersession alike), as its first statement.

So the epoch changes when a copy stops, not only when it starts again. A beat that is in flight across a stop sees a different epoch at completion whether or not the copy has been resumed since. A boolean cannot detect stop-then-resume; a counter that only moves on claim cannot detect stop.

**Dispatch check.** A beat that carries load identity (R7) is dispatched only if `L` holds. It captures the epoch `e_d` and a per-copy sequence number `seq`, assigned at dispatch and strictly increasing in dispatch order.

**Completion check.** When the response arrives, the beat is *completed live* only if `L` holds **and** the current epoch equals `e_d`. Only then does the copy raise `acked_seq` to `seq` (`acked_seq` is the highest sequence number that completed live; it never goes down). A beat that fails the check is dropped: it is never written to the copy's local completion record (`{generation, epoch, seq, dispatched_at, completed_at}`, kept for diagnostics and for the `loaded` fallback in R7) and never acknowledged in a later beat.

`acked_seq` is how a completion-time fact, which only the copy can observe, reaches the relay: it rides on the **next** beat, which is itself dispatched only if `L` still holds.

**I1 — a stop releases the slot.** On main, `shutdown` removes this copy from the registry in the same synchronous call that sets `retired` (`connection.ts` 779 and 800–803, `releaseAgentRuntime` at `runtime-registry.ts` 124–131). S2 keeps this as a tested invariant: after `shutdown` returns, the registry does not name this generation as holder. R1 does not rest on I1 alone. Conditions 1–2 of `L` and the epoch each reject a stopped copy even if a later change left the registry still naming it (G-12).

**Stops that do not run `shutdown`.** Two cases. A process kill runs no code: nothing completes, and nothing is dispatched afterwards, so the copy can never send the confirming beat R5 requires (G-14). A host that drops a copy without calling `shutdown` while the process lives leaves that copy's timer running: it is still a producer, `L` is true and correctly so, until a newer copy's claim stops it through the registry (G-8).

### R2 — G-7, G-8 (restated) and G-12

The original text of G-7 and G-8 was not recovered. Re-stated from the comment's counterexample, pointed at main lines:

- **G-7 (late completion from a stopped holder).** Copy G1 dispatches a beat (`connection.ts` 684), is stopped by the host (`shutdown`, `retired = true`, `hostStopped = true`), and the beat completes after `T_v`. Rejected three ways: `L` conditions 1 and 2 fail, the epoch moved in `shutdown`, and by I1 the registry no longer names G1. Expected: not completed live, never acknowledged, so never `verified`. The reported outcome follows the R7 precedence.
- **G-8 (late completion after supersession).** G1 dispatches, a newer copy G2 claims the agent (`runtime-registry.ts` 84–), G1's beat completes after `T_v`. Expected: not completed live for G1 (`retired`, epoch moved, holder is G2).
- **G-12 (stopped holder, registry still names it).** As G-7, but with I1 deliberately broken in a test double so the registry still returns G1's generation, and with no later registry change before the window closes. Expected: still not completed live, because `L` 1–2 and the epoch do not consult the registry. This is the schedule the first revision accepted.

### R3 — G-9, holding-period ABA

G1 dispatches a beat; G1 is stopped by supersession (`retired = true`); G1 is un-retired by `resumeRuntime` or `activateRuntime`; the old beat completes. `L` is true again, so the flags alone pass, but the beat belongs to an earlier holding period. The epoch captured at dispatch differs from the current epoch (it moved at the stop and again at the resume), so the completion check fails. Expected: that beat is never acknowledged. G1's later beats carry the new epoch and start a new run at the relay (R7).

### R4 — G-10, previous generation resumed

An update loads G2; G1 goes to standby. The host disposes G2; inside G2's release G1 resumes, un-retires and beats at once (`connection.ts` 618–660). G1 is now a live holder and satisfies R1 in full.

The defence is **load identity**: `{build_sha256, load_id, generation, epoch}`, where `build_sha256` is the hash already reported by `ekho_inbox` (`build.built_sha256` / `running_sha256`) and `load_id` is a random value drawn once per module evaluation, so two processes that both number their first copy generation 1 are still distinct. `verify` requires the build hash of the confirming copy to equal the hash of the installed artifact (the C5 binding, re-confirmed under #162, not reopened). G1 carries the old hash, or no load identity at all if it predates this change. Either way G-10 yields `previous-generation-resumed`, never `verified`.

### R5 — window close: G-11, G-13, G-14

A completion-time check cannot see what happens after the completion. The first revision answered this with a re-read of the in-process registry at window close. That read is not available to `verify`, and the relay's `last_heartbeat_at` is a record of a past completion, not an observation of who holds the agent now. So the close is an **active challenge answered through the relay**, not a read of stored state.

At `T_c`, `verify` asks the relay to close the session. The relay issues a fresh close nonce `N_c`. `verified` requires, in the relay's own receive order:

1. a **close beat** `B_close`: carries `N_c`, load identity `I`, sequence `s`;
2. a **confirming beat** `B_conf`: same identity `I` (same epoch included), with `acked_seq = a` and `a >= s`;
3. no beat from any other identity, and no beat without identity, for this agent between them or after them up to the final read (the run rule, R7);
4. `I.build_sha256` equals the installed artifact's hash.

What this proves. Beats may overlap (main does not wait for one response before the next interval fires), so `a` is not always `s`. The proof is about beat `a`, whichever it is:

- `N_c` did not exist before `T_c`, so `B_close` was dispatched after `T_c`. `seq` follows dispatch order and `a >= s`, so beat `a` was dispatched no earlier than `B_close`, hence also after `T_c`, with `L` true at its dispatch.
- `acked_seq = a` says beat `a` completed live: `L` true and the epoch unchanged since its dispatch.
- `B_conf` carries the same epoch as `B_close`, and the epoch never repeats, so beat `a` belongs to that same holding period.

So copy `I` was the live holder, without interruption, from the dispatch of beat `a` to its completion, and that whole interval is after `T_c`. The completion of `a` lies between the relay's receipt of `B_close` and its receipt of `B_conf` (the relay answered `a` before the copy could acknowledge it, and by the run rule it accepted nothing from `I` with a sequence at or above `s` before `B_close`). `verify` therefore reports `live_between = [received_at(B_close), received_at(B_conf)]` in relay time and claims one thing: **at some instant inside `live_between`, the installed copy was the live holder.** No client clock is trusted.

It does not claim that `B_close` itself completed live. When `a > s`, `B_close` may complete after the copy has stopped (G-13c); the claim above is still true, because it rests on beat `a`.

**The bound.** `verified` says nothing after `live_between`. A copy disposed after beat `a` completed is, correctly, verified as of that instant. `verify` polls and does the final read as soon as the session is confirmed, so the gap between the proof and the report is one poll. No schedule in which the installed copy stopped holding the agent before `T_c`, or after `T_c` but before any beat it dispatched after `T_c` had completed live, can produce `verified`.

- **G-11 (recorded, then disposed in the window).** G2's beats are recorded in the session; G2 is disposed and G1 resumes before `T_c`. G2 dispatches nothing more (`L` false), so nothing from G2 can carry `N_c`. G1's beats arrive with a different identity or none. Expected: `previous-generation-resumed`.
- **G-13 (pending resumed heartbeat).** As G-11, but G1's immediate resume beat is still in flight when the window closes, so the relay's stored state still shows only G2. Stored state is not what is asked: `N_c` can only be learned from the response to a beat dispatched after `T_c`, and G2 dispatches none. If G1's beat lands before the final read the run breaks: `previous-generation-resumed`. If it has not landed when the close wait `W_c` expires there is still no close beat: `loaded`. Never `verified`.
- **G-13b (disposed between close beat and its completion).** G2 dispatches `B_close` with no later beat completed, is disposed, `B_close` completes. `shutdown` moved the epoch and set `retired`, so the completion check fails, `acked_seq` does not advance and G2 never dispatches again. No `B_conf`. Expected: never `verified`; `loaded` while G2's beats are the latest the relay saw, `previous-generation-resumed` once another copy's beat lands.
- **G-13c (two beats in flight, close beat completes after the stop).** After `T_c`, G2 has `B_close` (`s`) and a later beat (`s+1`) in flight in one epoch. `s+1` completes live, G2 dispatches `B_conf` with `acked_seq = s+1`, then G2 is disposed, then `B_close`'s response arrives and fails the completion check. Expected: `verified` is allowed and true. G2 was the live holder from the dispatch of `s+1` to its completion, after `T_c` and inside `live_between`; the stop came later, which the bound already excludes from the claim. The variant where G2 is disposed **before** `s+1` completes yields no acknowledgement at all: never `verified`.
- **G-14 (process kill).** The process dies at any point before `B_conf` is dispatched. No code runs, so no confirming beat exists. Expected: `loaded` if G2's earlier beats are the latest the relay saw, `unverified` if there were none.

Close wait: `W_c` defaults to three heartbeat intervals plus 10 s. To keep it short, a copy may dispatch one extra beat at once when a response first delivers a nonce it has not yet echoed, and one when a close beat completes live. Both go through the dispatch check; neither changes the interval timer.

### R6 — Hermes

`_heartbeat_loop` (`packages/hermes-plugin/ekho_hermes/connection.py` 193–201) uses the module-level `_heartbeat_stop` Event; `shutdown()` (394–418) sets it, joins with `timeout=5.0`, then drops the thread reference. A beat blocked in `client.heartbeat` can complete after `shutdown()` returns. Worse, a later start calls `_heartbeat_stop.clear()` (around line 311), so a straggler that wakes after a restart sees an un-set event: the same ABA as G-9.

Same rule, with a **stop token captured before the request**: each loop start gets its own token (a fresh `threading.Event` plus an incrementing serial), and the loop closes over its own token instead of the module-level event. For Hermes, `L` is "this loop's token is the module's current token and is not set", and the epoch is the token serial; `shutdown()` sets the token before it joins. The dispatch and completion checks of R1 apply unchanged, so a thread that outlives `join(timeout=5.0)` cannot complete live and cannot acknowledge.

Hermes sends the same load identity and answers the same relay session (R5, R7). It has no in-process standby, so G-10 and G-11 arise for Hermes only as a second process using the same credentials; the relay's run rule treats that exactly as it treats a resumed generation.

### R7 — the relay verify session (what `verify` queries)

`verify` reads the **relay's view**, because the relay is the one observer every producer for an agent must talk to, and the one place with a single total order of their beats. Today it stores only `metrics_json` and `received_at` per heartbeat (`packages/relay/src/db.ts`, `insertHeartbeat` 2652– and `getFleetHealth` 3017–3070), which is not enough: it holds no holder identity and nothing that can be asked at close time. The implementation slice adds the following. Names are indicative.

**Heartbeat request**, optional field `load`: `{build_sha256, load_id, generation, epoch, seq, acked_seq, session?, close?}`. It is a top-level field, not a key inside `metrics`, so `heartbeatSchema` (`packages/relay/src/types.ts` 46–50) must accept it. `session` and `close` echo nonces the copy learned from the relay.

**Heartbeat response**, optional field `verify`: `{session: N, close?: N_c}`, present while a session is open for the agent.

**Session state**, at most one open session per agent, updated inside the same transaction that stores the heartbeat, so its order is the relay's commit order:

- `run`: the current unbroken sequence of beats that echo `N` with one identical identity `{build_sha256, load_id, generation, epoch}` and increasing `seq`. A beat for this agent with a different identity, with no `load`, or without `N` ends the run and is recorded as a **break** (time, and identity if any). A beat with the run's identity but a `seq` not above the last one is ignored.
- `close_beat`: the first beat in the current run that echoes `N_c`. Cleared when the run breaks.
- `confirmed_at`: receive time of the first beat in the current run, received after `close_beat`, with `acked_seq >= close_beat.seq`. Cleared when the run breaks. The relay does not need `acked_seq` to equal `close_beat.seq`: any beat of the same run and epoch at or above it was dispatched after `T_c` (R5).

A stale beat from a stopped copy therefore cannot be mistaken for the live one, and cannot permanently block a correct load either: a stopped copy has at most one request in flight, the installed copy keeps echoing both nonces, and the next two of its beats rebuild the run, the close beat and the confirmation.

**Queries**, authenticated with the agent credential already on the box (read, never written; R8):

- open: returns the session id; replaces any earlier open session for the agent;
- close: issues `N_c` and records `T_c`;
- read: returns `run`, `close_beat`, `confirmed_at`, the breaks and the latest beat's identity. The first read after confirmation, or after `W_c`, is final and freezes the session. Sessions that are never read expire.

**Outcome at the final read**, in this precedence:

1. `verified` — `confirmed_at` is set, the run is intact, and the run's `build_sha256` equals the installed hash;
2. `previous-generation-resumed` — the latest beat the relay received for the agent since `T_v` is not from the installed hash (another hash, or no load identity). A single stale beat from a stopped copy can land here if it is the last thing received before the final read; the report names the breaking identity, and `verify` can be run again, since it writes nothing;
3. `loaded` — the latest beat is from an installed-hash run, not confirmed;
4. `unverified` — no beat since `T_v`.

A relay without verify sessions answers the open with 404. Then `verify` has only local evidence and must say `loaded` at most, never `verified`. The same holds for a plugin that never echoes.

Load identity is self-reported by an authenticated agent. `verify` is an operational check that an update took effect, not an attestation of the code.

### R8 — keys, installs

The updater never creates, rotates, pins or unpins a key and refuses if the operation would write identity or credential files (operator-key rule recorded in the workspace DECISIONS ledger, 2026-10-18 13:55Z). `verify` reads the agent credential to query the relay and writes nothing. Nothing here authorises an install, a restart or a canary on a live box.

### Acceptance schedules (S2 must carry a test for each)

| Schedule | Stops the false `verified` | Expected |
| --- | --- | --- |
| G-7 stopped holder, late completion | `L` 1–2, epoch, I1 | never acknowledged; not `verified` |
| G-8 superseded, late completion | `L` 1 and 4, epoch | never acknowledged; not `verified` |
| G-9 stop then resume, old beat completes | epoch | old beat never acknowledged |
| G-10 previous generation resumed | load identity hash | `previous-generation-resumed` |
| G-11 recorded, then disposed before `T_c` | close nonce, run rule | `previous-generation-resumed` |
| G-12 stopped holder, registry still names it | `L` 1–2, epoch | never acknowledged; not `verified` |
| G-13 resumed copy's beat pending at close | close nonce needs a post-`T_c` dispatch | `loaded` or `previous-generation-resumed` |
| G-13b disposed between close beat and completion | completion check, no `B_conf` | `loaded`, then `previous-generation-resumed` |
| G-13c two beats in flight, close beat completes after the stop | proof rests on the acknowledged beat `a >= s`, not on `B_close` | `verified`, true for an instant in `live_between`; not `verified` if stopped before `a` completes |
| G-14 process kill | no `B_conf` | `loaded` / `unverified` |
| correct load, one stale foreign beat in the window | run rebuilds | `verified` |
| correct load, clean | — | `verified` |

In-process schedules run under fake timers with a controllable heartbeat promise. Session schedules run against the relay's state machine directly, feeding beats in a chosen receive order.

## Implementation slicing

- **S1** may start from current main in **new files only** (CLI package: detection, `version`, `--dry-run`). It must not edit `connection.ts`, `runtime-registry.ts`, `autoreply.ts` or Hermes `connection.py`.
- **S2a** (relay verify session, R7): heartbeat schema, session table and its migration, the three queries, the outcome rule. Relay only.
- **S2b** (R1, R3–R6): liveness predicate, holding epoch, dispatch and completion checks, load identity and nonce echo in `connection.ts`, `runtime-registry.ts`, the SDK and Hermes `connection.py`.
- S2a and S2b wait until #121 is merged or closed, #164 is built or re-scoped and the private hrj7 fix has landed. Until both ship, `verify` reports `loaded` at most.
- Everything runtime (install/restore round trip, `npm pack`, no-write checks, per-host canaries) stays unexecuted until an implementation PR and its CI.

## Not covered

First publication of a new npm package name, installs or canaries on a live box, any key or pin change. The schedules above (G-7 to G-14, with G-13b and G-13c) were derived by reading `main`, **not run**. The verify session is specified here and does not exist in the relay.
