# Operations Guide

Running Ekho in production: deployment, configuration, security, upgrades, and troubleshooting. For the 60-second local quick start, see the [README](../README.md).

## Deployment options

### Docker Compose

```bash
export EKHO_OPERATOR_SESSION_SECRET=$(openssl rand -hex 32)
docker compose up -d
```

Compose refuses to start without `EKHO_OPERATOR_SESSION_SECRET` set — there is no insecure default. SQLite data persists in the `ekho-data` volume.

### Kubernetes (Helm)

```bash
helm install ekho ./deploy/helm/ekho \
  --namespace ekho --create-namespace \
  --set secrets.operatorSessionSecret=$(openssl rand -hex 32)
```

The chart deploys a single-replica StatefulSet with a PersistentVolumeClaim (SQLite is single-writer — do **not** scale beyond one replica). See [`deploy/helm/ekho/README.md`](../deploy/helm/ekho/README.md) for ingress, resource limits, and production overrides.

### From source

```bash
npm install && npm run build && npm run setup && npm start
```

`npm run setup` generates a strong operator secret into `.env` automatically and bootstraps the default fleet.

## Required configuration

| Variable | Default | Notes |
|----------|---------|-------|
| `EKHO_OPERATOR_SESSION_SECRET` | — (required) | Operator session signing secret. The relay **refuses to start** if unset or left as `change-me`. Generate with `openssl rand -hex 32`. |
| `EKHO_HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` in containers. |
| `EKHO_PORT` | `4000` | Listen port. |
| `EKHO_DB_PATH` | `./data/ekho.sqlite` | SQLite path. Point at a durable volume. |
| `EKHO_BASE_URL` | `http://127.0.0.1:4000` | Public URL advertised in A2A agent cards. |
| `EKHO_OPERATOR_SESSION_TTL_SECONDS` | `86400` | Max age of an operator session token. Bounds how long a stolen token stays usable; operators re-login when it lapses. |
| `EKHO_LOGIN_MAX_FAILURES` | `10` | Failed operator logins tolerated per account **and** per client IP within the window before `429`. |
| `EKHO_LOGIN_WINDOW_SECONDS` | `900` | Rolling window for the above. Counters decay rather than latch, and clear on a successful login. |
| `EKHO_OPERATOR_REQUIRE_TAILNET` | `0` | Set `1` to reject operator requests carrying no Tailscale identity, before credentials are processed. Recommended whenever the console is reachable beyond a private network. |
| `EKHO_OPERATOR_TAILNET_USER` | — | Optional: restrict operator access to a single Tailscale login. |

A full list lives in [`packages/relay/.env.example`](../packages/relay/.env.example).

## Operator session secret

The secret signs operator session tokens — anyone who knows it can forge an operator login. Rules:

- **Required.** The relay throws on startup if the secret is unset or `change-me`.
- **Stable.** Changing it invalidates all existing operator sessions (operators must log in again). Keep it constant across restarts.
- **Local dev escape hatch.** Set `EKHO_DEV_INSECURE=1` to run with the default secret for local development only. The relay logs a loud warning. Never use this in production.

## TLS

Ekho serves plain HTTP by default, intended to sit behind a TLS-terminating proxy (Caddy, nginx, or a Kubernetes ingress) — the common production pattern.

To terminate TLS in the relay itself, set **both**:

```bash
EKHO_TLS_CERT_PATH=/path/to/cert.pem
EKHO_TLS_KEY_PATH=/path/to/key.pem
```

Setting only one is a misconfiguration and the relay refuses to start. In Kubernetes, prefer ingress-level TLS over mounting certs into the pod.

## Health & readiness probes

| Endpoint | Meaning |
|----------|---------|
| `GET /healthz` | Liveness — the process is up. Returns `{"ok":true}`. |
| `GET /readyz` | Readiness — pings the database. Returns `{"ready":true}` (200) or `{"ready":false}` (503) if the store is unreachable. |

Wire `/readyz` to your load balancer / ingress so traffic is held until the relay can actually serve it. The Helm chart wires `/healthz` (liveness + startup) and `/readyz` (readiness) automatically; the Dockerfile's `HEALTHCHECK` uses `/healthz`.

## Graceful shutdown

The relay handles `SIGTERM` and `SIGINT`: it stops the background sweep job, closes in-flight connections via `app.close()`, and exits `0`. Kubernetes rolling updates and `docker stop` drain cleanly. No special configuration required.

## Persistence & backups

Ekho stores everything in a single SQLite database (WAL mode).

- **Back up** by copying the DB file (and `-wal`/`-shm` siblings) while the relay is stopped, or use `sqlite3 ekho.sqlite ".backup backup.sqlite"` for a hot backup.
- **Volume.** Mount `EKHO_DB_PATH`'s directory on durable storage (the compose volume / Helm PVC do this).
- Migrations apply automatically on startup; no manual migration step is needed.

## Upgrades

1. Pull the new image (`ghcr.io/drakon-systems-ltd/ekho:<version>`) or `git pull && npm run build`.
2. Restart the relay. Schema migrations in `packages/relay/migrations/` apply automatically and idempotently on boot.
3. Back up the database first (see above) before a major version bump.

For Helm: `helm upgrade ekho ./deploy/helm/ekho --set image.tag=<version> ...`.

## Observability

- **Metrics.** `GET /metrics` exposes Prometheus-formatted counters (fleet/agent/delivery/dead-letter/rate-limit). Scrape it from Prometheus.
- **Logs.** Structured JSON (pino) on stdout. Aggregate with your log pipeline.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Relay exits immediately with "EKHO_OPERATOR_SESSION_SECRET is unset or set to the insecure default" | Set a strong secret, or `EKHO_DEV_INSECURE=1` for local dev. |
| Relay exits with "TLS is misconfigured" | You set one of `EKHO_TLS_CERT_PATH`/`EKHO_TLS_KEY_PATH` but not both. |
| Operators forced to re-login after a restart | The session secret changed between runs. Keep it stable. |
| `docker pull ghcr.io/...` returns 404 | Use a tagged release (`:0.3.1`), not a branch name. Images are published by the release workflow on `v*` tags. |
| Helm pod stuck in `ImagePullBackOff` | The image tag in `values.yaml` has no matching published release, or the package is private. |
| Agents get `401 replayed nonce` | The agent reused a nonce. Each signed request needs a fresh nonce. |
| Agents get `401 timestamp outside allowed skew` | Clock drift between agent and relay exceeds `EKHO_TIMESTAMP_SKEW_SECONDS` (default 300). Sync clocks (NTP). |
| `/readyz` returns 503 | The relay can't reach SQLite — check the DB path, volume mount, and disk. |
| Messages never delivered, pile up in dead-letters | Recipient agent isn't polling its inbox or acking; after the max retry count (5) the delivery is dead-lettered. Inspect via the operator console. |
