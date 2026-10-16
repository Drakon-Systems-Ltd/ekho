# Ekho by Drakon Systems — Relay

The `@ekho/relay` package is the one-binary Fastify server at the heart of **Ekho by Drakon Systems**: a private, signed, store-and-forward messaging layer for distributed AI agent fleets. It bundles the agent and operator APIs, the SQLite-backed message store with retry and dead-letter lifecycle, the policy and approval engine, A2A 0.3 (JSON-RPC) endpoints, Prometheus metrics, and the React operator console.

For the full project overview, architecture, and SDK usage, see the [repository README](../../README.md).

## Develop

```bash
npm install            # from the repo root
npm run setup          # create your fleet + operator login (writes packages/relay/.env and data/)
npm run dev            # relay with hot reload (tsx watch)
npm run ui:dev         # operator console with Vite HMR
```

Run these from `packages/relay`, or from the repo root with `-w @ekho/relay`.

**Which `.env`:** from source, the relay reads `packages/relay/.env`, and that is where `npm run setup` saves a generated operator secret. The root `start`, `dev` and `setup` scripts run the relay's scripts with `-w @ekho/relay`, npm runs a workspace script from that workspace's own directory, and the relay loads `.env` from its working directory (`dotenv.config()` with no path). A `.env` at the repository root is not read when you start or set up the relay through these npm scripts; it is for Docker Compose, which reads it only to fill in `${EKHO_OPERATOR_SESSION_SECRET}` in `docker-compose.yml` (other variables in it do not reach the container).

| Script | Purpose |
|--------|---------|
| `npm run start` | Run the relay |
| `npm run setup` | Create your fleet and operator credentials. `npm run setup -- --help` prints usage only: no database, `.env` or fleet is created |
| `npm run doctor` | Check the Node version, database directory, operator session secret, base URL, port availability and license tier. Runs offline; it does not contact anything |
| `npm run ui:build` | Build the operator console into `ui-dist/` |
| `npm run build` | Build the console, then typecheck the relay |
| `npm run test` | Run the relay test suite |

The console is served from `ui-dist/` at `/ui/` once built. During development, `npm run ui:dev` proxies API calls to the running relay.

## Quick Start / Setup

These steps are generic and replicable by anyone — no fleet ids, hosts, or secrets are baked in. The same flow is available in-console under the **?** (Help) icon.

1. **Run the relay.** On your own server, clone the repo and set `packages/relay/.env` (an operator session secret and your `EKHO_BASE_URL`). Run `npm run setup` to create your fleet and operator login, then start the relay behind HTTPS (for example [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve)). Open the console at `<your-base-url>/ui/` and sign in.
2. **Add an agent.** In the console, click **Mint enrollment token** (bottom of the right panel). On the agent's machine, install the Ekho plugin or SDK for its runtime (for example the OpenClaw `ekho-adapter` plugin) and configure it with your relay URL, fleet id, and the token. The agent connects and appears in the **Agents** list, healthy.
3. **Trust the console.** Open the **Access** tab and turn **Operator-trusted channel** on for an agent. It then recognizes you as its verified principal and starts replying. Off = it stays quiet. Risky or destructive actions always require approval — trust never means blind obedience.
4. **Talk to your fleet.** Select a conversation or type in the composer (pick a recipient, or **Broadcast — all agents**). Trusted agents reply on their own; you'll see them "typing" then respond.
5. **Stay in control.** Use **Pause / Resume / Quarantine** on any agent, watch the event and approval log, and toggle trust off at any time. Everything is authenticated and audited.

## Operator console

The console (`frontend/`, built with Vite + React) gives you a three-pane workspace: an agents and conversations rail, a live chat view with per-agent colour-coded bubbles, typing indicators, and a human-speed typewriter reveal for incoming replies, plus a right rail for approvals, agent controls, trust/access, dead letters, and policies. A **Settings** panel (gear icon) lets you override per-agent bubble colours and toggle typing animation; preferences persist locally in your browser. All chat-UX motion respects `prefers-reduced-motion`.
