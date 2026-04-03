# Make It Real — Design Document

## Context

Ekho's core relay is functional with hardened delivery, rate limiting, policies, and quarantine automation. The next step is making it consumable: a publishable SDK for agents, a test suite for confidence, and proper project structure.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Package structure | Monorepo with npm workspaces | Clean separation, agents don't pull server deps |
| Package naming | `@ekho/relay` + `@ekho/sdk` | Scoped, consistent |
| Test runner | Vitest | Already have Vite, native TS, fast |
| Test scope | Integration (relay) + SDK tests | Full-stack confidence, both packages covered |
| PostgreSQL | Deferred | SQLite+WAL sufficient, higher-value work first |

## Monorepo Structure

```
ekho/
├── package.json              # Root workspace manager
├── tsconfig.base.json        # Shared compiler options
├── vitest.workspace.ts       # Vitest workspace config
├── packages/
│   ├── relay/
│   │   ├── package.json      # @ekho/relay
│   │   ├── tsconfig.json
│   │   ├── vite.config.mjs
│   │   ├── src/              # server.ts, db.ts, routes, sweep, auth, etc.
│   │   ├── migrations/
│   │   ├── frontend/
│   │   ├── ui-dist/
│   │   └── tests/
│   │       ├── setup.ts      # Test helpers: create temp DB, start server
│   │       ├── relay.test.ts # Full API integration tests
│   │       └── sweep.test.ts # Background job tests
│   └── sdk/
│       ├── package.json      # @ekho/sdk (zero runtime deps)
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts      # Barrel export
│       │   ├── client.ts     # EkhoAgentClient
│       │   ├── adapter.ts    # EkhoAgentAdapter
│       │   └── types.ts      # Credentials, InboxMessage, ControlMessage
│       └── tests/
│           ├── setup.ts      # Start relay fixture
│           ├── client.test.ts
│           └── adapter.test.ts
├── data/
├── docs/
└── .env.example
```

## SDK Package (`@ekho/sdk`)

### Exports

```typescript
// @ekho/sdk
export { EkhoAgentClient } from "./client";
export { EkhoAgentAdapter } from "./adapter";
export type {
  AgentCredentials,
  InboxMessage,
  ControlMessage,
  AdapterHooks,
  ActionDecision,
} from "./types";
```

### Characteristics

- Zero runtime dependencies (Node crypto only)
- TypeScript declarations included (declaration: true)
- CJS output (matches relay, Node16 module resolution)
- Types exported for consumers

## Relay Package (`@ekho/relay`)

### Changes from current structure

- All current `src/` files move to `packages/relay/src/`
- `migrations/` moves to `packages/relay/migrations/`
- `frontend/` and `ui-dist/` move to `packages/relay/`
- `vite.config.mjs` moves to `packages/relay/`
- Server deps (fastify, better-sqlite3, etc.) move to relay's package.json
- Shared dev deps (vitest, typescript) stay at root

### Path adjustments

- `config.ts` dbPath resolves from cwd (unchanged)
- `server.ts` static file serving resolves relative to package root
- Migration runner resolves from cwd (unchanged)

## Test Suite

### Relay integration tests

Test the full API cycle with a real Fastify instance and temp SQLite DB:

1. **Enrollment flow**: issue token → enroll agent → verify credentials
2. **Message lifecycle**: send → poll inbox → ACK → verify state
3. **Retry + dead-letter**: send to offline agent → wait for timeout → verify requeue → exhaust retries → verify dead letter
4. **Rate limiting**: exceed limit → verify 429 → wait for window → verify recovery
5. **Policy enforcement**: create deny policy → send blocked message → verify 403 → delete policy → verify allowed
6. **Quarantine automation**: enroll agent → skip heartbeats → verify auto-quarantine → send heartbeat → verify restore
7. **Operator endpoints**: login → overview → list agents → approve/reject → policies CRUD → dead letters

### SDK tests

Start a real relay as test fixture, test against live endpoints:

1. **Client methods**: sendMessage, getInbox, ackMessages, heartbeat, proposeAction
2. **Adapter lifecycle**: start → verify heartbeat fires → send message → verify onMessage callback → stop
3. **Error handling**: invalid credentials → verify rejection, rate limit → verify 429 handling

### Test infrastructure

- `setup.ts` per package: creates temp DB, starts/stops server, provides test credentials
- Each test file isolated (own DB file, own server port)
- `vitest.workspace.ts` at root runs both packages
