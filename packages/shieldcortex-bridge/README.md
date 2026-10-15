# @ekho/shieldcortex-bridge

A relay extension that sends every message an agent submits to a ShieldCortex MCP server for an Iron Dome scan and action check before the relay accepts it. It lives in this workspace (`packages/shieldcortex-bridge`) and is not published to npm.

## Enabling it

The relay loads the bridge at start-up when `EKHO_SHIELDCORTEX_PATH` is set (`packages/relay/src/server.ts`): it imports this package, registers the extension and logs `shieldcortex bridge loaded`. If the import fails, the relay logs `failed to load shieldcortex bridge` and keeps running without it.

| Variable | Default | Effect |
|---|---|---|
| `EKHO_SHIELDCORTEX_PATH` | unset | Path to the ShieldCortex MCP server's Node entry script. The bridge starts it as `node <path>` (`src/mcp-client.ts`), so the value must be a JavaScript file Node can run, not a compiled executable or a shell wrapper. Unset leaves the bridge off. |
| `EKHO_SHIELDCORTEX_PROFILE` | `balanced` | Defence profile: `strict`, `balanced` or `permissive`. Only the scan step behaves differently between them (see below). |

## What it does

The bridge registers an `onBeforeMessage` hook. The relay's message gate (`packages/relay/src/message-gate.ts`) runs it for every `POST /v1/messages` and every A2A `message/send`, after the sender's status, rate limit and policies have passed. For each message the hook:

1. **Scans the message body** with the `iron_dome_scan` tool. If the result's `riskLevel` is `HIGH` or `CRITICAL`, the `strict` profile rejects the message; `balanced` and `permissive` log a warning and let it through.
2. **Checks the action** with the `iron_dome_check` tool (action `send_message:<message_type>`, source = the sending agent). A `blocked` or `requires_approval` decision rejects the message in every profile.
3. **Records the message** with the `remember` tool: a title naming sender, recipient and message type, the first 2000 characters of the body, category `pattern`, tags `ekho`, `agent-communication` and the message type. This call is fire-and-forget; its result never affects delivery.

A rejected message is refused by the relay with HTTP 403 and `blocked by extension shieldcortex-bridge: <reason>`; on the A2A path the same denial is returned as a JSON-RPC error.

The bridge fails open on errors. If the ShieldCortex process cannot be reached, a request times out (10 seconds each) or a result cannot be parsed, the scan and the action check log a warning and the message is allowed through. Only an explicit high-risk scan result under `strict`, or an explicit `blocked` / `requires_approval` decision, rejects a message.

## How the process is run

- ShieldCortex is started lazily, on the first message after the relay starts, as `node <EKHO_SHIELDCORTEX_PATH>` with the relay's environment. The bridge speaks MCP to it over stdio: JSON-RPC 2.0 with `Content-Length` framing, protocol version `2024-11-05`.
- Its stderr output is read and discarded.
- If the process exits, every in-flight request fails with `MCP process exited` and the next message starts a new process. There is one process per relay and no health check beyond the per-request timeout.

## Tests

```bash
npx vitest run packages/shieldcortex-bridge
```

The tests mock the MCP client; they do not start ShieldCortex.
