# @ekho/shieldcortex-bridge

A relay extension that sends each agent-submitted message that has passed the relay's own sender checks to a ShieldCortex MCP server for an Iron Dome scan and action check before the relay accepts it. It lives in this workspace (`packages/shieldcortex-bridge`) and is not published to npm.

## Enabling it

The relay loads the bridge at start-up when `EKHO_SHIELDCORTEX_PATH` is set (`packages/relay/src/server.ts`): it imports this package, registers the extension and logs `shieldcortex bridge loaded`. If the import fails, the relay logs `failed to load shieldcortex bridge` and keeps running without it.

| Variable | Default | Effect |
|---|---|---|
| `EKHO_SHIELDCORTEX_PATH` | unset | Path to the ShieldCortex MCP server's Node entry script. The bridge starts it as `node <path>` (`src/mcp-client.ts`), so the value must be a JavaScript file Node can run, not a compiled executable or a shell wrapper. Unset leaves the bridge off. |
| `EKHO_SHIELDCORTEX_PROFILE` | `balanced` | Defence profile: `strict`, `balanced` or `permissive`. Only the scan step behaves differently between them (see below). |

## What it does

The bridge registers an `onBeforeMessage` hook. The relay's message gate (`packages/relay/src/message-gate.ts`) runs it for every `POST /v1/messages` and every A2A `message/send`, after the sender's status, rate limit and policies have passed; a message refused by one of those checks never reaches the bridge. For a message that does, the hook runs the steps below in order and stops at the first step that rejects it:

1. **Scan the message body** with the `iron_dome_scan` tool. If the result's `riskLevel` is `HIGH` or `CRITICAL`, the `strict` profile rejects the message here, and the action check and the memory record below do not run; `balanced` and `permissive` log a warning and continue to the next step.
2. **Check the action** with the `iron_dome_check` tool (action `send_message:<message_type>`, source = the sending agent). A `blocked` or `requires_approval` decision rejects the message in every profile, and the memory record below does not run.
3. **Record the message** with the `remember` tool, only if neither of the bridge's own steps above rejected it: a title naming sender, recipient and message type, the first 2000 characters of the body, category `pattern`, tags `ekho`, `agent-communication` and the message type. This call is fire-and-forget; its result never affects delivery. A message rejected by the bridge's scan or action check leaves no memory record.

This is bridge-local behaviour, not a guarantee about the relay as a whole. The relay's message gate runs every registered extension in turn, in registration order (`packages/relay/src/message-gate.ts`, `packages/relay/src/license.ts`), and the bridge starts the `remember` call before its hook returns. If an extension registered after the bridge then rejects the message, the relay still refuses it with HTTP 403, but the memory record may already have been written.

A message rejected by the bridge itself (its scan or action check) is refused by the relay with HTTP 403 and `blocked by extension shieldcortex-bridge: <reason>`; on the A2A path a bridge-rejected message gets a JSON-RPC error with that same message and `data.extension` set to `shieldcortex-bridge`. Other rejections are reported differently: an extension registered after the bridge that rejects the message is named in the denial instead (`blocked by extension <name>: <reason>`), and a message refused by the sender's status, rate limit or policies before the bridge runs gets that check's own response (for example HTTP 429 `rate limit exceeded`).

The bridge fails open on request failures. If the ShieldCortex process cannot be started or exits while a request is pending (every pending request then fails with `MCP process exited`), or a request times out (10 seconds each), the failing step logs a warning (`[shieldcortex-bridge] scan failed:` or `[shieldcortex-bridge] action gate failed:`, followed by the error) and the hook continues with the next step. A tool result whose text is not valid JSON is silently ignored: no warning is logged, the step finds nothing to act on and the hook continues. Rejection is decided by the error message, not only by a parsed decision. The scan step rethrows any error whose message starts with `threat detected:`, and the action check any error whose message starts with `Iron Dome blocked:` or `Iron Dome requires`. The bridge builds those messages itself from a high-risk scan result under `strict` or from a `blocked` / `requires_approval` decision, but a JSON-RPC error returned by the server is surfaced as an error carrying the server's own message (`src/mcp-client.ts`), so a server error whose message starts with one of those prefixes also rejects the message, in every profile.

## How the process is run

- ShieldCortex is started lazily, on the first tool call (so on the first message to reach the hook after the relay starts), as `node <EKHO_SHIELDCORTEX_PATH>` with the relay's environment. The bridge speaks MCP to it over stdio: JSON-RPC 2.0 with `Content-Length` framing, protocol version `2024-11-05`.
- Its stderr output is read and discarded.
- If the process exits, every in-flight request fails with `MCP process exited` and the next tool call starts a new process: `callTool` reconnects whenever the client is not initialised. That call can belong to the same message. A scan whose request failed because the process exited is logged as above, and the action check that follows it, for the same message, starts the new process; the memory record can likewise follow a failed action check. There is one process per relay at a time and no health check beyond the per-request timeout.

## Tests

```bash
npx vitest run packages/shieldcortex-bridge
```

The tests mock the MCP client; they do not start ShieldCortex.
