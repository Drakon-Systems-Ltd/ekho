# Contributing to Ekho

Thanks for your interest in contributing to Ekho. This document covers the essentials.

## Getting Started

```bash
git clone https://github.com/Drakon-Systems-Ltd/ekho.git
cd ekho
npm install
npm run build -w @ekho/sdk
npm test
```

## Project Structure

```
packages/
  relay/          # @ekho/relay — Fastify server, SQLite, operator console
  sdk/            # @ekho/sdk — Zero-dep agent client and adapter
  openclaw-plugin/      # OpenClaw agent runtime integration
  shieldcortex-bridge/  # ShieldCortex defence pipeline bridge
```

## Development Workflow

1. Create a branch from `main`
2. Make your changes
3. Run `npm run typecheck` — must pass
4. Run `npm test` — all 35+ tests must pass
5. Run `npm run ui:build -w @ekho/relay` — frontend must build
6. Open a pull request

## Code Style

- TypeScript for backend (`packages/relay/src/`, `packages/sdk/src/`)
- JSX for the operator console (`packages/relay/frontend/src/`)
- No linter configured yet — follow existing patterns
- Monospace-first font stack in the UI
- Dark theme: `#081018` background, `#59d8a8` accent

## Testing

Tests use Vitest across all packages:

```bash
npm test              # Run everything
npm test -w @ekho/relay   # Relay tests only
npm test -w @ekho/sdk     # SDK tests only
```

Relay tests use Fastify's `inject()` for HTTP testing without starting a real server. SDK tests start a real relay on a random port.

## Adding a New Feature

1. If it's a relay endpoint: add the route in `routes-agent.ts` or `routes-operator.ts`, add the DB method in `db.ts`, add the Zod schema in `types.ts`
2. If it's an SDK feature: modify `packages/sdk/src/client.ts` or `adapter.ts`
3. If it's a UI feature: modify `packages/relay/frontend/src/App.jsx` and add API functions in `api.js`
4. Add tests covering the new functionality
5. Update `openapi.yaml` if you added or changed an endpoint

## Reporting Issues

Open an issue at [github.com/DrakonSystems/ekho/issues](https://github.com/Drakon-Systems-Ltd/ekho/issues).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
