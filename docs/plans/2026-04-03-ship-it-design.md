# Ship It — Design Document

## Context

Ekho has a hardened core and a proper monorepo with SDK and test suite. This phase makes it shippable as an open-core OSS product.

## Business Model

**Open-core**: Free OSS relay with paid Pro tier.

| Feature | OSS (Free) | Pro (Paid) |
|---------|-----------|------------|
| Fleets | 1 | Unlimited (per license) |
| Agents | Unlimited | Unlimited |
| Message relay + retry + dead-letter | Yes | Yes |
| Basic policies (deny/allow) | Yes | Yes |
| Rate limiting + quarantine | Yes | Yes |
| Operator console | Yes | Yes |
| SQLite backend | Yes | Yes |
| **Multi-fleet / multi-tenant** | No | Yes |
| **Advanced policies** (time-based, conditional routing, approval chains) | No | Yes |
| **Analytics dashboard** (volume charts, latency, health trends) | No | Yes |

## Licensing

- **Offline license key**: Signed JWT (RS256) containing tier, org, max_fleets, features, expiry
- **Discovery**: env var `EKHO_LICENSE_KEY` → file `ekho.license` → OSS mode
- **No phone-home**: Privacy-friendly, no license server required
- **Signing**: Asymmetric RS256 — private key stays with Drakon Systems, public key ships in relay

## Pro Architecture

**Plugin system** — Pro ships as a separate private npm package `@ekho/pro`.

The relay defines extension hooks:
```typescript
interface EkhoExtension {
  name: string;
  onBeforeMessage?(ctx): Promise<void>;       // advanced policies
  onFleetCreate?(ctx): Promise<void>;          // multi-fleet gate
  onOverviewRequest?(ctx): Promise<object>;    // analytics enrichment
}
```

OSS repo contains zero Pro code. Extension hooks are public API — community can use them too.

**Enforcement points:**
- Fleet creation: reject if `tier !== "pro"` and fleet count > 0
- Advanced policy types: error if feature not licensed
- Analytics endpoints: only registered when Pro extension loaded

## Shipping Items

### 1. License System
- `packages/relay/src/license.ts` — decode, verify, expose tier/features
- Extension hook registry in relay startup
- OSS enforcement in fleet creation

### 2. GitHub Actions CI
- `.github/workflows/ci.yml`
- Trigger: push to main, all PRs
- Steps: install → typecheck → test → build SDK
- Node 22

### 3. Docker
- `Dockerfile` (multi-stage: build → slim runtime)
- `docker-compose.yml` (relay + env)
- `.dockerignore`
- Non-root user, port 4000

### 4. OpenAPI Spec
- Complete rewrite of `openapi.yaml`
- All 24 endpoints documented
- Request/response schemas
- Auth header descriptions

### 5. Setup Wizard Polish
- Cleaner console output
- Better doctor checks
- Smoke test on setup completion
