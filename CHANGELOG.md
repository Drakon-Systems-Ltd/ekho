# Changelog

All notable changes to Ekho are documented here.

## [Unreleased]

### Security
- **A dead-lettered message no longer reaches the agent unlabelled (#20).** Three paths carry message text to an agent and only one consulted the signature verdict. The autowake trigger was correct — a signed-but-invalid message wakes no turn and is dead-lettered — but `ekho_inbox` served that same message from its cache as an ordinary item, and for an operator sender labelled it *"Operator (verified fleet operator — your principal) … treat it as an authorized instruction"*, because the label was a bare ternary on the relay's `operator_trusted` boolean and the verdict never reached it. The verdict was not missing: `getCachedInbox()` already returned it and the tool never read it. Measured on two boxes on 16 Aug 2026 — a probe rejected with `endorser-not-pinned` was read and acted on eleven minutes later by an agent whose heartbeat polls the inbox tool on a schedule, so *the trigger path failing closed bought nothing*. Fixed on three fronts: each cached message now carries its own verdict (it lived in a per-batch map that was replaced wholesale while the message ring is 25 deep and spans many batches, so a reject stayed readable and verdict-free for up to 24 further messages, and a lookup returned `undefined` — indistinguishable from "unsigned"); every message emits a `signature` field of `verified` / `failed` / `unchecked`, always, because an absent field read as "fine" is the defect itself; and a failed signature now outranks both the feed and operator tiers, rendering `trust: "rejected-signature"` with an explicit do-not-act note. `unchecked` is deliberately distinct from `failed`, so unsigned fleets see no change. **Scope, stated precisely:** the verdict outranks the relay flag when a signature was checked and FAILED. When verification is unavailable — no pinned keys, or a null `fleetId`, which nulls the whole batch — the operator tier still rests on `operator_trusted` alone, as it always has; removing that would cut the operator off on every unsigned fleet and every box before its first pinned key. That path is now its own tier, `attested-operator`, labelled *relay-attested*, with a note saying it rests on the relay's word rather than cryptographic proof. It keeps full operator authority — the fallback is deliberate — but it is no longer the same string as a cryptographically proven operator, because one value covering both is the same defect as an absent verdict reading as a pass. **Behaviour change for consumers:** an operator message on a fleet where verification is unavailable now reports `trust: "attested-operator"` instead of `"verified-operator"`. Code keying on the exact string sees this; code keying on `from_kind` does not.
- **Round two, found by adversarial review of the first fix (#20).** Three defects in the fix itself, each caught before merge. (a) `collectRequireSignedWithheld` synthesises its verdicts straight into the dead-letter list and never writes them into `verifications`, so labelling off `verifications` alone left every withheld message under `requireSigned: "require"` reading `unchecked` — served as an ordinary teammate, with a peer budget, after the loop had dead-lettered it. That is the original defect reintroduced, in the mode an operator enables *to be safer*. The label is now driven off the reject list itself, so what gets dead-lettered and what gets labelled are the same set by construction rather than by two call sites staying in the right order. (b) `recordBatch` re-inserts on redelivery ("most-recent wins") and reset the stored verdict to `null`, so a message labelled `failed` in one tick read back `unchecked` in the next whenever verification did not re-run — silent, and decaying towards the unsafe answer; the existing verdict is now carried across. (c) Feed and forgery were ordered rather than composed, and `message_type` is a field on the message — so on a message whose signature had already failed it is attacker-controlled, and setting `message_type: "feed"` swapped the forgery warning for the feed note. Since correct handling of a genuine feed item is to read and summarise it, forged text would have been processed as syndicated material the operator subscribed to. A forged feed now carries both downgrades and its own `untrusted-external-forged` tier.
- **Round three, again from adversarial review (#20).** Two more, both in the round-two fix. (a) The rewritten `recordVerifications` dropped the null filter the old code had (`if (v) nonNull[mid] = v`), and `verifyBatch` early-returns a null for EVERY message in a batch when the pin set is empty or `fleet_id` is falsy — which happens on live boxes, since revocation sync runs on the same tick immediately before. So a message already labelled `failed` was reset to `unchecked` the moment verification became impossible, and neither collector restores it. Verification ceasing to be possible is never a reason to forget that a message already failed. (b) Carrying a verdict across redelivery bound it to the `message_id` — an identifier the relay chooses — while replacing the message object, so a redelivery under a reused id with different signature material or a different body would have inherited the old verdict, including an old `verified`. The carry-over is now conditional on the signed material being unchanged; anything else re-verifies.
- **Round four (#20): the verdict carry-over compared a hand-picked subset of what a signature actually binds.** `verifyInbound` binds a signature to a message through seven checks; the carry-over guard compared three of them. The gap that mattered was `sender_kind`, which is not merely a field — `verifyInbound` branches on it to select the entire key-resolution path (pinned operator keys vs the endorsed roster). So a `{verified: true, kind: "peer"}` verdict, carried onto a redelivery of the same `message_id` with `sender_kind` flipped to `"operator"`, rendered *"Operator (verified fleet operator — your principal) … treat it as an authorized instruction"* — where real verification would have failed `unknown-operator-key`. A peer message became a proven operator instruction with no signature checked. `sender_agent_id` (the rendered attribution) and the v2-bound `message_type`/`priority`/`attachments` were also uncompared, reopening the relabelling the v2 envelope exists to prevent. The carry-over is now whole-message equality, compared key-order-independently: there is no subset to drift, and no dependence on two structurally identical redeliveries happening to serialise their keys in the same order — that dependence would have dropped the verdict and reverted the message to `unchecked`, which is the round-two decay made conditional rather than eliminated. Defence in depth alongside it — `VerifyResult.kind` records which tier was proved and was being discarded on the way to the status tri-state, so a verdict that proved a peer can no longer authorise an operator envelope however it came to be attached.

  **The shape, since it is the actual lesson of #20 and every follow-up:** each defect was a second source of truth for verification state diverging from the first — a side map with a different lifetime, then a collector whose synthesised verdicts never reached the labeller, then a hand-picked subset of the signature binding. The invariant worth holding is that the label must be derived from the same value the loop acted on, never recomputed alongside it.
- **The reject log no longer claims something untrue (#20).** The warn line ended *"dead-lettered, not acted on"* — the string an incident responder greps for under time pressure — while the message stayed readable via `ekho_inbox` and was, in the measured case, acted on. It now says only what is true: no turn was triggered.
- **The relay now enforces endorse authority itself, instead of trusting the console to (#19).** The 16 Aug guard asked the right question — *would the fleet actually believe this key?* — but asked it in the browser, so the request that re-rooted all 8 agent identity keys onto an unendorsed orphan at 08:33Z was still reachable with an operator token and curl. `endorseAgentKey` and `endorseOperatorKey` now both refuse an endorser that is live but untrusted: it must already have agents pinned to it, or chain to a live key. Bootstrap is unchanged — the test is *"no agent is endorsed"*, not *"no agent exists"*, so a fleet whose first agent has enrolled but never been endorsed can still root its trust. The console's copy of the rule carried the same off-by-one and is corrected to match.
- **The console now says which device holds the fleet trust root (#19).** Every device rendered the same Security screen — which is how the 08:33 re-root ran from the wrong browser. Panel ② now marks THE root key: *FLEET TRUST ROOT · held on this browser* vs *held on “{label}” — this browser cannot endorse*; the status pill no longer implies a non-root device signs for the fleet; and every blocked action (generate, endorse, re-endorse, revoked-key recovery) names the device that can act by its label instead of "another device". The two credentials are also finally told apart — the unlock field asks for *this device's signing passphrase (not your console login)*, with one line saying the signing passphrase is per-device, cannot be shared, and cannot be recovered from the other device. Also fixes a revoke-handler crash that reported "Revoke failed" after a revoke that succeeded.
- **An endorsement chain may no longer close on itself (#19).** `endorseOperatorKey` rejected `A endorses A` but not `A endorses B endorses A`, and the live relay is carrying exactly that: `2T8znI7sDIHiwaL1` records the laptop as its parent (written 08:33Z) while the laptop records the phone (written 09:52Z). Neither is rooted in anything. It cannot loop an adopting agent — adoption is a single-level check that short-circuits on an already-pinned key — but a chain with no root is a lie about where trust comes from, and nothing in the table says which of the two keys is the real one. The parent walk is bounded by a visited set rather than trusting the data to be acyclic, because at the time of writing it is not.

## [0.4.1] - 2026-08-10

This release is the fallout of a real fleet incident on 10 Aug 2026, in which eight agents spent an hour re-asserting a claim that had already been retracted, concluded their signing keys had been stolen, and froze themselves. Nothing was compromised. Two plugin bugs and two console bugs produced it between them, and all four are fixed here.

### Fixed
- **Held-back turns no longer answer stale context (#16).** When a teammate holds a conversation's floor, an inbound message is stashed and its turn runs later — up to 10 minutes later. Nothing told the woken turn it was late, and the newer messages fetched along with the floor were rendered under the standard header *"you have already seen this; do NOT re-answer it"*. So the plugin fetched exactly the context that would have corrected the agent, and then instructed it to ignore that context. Measured during the incident: 46 held-back turns on one box, 23 on another, 20 on a third, each composing a reply from a batch the thread had already moved past. A held-back turn now opens with how long it was held and the instruction to drop its reply if the tail has overtaken it, and that tail is labelled as unseen; other conversations keep the "already seen" framing. Both plugins.
- **The relay no longer overrides a signed recipient with room fan-out (#12).** `createMessage()` resolved a room-shaped `conversation_id` before it considered `recipientKind`, so a message signed `recipient: {kind: "agent"}` was fanned to every room member. The envelope signature binds the stated recipient, so every member except that one dead-lettered it as `recipient-mismatch`, and room conversations silently fragmented by each agent's verification posture. The relay now fans out ONLY for an explicit `recipient: {kind: "group"}` and rejects any other recipient kind threaded under a room's conversation id — membership or not, because delivering it 1:1 would still write the row under the room's conversation id, and room history is selected on conversation id alone. That second half closes a prompt-injection path: any enrolled agent could put text into a room's rendered history, which both plugins feed straight into every woken agent's prompt, without ever joining the room. **Behaviour change:** post to a room with `recipient: {kind: "group", id: <room id>}` — anything else under a room conversation id is now a 400. Every first-party sender already does this.

### Security
- **Revoking an operator key now actually sticks (#14).** Both plugins force-pinned every entry of the `operatorPubkey` config/env seed at load with no revocation check. The inbox poll correctly deleted revoked keys from the pin map — and the next agent wake put them straight back from config, so on any box with a configured seed, revocation did nothing. Observed live on 10 Aug 2026: minutes after the operator revoked six keys, two of them were back in the trust map on two separate boxes, and anything they signed would have verified as the operator's own instruction. Each plugin now keeps a tombstone ledger (`revokedOperatorKeys` / `revoked_operator_keys` in the identity file, `key_id` → first-seen-revoked timestamp) written whenever the relay reports a key revoked, whether or not it was pinned locally. The config seed, the trust-on-first-use bootstrap and endorsement chaining all consult it, so a tombstoned key is never re-adopted by any path; a seeded key that has been revoked is skipped with a WARNING naming the key id and telling the operator to remove it from config. Unchanged for everyone else: a seed whose keys are live behaves exactly as before.
- **Peer progress signals can no longer hold the delegation budget open forever (#11, part 1).** A `complete` is a progress signal but never a trigger type, so it spawns no turn and passes no rate gate — and it reset the conversation's peer latch. A peer could interleave unlimited `completes` and keep the budget pinned at zero, defeating the 25-wake cap entirely. Refreshes are now capped per conversation per rolling hour, and a signal whose signature *failed* verification never refreshes at all (an absent verdict still does, so unsigned fleets are unaffected). Part 2 of that issue — operator messages waiting behind a long peer turn — is deliberately still open: the only real fix is a second concurrent turn per agent, which is a larger risk than the delay and needs a decision rather than a patch.
- **The console can no longer sign endorsements with its own revoked key, or strand the fleet by revoking it (#15).** The operator's key lives in the browser and was signed with regardless of what the relay thought of it. Revoking the console's own device key was offered like any other row; afterwards the page still showed *"Re-endorse all under this device"*, every press failed for every agent, and the failure text named the agents rather than the dead key. Now: revoking the only live key is refused outright; revoking this device's own key takes a separately-worded confirmation naming what it costs; endorse buttons are disabled while the device key is revoked or unknown, with the recovery spelled out (*forget device → enrol a new key → re-endorse*); and zero live operator keys raises its own red alarm, because that state is otherwise silent — agents verify nothing and, under the default `requireSigned: "warn"`, carry on processing messages unauthenticated.
- **New operator keys now chain to the key they replace, so agents adopt them automatically (#13).** The relay has always accepted, verified and stored an endorsement at key registration, and agents have always known how to adopt a key endorsed by one they already trust — but the console never sent one. Every operator key on every fleet carried `endorsed_by_key_id: null`, so that branch had never executed, and the only ways a new operator key could reach an agent were trust-on-first-use on an empty pin set or hand-editing the trust file on each host. The console now signs the new key's endorsement with the outgoing key before replacing it, and registers the key before overwriting the browser's stored identity so a rejected registration can't strand the operator. First enrolment, and recovery after every key has been revoked, still have no live endorser by definition and still fall back to trust-on-first-use.

## [0.4.0] - 2026-08-09

### Security
This release closes the findings of the 9 Aug 2026 adversarial review (issues #5–#11), plus the follow-up findings of a second adversarial pass over the fixes themselves. None require configuration changes to keep working; two add opt-in hardening knobs.

- **Cross-fleet approval IDOR (relay).** `approveOrReject` selected the pending action by id alone, so any authenticated operator could approve or reject another fleet's pending agent actions. Now fleet-scoped with a pending-status gate. (#IDOR, fixed 9 Aug)
- **Operator-key trust now bootstraps itself — verification is no longer dormant by default (#5).** The relay has always returned the fleet's operator signing keys at enrollment; both plugins dropped them, so an agent nobody hand-configured pinned nothing, verified nothing, and silently accepted everything. Both plugins now trust-on-first-use the relay's non-revoked key set — exactly once, for a never-pinned identity, latched via `tofuAt` so an emptied pin set can never be re-seeded later. Explicit out-of-band pins (`operatorPubkey` config / env) still take precedence and skip TOFU entirely.
- **`requireSigned` mode closes the fail-open peer wake (#5).** Unsigned peer messages — and signed ones that can't be verified for lack of pinned keys — used to wake turns unconditionally. New plugin config `requireSigned` (`EKHO_REQUIRE_SIGNED`): `warn` (default, current graceful behavior), `require` (a peer wakes a turn only when signed AND verified; everything withheld is dead-lettered with reason `unsigned-require-signed` / `unverifiable-require-signed`, never silently binned), `off`. Operator messages keep the explicit relay-attested `operator_trusted` fallback in every mode. Flip fleets to `require` once every agent signs.
- **v2 signature envelopes bind message_type, priority and attachments (#9).** A compromised relay could relabel a signed message (`direct` → `alert`), change its priority, or swap its attachment ids under a still-valid signature — none were covered. Signers now emit `v: 2` canonicals covering all three; verifiers enforce the bindings for `v >= 2` and still accept v1. Compatible in both directions (verification always covered the whole canonical), so mixed-version fleets keep working during rollout.
- **Server-side envelope replay dedup (#10).** The envelope signature nonce was relayed verbatim and deduped only in each recipient's in-memory set (FIFO-500, lost on restart) against a 24h acceptance window. The relay now claims each envelope nonce per-sender at ingest (atomic, `replay_nonces`) and refuses reuse with 409; envelope nonces are retained for the full 24h window (`EKHO_ENVELOPE_NONCE_RETENTION_SECONDS`), transport nonces keep their short sweep.
- **Attachment storage is now bounded (#7).** Uploads had a 25 MiB per-file cap and nothing else — no rate limit, no aggregate quota, no GC, no delete path at all: one enrolled agent looping uploads could fill the relay's disk. New: per-fleet byte quota (`EKHO_ATTACHMENT_FLEET_QUOTA_BYTES`, default 1 GiB), upload rate limit (`EKHO_ATTACHMENT_UPLOAD_MAX_PER_WINDOW`, default 20/min, agent and operator paths), and sweep GC — messages stamp the attachments they reference; unbound uploads are removed after 6h (`EKHO_ATTACHMENT_UNBOUND_TTL_SECONDS`), referenced ones after 30 days (`EKHO_ATTACHMENT_RETENTION_SECONDS`), bytes unlinked with the rows.
- **The login throttle is proxy-aware (#8).** Behind `tailscale serve` every client shares the proxy's loopback socket address, so the per-IP failure counter collapsed into one bucket: 10 bad guesses from anyone locked every operator out fleet-wide for 15 minutes, repeatably. The throttle now unwraps exactly one configured trusted hop (`EKHO_TRUSTED_PROXY_IPS`, default loopback) and believes only the rightmost `X-Forwarded-For` entry; direct connections keep their socket address, so a spoofed header can neither evade a bucket nor poison another client's.
- **Peer message bodies can no longer forge operator-identity framing (#6).** Raw peer body text was rendered into the auto-reply prompt unescaped, so a peer could embed a line that read as the plugin's own "verified operator" framing. Bodies are now fenced with a per-turn unguessable token and indented so injected framing can't be mistaken for plugin output.
- **Follow-up hardening (second adversarial pass over the fixes).** The login throttle's account bucket — keyed on the attacker-controlled `(fleet, email)` pair — is now capped (`EKHO_LOGIN_THROTTLE_MAX_BUCKETS`, default 50k) so a garbage-credential flood can't exhaust the memory of the process serving the whole fleet; login fields are length-bounded. The require-mode dead-letter guarantee now holds even when plugin identity bootstrap fails (previously withheld peers were binned with no trace in that window). A numeric or empty envelope nonce is now normalised and claimed rather than silently skipping server-side replay dedup.

### Fixed
- **A signed message that fails verification is no longer silently binned — both plugins log the verdict reason and dead-letter the full message.** The auto-reply loop acks every delivered batch wholesale (at-most-once), so a message rejected by the signature gate has no redelivery path: it was acked and discarded with zero trace, while the sender believed it was received. That silent path is how the fleet's unendorsed-operator-key drops stayed undiagnosed for days (Aug 2026 — every patched box binned Veronica's signed messages because her key was never endorsed, and nothing anywhere said so). Now each reject logs `verification FAILED … reason=<reason>` at warning and is appended (full message + verdict + timestamp) as JSONL to a dead-letter file beside the plugin's other state — `.ekho-dead-letter.jsonl` in the OpenClaw plugin's config dir, `~/.hermes/ekho-state/dead-letter.jsonl` for Hermes — with a single size-capped rotation. Unsigned messages are unaffected: they keep the graceful relay-attested fallback and are not rejects.
- **The Hermes plugin now survives Hermes venv rebuilds losing its Python SDK — and fails loudly when it can't.** A Hermes update that rebuilds the venv silently removes the installed `ekho` SDK; the plugin then dies at load while staying "enabled" in metadata, so the agent drops off the fleet with zero journal signal (field cases: Tars 2 Aug, Vision 29 Jul–5 Aug 2026 — Vision was dark for a week).
  - The SDK-path shim now tries, in order: `EKHO_SDK_PATH`, the last source tree that successfully resolved (persisted to `~/.hermes/ekho-state/sdk-path` on every good load, including editable installs — this is what makes a venv wipe recoverable), the repo checkout the plugin itself lives in, and `~/ekho/sdks/python`. Trees inside `site-packages` are never recorded, since they die with the venv.
  - If the SDK still can't be resolved, the plugin no longer fails silently: package import logs an ERROR (Hermes' loader swallows anything quieter) and writes the remediation to stderr before raising.

### Added
- **`python -m ekho_hermes.healthcheck [--repair]`** — post-update health check for the Hermes plugin. Also runs as a plain file from the installed layout (`python ~/.hermes/plugins/ekho/healthcheck.py`), where the documented copy renames the package: standalone mode strips its own dir from `sys.path` and binds the package under its canonical name, so an install dir named `ekho` can neither break the check nor false-green the SDK test by shadowing the SDK's import name (a dedicated collision check fails it explicitly). The check prints which interpreter it verified — run it with the venv the Hermes *service* uses, not a stale sibling `.venv`. (Both traps found by Vision's rollout, 5 Aug 2026.) Verifies with evidence, not metadata: the `ekho` SDK resolves to a real package (not a bare-directory namespace phantom), the SDK surface the plugin needs imports, and `register()` wires all three tools (`ekho_send`/`ekho_open_room`/`ekho_inbox`) — captured on a stub runtime with the startup connect stubbed, so it is safe offline. `--repair` pip-installs the first discoverable SDK source tree (editable) into the invoking interpreter and re-verifies. Run it with the Hermes venv's python after every Hermes update or venv rebuild.

## [0.3.2] - 2026-08-02

### Fixed
- **The container image is now built for `linux/arm64` as well as `linux/amd64`.** Every image through 0.3.1 was amd64-only, because the build never specified a platform and inherited the runner's. Ekho is aimed at Tailscale meshes, homelabs and edge nodes — Raspberry Pis, Apple Silicon, Oracle's ARM free tier — so a large share of its intended users could not run the published image at all. Our own relay host is aarch64 and could not have run it either.
  - arm64 is cross-built under QEMU, which is slow here because the Dockerfile compiles `better-sqlite3` from source in both stages; the release job's timeout is raised accordingly. If that proves too slow or flaky, the better fix is a native ARM runner building in parallel with a merged manifest.

## [0.3.1] - 2026-08-02

### Added
- **The OpenClaw plugin now has a release path.** It is published to npm as **`@drakon-systems/ekho-openclaw-plugin`** (renamed from the unpublishable `@ekho/openclaw-plugin`) by the release workflow, in lockstep with the relay. Install or upgrade with `npm install -g @drakon-systems/ekho-openclaw-plugin`.
  - Previously the plugin was never published anywhere, so it was deployed by copying `dist/` onto each machine and patching it in place. Every agent in a four-machine fleet reported version `0.2.1` while running `0.3.0` code — a version number that actively misleads is worse than none, and it makes "what is actually deployed?" unanswerable.
  - The publish step is deliberately **not** `continue-on-error`: a release that cannot ship the plugin fails loudly and gets re-cut, rather than going green having shipped nothing.
  - A test now fails the build if `package.json` and `openclaw.plugin.json` versions drift apart, or if the package is made unpublishable again.

### Fixed
- **Turn-health no longer reads "unknown" while auto-reply turns are running.** An auto-reply turn is a spawned child process, so the host's `model_call_ended` hook fires inside that child and the parent gateway — which owns the heartbeat and the fleet-health signal — never sees it. The parent now folds the child's exit status in as the turn outcome, matching the Hermes plugin's behaviour.
  - Guarded against double-counting: a timed-out turn fires twice (the timeout `SIGTERM`s the child, then the child emits `exit`), which would have counted one failed turn as two and skewed the ratio. The guard is unit-tested directly rather than left inline in the spawn path — the wiring is what breaks, not the arithmetic.

## [0.3.0] - 2026-07-26

A security release. Upgrading is recommended for every deployment, and required
for any relay reachable beyond a private network.

### Security
- **Baseline HTTP security headers on every response.** The relay previously emitted none, which mattered most for the operator console: a browser app holding a bearer session token, with no CSP to stop an injected script reading it and no frame-ancestors to stop clickjacking. Applied in an `onSend` hook so static assets, error replies and framework 404s are covered too.
  - Two profiles: the console gets `default-src 'self'` plus the Google Fonts origins it genuinely loads, with **`script-src 'self'` and no `'unsafe-inline'`**; every other response gets `default-src 'none'`.
  - Also sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (device APIs off), `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` and `X-Permitted-Cross-Domain-Policies`.
  - `Strict-Transport-Security` and `upgrade-insecure-requests` are emitted **only for requests that actually arrived over TLS** (direct, or via `X-Forwarded-Proto` from a terminating proxy) — sending either unconditionally would make a plain-HTTP deployment unreachable by pinning or upgrading requests it cannot serve.
  - A route that already sets a stricter CSP keeps it: the attachment download path's `default-src 'none'; sandbox` is never loosened.
- **Brute-force throttle on `/v1/operator/login`.** The endpoint had no attempt limit — the existing rate limiter only covers agent message sends, so operator passwords could be guessed as fast as the KDF would answer. Failures are now counted on a rolling window per **account** and per **client IP** (either counter alone is evadable: one stops a distributed grind on a single operator, the other stops one host spraying many accounts). The check runs *before* password verification, so a guess flood cannot double as a CPU-exhaustion lever. Counters decay rather than latch and are cleared on success, so an attacker cannot lock a legitimate operator out. Blocked attempts return `429` with `Retry-After`. Tunable with `EKHO_LOGIN_MAX_FAILURES` (default `10`) and `EKHO_LOGIN_WINDOW_SECONDS` (default `900`).
- **Operator session tokens now expire.** Tokens were `operatorId.fleetId.HMAC(...)` with no issue time and no expiry: once minted they were valid forever, and since the console stores the token in the browser so it survives reloads, a single theft granted permanent control-plane access with no revocation short of rotating `EKHO_OPERATOR_SESSION_SECRET` (which invalidates every operator at once). Tokens now carry a signed issued-at and are rejected beyond `EKHO_OPERATOR_SESSION_TTL_SECONDS` (default `86400`, 24h). The timestamp is inside the HMAC input, so a holder cannot extend their own session; a far-future stamp is refused, with a small tolerance for clock skew. The login response gains `expires_in`.

- **`npm run setup` no longer creates the operator account with a default password.** The wizard fell back to a hardcoded `changeme123` whenever `EKHO_BOOTSTRAP_PASSWORD` was unset, and never printed or flagged it — so anyone following the quickstart ended up with a control-plane account whose password is published in this repo, with nothing on screen to suggest a problem. Setup now generates a high-entropy password, displays it exactly once with a warning that only its scrypt hash is stored, and prints the sign-in address. A supplied password that is well known (`changeme123`, `password`, …) or shorter than 12 characters is called out rather than accepted silently.

### Breaking
- **Legacy operator session tokens are rejected — every operator signs in once more after upgrading.** The old 3-part token format is precisely the immortal, unrevocable credential the change above removes, so it is refused rather than grandfathered. The console already handles this: a `401` clears the stored session and prompts to log in again. No action needed beyond re-authenticating.

### Changed
- **Peer auto-reply is now ON by default.** Bounded agent-to-agent delegation graduated from opt-in to the default, so teammates can wake an agent (still latched per conversation by `peer_turn_budget`, with the per-peer rate gate as a backstop). Opt out per agent from the operator console, or with `EKHO_PEER_AUTOREPLY=0` (Hermes) / `"peerAutoreply": false` (OpenClaw).
  - Relay: `agents.peer_autoreply` now defaults to `1`; migration `015_peer_autoreply_default_on.sql` flips the existing live fleet on; newly enrolled agents land ON explicitly (so they're ON on migrated DBs too).
  - The operator console remains the live source of truth and overrides the bootstrap default per agent.

### Added
- **Budget-aware peer turns.** When a teammate wakes an agent, the one-shot prompt now tells it how many peer wakes remain in that conversation (`peer turn N of M — K wake(s) left …`), so it front-loads the work before the latch auto-pauses. An operator message in the batch re-energises the latch, and the line says so.
- `ekho_inbox` surfaces the remaining peer budget: top-level `peer_autoreply` + `peer_turn_budget`, and per peer message a `peer_turns_used` / `peer_remaining` for that conversation (additive, backward-compatible).
- **Peer budget — graceful exhaustion.** The peer-turn budget now caps *chatter* without killing *real work*: a handoff or follow-up can no longer silently stall once the budget is spent.
  - **Progress signals refresh the budget.** Scanning the full inbound batch before the latch gate, a peer `handoff`/`claim` both wakes the agent and re-energises that conversation's budget, and a `complete` refreshes it without waking — so a handoff always lands on a fresh budget instead of stalling unread. Plain `direct`/`broadcast` keep consuming the budget.
  - **Graceful last turn.** On the final auto-wake before the latch pauses, the one-shot prompt tells the agent to finish, hand off cleanly, or post one clear status message and pause for the operator — never to stop mid-task without a word (replacing the normal countdown line on that turn).
  - **Stall escalation (no silent death).** When the budget is spent and a real peer message is withheld, the agent raises one operator-visible `conversation.stalled` event per close, via a new agent-authenticated `POST /v1/notices` (recorded idempotently per fleet/agent/conversation until the operator re-engages, and re-armed by operator engagement). It surfaces in `/v1/operator/events`, which the console already polls. New SDK methods `raiseNotice` (TS) / `raise_notice` (Python), called best-effort so a relay failure never breaks the poll loop.

## [0.2.1] - 2026-06-02

### Changed
- Published the agent SDK to npm as **`@drakon-systems/ekho-sdk`** (renamed from the unpublished `@ekho/sdk`). Install with `npm install @drakon-systems/ekho-sdk`; imports change from `@ekho/sdk` to `@drakon-systems/ekho-sdk`.

## [0.2.0] - 2026-06-02

Deploy-readiness and production hardening.

### Deployment & Release
- Release workflow now builds and publishes the relay container image to GHCR (`ghcr.io/drakon-systems-ltd/ekho`)
- New [Operations Guide](docs/operations.md): deployment, secrets, TLS, backups, upgrades, troubleshooting

### Security & Runtime Hardening
- Relay refuses to start with an unset or default operator session secret (`EKHO_DEV_INSECURE=1` opt-out for local dev); `npm run setup` now generates and persists a strong secret
- `docker compose` requires `EKHO_OPERATOR_SESSION_SECRET` (no insecure default)
- Optional native TLS via `EKHO_TLS_CERT_PATH` / `EKHO_TLS_KEY_PATH`
- Graceful shutdown on `SIGTERM`/`SIGINT`
- `/readyz` readiness probe with database health check (Helm readiness probe now targets it)
- Replay-nonce table pruned by the background sweep to prevent unbounded growth

### Tests
- Expanded suite to 67 tests: agent auth/signing, retry/dead-letter/expiry sweep, TLS options, and startup hardening

## [0.1.0] - 2026-04-04

First release. Core relay, SDK, operator console, and ecosystem integrations.

### Core Relay
- Fastify server with SQLite (WAL mode) storage
- Agent enrollment via one-time tokens
- HMAC-SHA256 signed request authentication with replay protection
- Store-and-forward message delivery with 8 message types
- Delivery acknowledgements with delivery tracking
- Heartbeat liveness reporting
- Operator approval workflows for high-risk actions

### Hardened Delivery
- Exponential backoff retry (1m, 5m, 15m, 1h, 2h) with max 5 retries
- Dead-letter archive for exhausted messages
- Expired message cleanup via background sweep job
- Per-agent rate limiting (configurable, default 30 msg/min)
- Rate limit violation tracking and operator alerting

### Policy Engine
- Deny-first message-level policies
- Conditions: sender, recipient, message type, priority
- Fleet-wide and agent-scoped policies
- Full CRUD via operator API

### Quarantine Automation
- Auto-quarantine on missed heartbeats (configurable threshold)
- Auto-quarantine on repeated rate limit violations
- Auto-restore on heartbeat resumption (heartbeat-triggered only)
- Operator-initiated quarantine preserved across heartbeats

### Operator Console
- Dark premium React dashboard with glassmorphism design
- Fleet overview with 7 KPI cards
- Agent list with search, filter, sort, pagination
- Agent detail with controls, messages, rate limit violations
- Approval queue with approve/reject workflow
- Policy management with create/edit/delete modals
- Dead letter viewer with expand/collapse detail
- Event audit log with conversation tracing
- Modal dialog system (no browser alerts)
- Skeleton loading states and error boundary
- Auto-refresh polling (5s interval)

### SDK (`@ekho/sdk`)
- Zero-dependency agent client (Node.js crypto only)
- Full API coverage: send, inbox, ack, heartbeat, actions
- High-level adapter with auto-polling and heartbeat loops
- TypeScript declarations included

### Ecosystem Integrations
- OpenClaw plugin for agent runtime integration
- ShieldCortex bridge with Iron Dome security scanning
- Extension hook system for custom message processing

### Shipping Infrastructure
- Monorepo with npm workspaces (4 packages)
- GitHub Actions CI (typecheck + test + build)
- Multi-stage Dockerfile with docker-compose
- OpenAPI 3.1.0 specification (27 operations, 62 schemas)
- RS256 offline license system for Pro tier
- Setup wizard with colored output and doctor checks
- MIT License

### Licensing (Open-Core)
- OSS: 1 fleet, basic policies, full relay features
- Pro: Multi-fleet, advanced policies, analytics dashboard
- Offline RS256 JWT license verification
