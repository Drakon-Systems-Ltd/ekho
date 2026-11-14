# @ekho/shieldcortex-bridge

A relay extension that sends each agent-submitted message that has passed the relay's own sender checks to a ShieldCortex MCP server for an Iron Dome scan and action check before the relay accepts it. It lives in this workspace (`packages/shieldcortex-bridge`) and is not published to npm.

## Enabling it

The relay loads the bridge at start-up when `EKHO_SHIELDCORTEX_PATH` is set (`packages/relay/src/server.ts`): it imports this package, registers the extension and logs `shieldcortex bridge loaded`. If the import fails, the relay logs `failed to load shieldcortex bridge` and keeps running without it.

The relay then runs the bridge's **self-test** before it starts listening: the bridge starts ShieldCortex, completes the MCP handshake and asks the server for its tool list, which must include `iron_dome_scan` and `iron_dome_check`. Success is logged as `shieldcortex bridge self-test passed` with the advertised tool names. Failure (no answer within the 10-second request timeout, a handshake error, a missing tool) is logged at error level as `shieldcortex bridge self-test failed: ...`; the relay still starts, and the hook then behaves as described under "When ShieldCortex cannot answer" below: under `strict` every message is rejected until the server answers, under `balanced` and `permissive` the scan and action check are skipped. The self-test does not change that behaviour; it reports it at start-up instead of one message at a time.

| Variable | Default | Effect |
|---|---|---|
| `EKHO_SHIELDCORTEX_PATH` | unset | Path to the ShieldCortex MCP server's Node entry script. The bridge starts it as `node <path>` (`src/mcp-client.ts`), so the value must be a JavaScript file Node can run, not a compiled executable or a shell wrapper. Unset leaves the bridge off. |
| `EKHO_SHIELDCORTEX_PROFILE` | `balanced` | Defence profile: `strict`, `balanced` or `permissive`. `strict` rejects on a high-risk scan verdict and whenever the scan or the action check cannot produce a verdict; `balanced` and `permissive` log those cases and continue (see below). |

## What it does

The bridge registers an `onBeforeMessage` hook. The relay's message gate (`packages/relay/src/message-gate.ts`) runs it for every `POST /v1/messages` and every A2A `message/send`, after the sender's status, rate limit and policies have passed; a message refused by one of those checks never reaches the bridge. For a message that does, the hook runs the steps below in order and stops at the first step that rejects it:

1. **Scan the message body** with the `iron_dome_scan` tool (argument `text` = the JSON-encoded body). The bridge reads the risk level from the server's report, which is the Markdown the ShieldCortex server writes (`**Risk Level:** CRITICAL`, `**Summary:** ...`); a JSON object with `riskLevel` and `summary` is accepted too. If the risk level is `HIGH` or `CRITICAL`, the `strict` profile rejects the message with `threat detected: <summary>`, and the action check and the memory record below do not run; `balanced` and `permissive` log a warning and continue to the next step. If no risk level can be read (see "When ShieldCortex cannot answer"), `strict` rejects the message with `scan unavailable: <reason>`; the other profiles log and continue.
2. **Check the action** with the `iron_dome_check` tool (action `send_message:<message_type>`, source = `{ type: "agent", identifier: <sending agent id> }`). The decision is read from the server's Markdown report (`**Action Gate:** blocked — <reason>`, or `**Result:** BLOCKED by gateway`); a JSON object with `decision` and `reason` is accepted too, and a server whose Iron Dome is not active counts as `approved`. A `blocked` or `requires_approval` decision rejects the message in every profile (`Iron Dome blocked: <reason>` / `Iron Dome requires approval: <reason>`), and the memory record below does not run. If no decision can be read, `strict` rejects the message with `action gate unavailable: <reason>`; the other profiles log and continue.
3. **Record the message** with the `remember` tool, only if neither of the bridge's own steps above rejected it: a title naming sender, recipient and message type, the first 2000 characters of the body, category `pattern`, tags `ekho`, `agent-communication` and the message type (as an array), and the same source object as the action check. This call is fire-and-forget; its result never affects delivery. A message rejected by the bridge's scan or action check leaves no memory record.

This is bridge-local behaviour, not a guarantee about the relay as a whole. The relay's message gate runs every registered extension in turn, in registration order (`packages/relay/src/message-gate.ts`, `packages/relay/src/license.ts`), and the bridge starts the `remember` call before its hook returns. If an extension registered after the bridge then rejects the message, the relay still refuses it with HTTP 403, but the memory record may already have been written.

A message rejected by the bridge itself (its scan or action check) is refused by the relay with HTTP 403 and `blocked by extension shieldcortex-bridge: <reason>`; on the A2A path a bridge-rejected message gets a JSON-RPC error with that same message and `data.extension` set to `shieldcortex-bridge`. Other rejections are reported differently: an extension registered after the bridge that rejects the message is named in the denial instead (`blocked by extension <name>: <reason>`), and a message refused by the sender's status, rate limit or policies before the bridge runs gets that check's own response (for example HTTP 429 `rate limit exceeded`).

## When ShieldCortex cannot answer

A step has no verdict when its request fails or its result cannot be read. Request failures: the ShieldCortex process exits while a request is pending (every pending request then fails with `MCP process exited`), including when `node` starts but the script at `EKHO_SHIELDCORTEX_PATH` is missing so the process exits at once; a request times out (10 seconds each); writing a request to the process's stdin fails with an error other than `EPIPE` (every pending request then fails at once with that error, and the process is stopped so the next tool call starts a new one; an `EPIPE` means the process has gone and is reported by its exit); the `node` executable itself cannot be started (for example it is not on the relay's `PATH`), which the client sees as the child process's `error` event, rejects every pending request with (for example an error with code `ENOENT`) and resets from, so the next tool call tries again; or the server answers with a JSON-RPC error (surfaced with the server's own message, for example an argument-validation error). Unreadable results: a tool result flagged `isError`, or one whose text holds neither the Markdown report nor a JSON verdict. In a Markdown report a field counts only as a whole line: a scan report has a verdict only when its risk level appears exactly once before the detections list; an action-check report with several decision lines takes the most restrictive one; and the "not active" notice counts as `approved` only when it is the whole report.

In every case the failing step logs a warning (`[shieldcortex-bridge] scan failed:` or `[shieldcortex-bridge] action gate failed:`, followed by the reason). Then:

- `strict` **fails closed**: the hook rejects the message with `scan unavailable: <reason>` or `action gate unavailable: <reason>`, so the relay refuses it with HTTP 403 as for any other bridge rejection. A `strict` relay whose ShieldCortex is down accepts no agent messages until it is back.
- `balanced` and `permissive` **fail open**: the hook continues with the next step, so a message the scanner could not see is delivered.

A failed `remember` call is silently ignored in every profile. The relay never exits because of a bridge failure (a `node` launch failure used to exit it; fixed in [#135](https://github.com/Drakon-Systems-Ltd/ekho/issues/135), PR #136).

## How the process is run

- ShieldCortex is started by the self-test at relay start-up, and again on demand by the first tool call after the process has gone (`callTool` reconnects whenever the client is not initialised), as `node <EKHO_SHIELDCORTEX_PATH>` with the relay's environment. The bridge speaks MCP to it over stdio using the MCP stdio framing: newline-delimited JSON-RPC 2.0, one JSON object per line, protocol version `2024-11-05`. This is the framing of the `@modelcontextprotocol/sdk` stdio transport the ShieldCortex server uses.
- Concurrent tool calls share one process and one handshake: the first call starts the process and sends `initialize`; later calls wait for that handshake before their own request is written. A handshake that fails (no `initialize` reply within the request timeout, a server error, an exit) stops that process so the next call starts a fresh one.
- Its stderr output is read and discarded.
- If the process exits, every in-flight request fails with `MCP process exited` and the next tool call starts a new process. That call can belong to the same message. Under `balanced` and `permissive`, a scan whose request failed because the process exited is logged as above, and the action check that follows it, for the same message, starts the new process; the memory record can likewise follow a failed action check. Under `strict` the message is rejected at the failed step and the next message starts the new process. There is one process per relay at a time.

## Tests

```bash
npx vitest run packages/shieldcortex-bridge
```

`bridge.test.ts` and `bridge-strict.test.ts` mock the MCP client and cover the hook's decisions, the profiles' failure behaviour, the self-test and the verdict parsers. `mcp-client-framing.test.ts`, `mcp-client-stdin-error.test.ts` and `mcp-client-spawn-error.test.ts` drive the client with a fake child process. `mcp-client-close.test.ts` and `mcp-client-live.test.ts` start a real child: a small newline-delimited MCP server (`tests/fixtures/fake-mcp-server.mjs`) that validates arguments as the ShieldCortex server does and answers with its Markdown reports. None of the tests start ShieldCortex itself.
