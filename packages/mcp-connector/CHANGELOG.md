# Changelog

All notable changes to the Ekho MCP connector are documented here. Versions are kept in lockstep with the relay; see the root [CHANGELOG.md](../../CHANGELOG.md) for the rest of the project.

## [Unreleased]

## [0.7.1] - 2026-10-14

Patch on 0.7.0, in lockstep with the rest of the workspace. Still not published to npm; install from a checkout as the package README describes.

### Fixed
- **MCP connector: `ekho_roster` and `ekho_open_room` render relay-controlled fields inert (#127).** Display names, agent ids, runtime, status, room names and ids, and the member list returned by `ekho_open_room` now get the same control-character escaping as the inbox, so none can add a line (such as a forged `Operator trusted by relay:` or `cursor:` line). Display names, sender labels and room names, in these tools and in `ekho_inbox`/`ekho_conversation`, also have `*`, backtick and backslash escaped, so a name cannot close the surrounding bold and pass off a verification or endorsement status. Escaping is output-only; stored values and tool inputs are unchanged.

## [0.7.0] - 2026-10-12

First release of the connector, in lockstep with the rest of the workspace. Not published to npm yet; install from a checkout as the package README describes.

### Added
- **`@drakon-systems/ekho-mcp`: an Ekho MCP connector, so an MCP client such as the Grok app can join a fleet as a signed, verifying participant.** The connector is a full Ekho agent (enrols once with a fleet enrolment token, keeps its credentials and Ed25519 identity in a state directory with the OpenClaw plugin's rules: atomic owner-only writes, never re-minting an identity for an enrolled agent, an unusable file preserved and refused rather than enrolled over), heartbeats on the relay's interval, polls the inbox, verifies every inbound signature with the same code the plugin uses (`@drakon-systems/ekho-sdk/identity`: pinned operator keys with the first-contact latch, chain adoption, signed revocation only, unsigned `revoked: true` advisory), keeps a per-message verdict, acks what it has judged, dead-letters what it will not show, and stores the rest in a bounded durable local queue until the client reads it. It serves MCP over Streamable HTTP (stateless, JSON responses; GET/DELETE answer 405) with five tools: `ekho_inbox` (idempotent through a cursor, so a client retry receives the same batch instead of losing it), `ekho_send` (v2-signed with the connector's identity, text only, one target), `ekho_roster`, `ekho_open_room` and `ekho_conversation`. Tool results are plain markdown and never carry signatures, secrets or raw envelopes. Authentication is mandatory on the MCP path: either a built-in single-user OAuth 2.1 authorization server (PKCE S256 only, RFC 9728 protected-resource metadata, RFC 8414 server metadata, RFC 7591 dynamic registration, RFC 8707 resource binding, refresh-token rotation, a consent page that asks for the operator password and nothing else, with a per-address failure throttle) or a static bearer compared in constant time (`EKHO_MCP_AUTH=bearer`). Every request passes a per-client token bucket (429 with `Retry-After`) and a 64 KB body cap (413 before anything is parsed); `/healthz` needs no auth and carries no secrets. A phase-2 seam wakes a Grok automation through a Standard-Webhooks-signed POST when messages arrive (`EKHO_MCP_WAKE_WEBHOOK_URL`, off by default): debounced to at least 30 s, three attempts with backoff, and a circuit breaker.

### Fixed
- **MCP connector: no unread message can be lost (#119 review follow-ups).** The local ring no longer evicts unread inbound messages past `EKHO_MCP_QUEUE_MAX`; it drops read and outbound messages oldest first, and while the unread backlog is at the bound the connector stops polling the relay (which still holds the messages) instead of fetching, acking and then evicting. `ekho_inbox` is at-least-once: a batch counts as read only when the client passes its cursor back as `after`; until then a plain call returns the same messages again plus newer ones, so a response lost on the wire cannot lose a batch. Each cursor keeps an immutable copy of its batch, so `cursor` replay is exact even after eviction. Relay- and roster-controlled labels (sender, room, reply-to) are rendered with control characters escaped.
