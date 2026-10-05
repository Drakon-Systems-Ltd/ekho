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
| `EKHO_OPERATOR_REQUIRE_TAILNET` | `0` | Set `1` to reject operator requests that do not arrive from a trusted proxy carrying a Tailscale identity, before credentials are processed. Recommended whenever the console is reachable beyond a private network. |
| `EKHO_OPERATOR_TAILNET_USER` | — | Optional: restrict operator access to a single Tailscale login. |
| `EKHO_TRUSTED_PROXY_IPS` | `127.0.0.1,::1,::ffff:127.0.0.1` | Socket addresses trusted to speak for their clients. Only these peers' `X-Forwarded-For` and `Tailscale-User-*` headers are believed; from anyone else both are ignored, so the tailnet gate fails closed on a direct connection. Set this to the address of the `tailscale serve` / reverse-proxy hop. |

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
- **Retention.** The sweep prunes heartbeat history after 48h
  (`EKHO_HEARTBEAT_RETENTION_SECONDS`, always keeping each agent's newest row)
  and high-volume operational events after 30 days
  (`EKHO_EVENT_RETENTION_SECONDS`). The audit trail — operator keys, policy,
  approvals, trust and quarantine decisions, room and feed lifecycle — is
  retained regardless of both settings. Deleting rows does not shrink the file:
  run `VACUUM` by hand in a quiet window if you need the space back (it needs
  roughly the database's size again in free disk and takes an exclusive lock),
  see [Performance](performance.md#reclaiming-disk-space).

## Upgrades

The relay has two parts that must move together: the server, and the operator console, a static bundle built into `packages/relay/ui-dist` by the relay's `ui:build` script. A relay upgraded without rebuilding the console keeps serving the old console against the newer server, so new console features are missing.

1. **Back up the database** (see [Persistence & backups](#persistence--backups)). Back up the file `EKHO_DB_PATH` points at, which is not necessarily `packages/relay/data/`: from source the default is `packages/relay/data/ekho.sqlite` and a relative path resolves against the relay's working directory; in the Docker image it is `/app/data/ekho.sqlite` in the `ekho-data` volume.
2. **Get the new version and build it.**
   - **From source:** `git pull`, `npm install`, then `npm run build`. The root `build` builds the SDK and then the relay, whose `build` runs `ui:build` before the type check — so it rebuilds the console. If you only run part of the build, run `npm run ui:build -w @ekho/relay` yourself.
   - **Docker Compose:** the Compose file builds the image from the checkout, and the Dockerfile runs `ui:build` inside the image build, so a rebuilt image carries the matching console. `git pull`, then `docker compose up -d --build`. Restarting without `--build` keeps the old image. Up to and including 0.5.6 the image build ignored a failed console build and could ship a stale `packages/relay/ui-dist` left in the checkout; on `main` since 0.5.6 a failed console build fails the image build, and the checkout's `ui-dist` is excluded from the build context.
   - **Image / Helm:** pull the new tagged image (`ghcr.io/drakon-systems-ltd/ekho:<version>`); it already contains the matching console. For Helm: `helm upgrade ekho ./deploy/helm/ekho --set image.tag=<version> ...`.
3. **Restart the relay.** Schema migrations in `packages/relay/migrations/` apply automatically and idempotently on boot; there is no manual migration step.
4. **Verify.** `GET /readyz` returns `{"ready":true}`; reload the console in the browser (the relay serves `index.html` with revalidation, so a reload picks up the new build) and check that agents report healthy.
5. **Update the agents' plugins.** For OpenClaw: run `openclaw plugins update ekho-adapter` (npm installs only; `plugins update` skips a local-folder install, which you rebuild and reinstall with `--force`). Since 0.5.6 the plugin keeps `.ekho-identity.json` and `.ekho-credentials.json` in its state directory (`~/.openclaw/ekho-adapter/` by default), outside the install directory, so an update leaves them alone. The update from 0.5.5 or earlier is the exception: stop the gateway and back both files up first, as in [Upgrading from 0.5.5 or earlier](../packages/openclaw-plugin/README.md#upgrading-from-055-or-earlier). See the [plugin README](../packages/openclaw-plugin/README.md#update). Read [CHANGELOG.md](../CHANGELOG.md) for any mixed-version notes.

## Operator-key recovery

Each console browser holds its own operator key. Once an agent has pinned its first operator keys, it adds another only when a key it already pins has endorsed it (see [Operator keys and devices](../README.md#operator-keys-and-devices)). If the browser holding your trust root is lost (for example, its passphrase is forgotten) and no other device can endorse a new key, the relay host can arm a **one-time recovery grant**. There is no HTTP route for this: it runs on the relay host, against the relay's own database (same working directory, `.env` and `EKHO_DB_PATH` as the relay service).

> **Requires relay 0.5.6 or later.** Recovery grants (#94) first ship in 0.5.6; 0.5.5 and earlier releases and images do not have them. Upgrade the relay first (see [Upgrades](#upgrades)).

The grant lets one named **recovering** key — a key you still hold in some browser, which your agents still trust — endorse one named **successor** operator key, once, within a short window. It cannot endorse agent keys. It does not help if no key your agents trust is still available.

From `packages/relay` on the relay host (source install):

```bash
# Inspect operator keys, how many agents each one endorsed, and any grants
npm run recovery-grant -- status --fleet <fleet id or name>

# Arm the grant
npm run recovery-grant -- arm --fleet <fleet id or name> \
  --endorser <recovering key id> --successor <successor key id> \
  --confirmed-by "<who confirmed, how, when>" [--ttl-minutes 30]

# Cancel an armed grant
npm run recovery-grant -- cancel --fleet <fleet id or name> --grant <grant id>
```

With Docker, run the same command inside the running relay container, so it uses that container's database volume and environment. The image's working directory is `/app` and `tsx` is installed globally, so call the entry point directly:

```bash
# Docker Compose, from the directory holding docker-compose.yml
docker compose exec relay tsx packages/relay/src/recovery-grant.ts status --fleet <fleet id or name>

# Plain Docker
docker exec <relay container> tsx packages/relay/src/recovery-grant.ts status --fleet <fleet id or name>
```

`arm` and `cancel` take the same arguments as above.

The procedure:

1. In a new browser, open the console's **Security** screen and generate an identity. This registers the successor key, unendorsed. Note its key id.
2. The operator confirms the recovering key id and the successor key id directly, out of band, to whoever runs the command on the relay host. Before arming, check that the agents really trust the recovering key (each agent's identity file lists it among its pinned operator keys; for OpenClaw, under `pinnedOperatorKeys` in `.ekho-identity.json` in the plugin's [state directory](../packages/openclaw-plugin/README.md#state-files), `~/.openclaw/ekho-adapter/` by default, or `~/.openclaw/extensions/ekho-adapter/` for plugin 0.5.5 and earlier); the relay cannot prove that for you.
3. Arm the grant. `--confirmed-by` is required and is recorded in the audit trail. `--ttl-minutes` defaults to 30 (maximum 120). Only one grant can be armed per fleet; the successor must be registered, live and not yet endorsed.
4. In the browser holding the recovering key, press **Endorse** on the successor (Security → panel ②). This uses up the grant.
5. From the successor's browser, re-endorse every agent. While the lost key is still live, the agents it endorsed are not flagged as needing action (each shows a ✓ with the lost key's label in **Security** → panel ③, **Agent identities**), so the trust-health banner and its **Re-endorse all** stay hidden. Instead the Security screen shows *N agents are endorsed by another device*: press **Consolidate all under this device**. To move agents one at a time instead, press the **↻** button (*Re-endorse under this device*) on each agent's row in panel ③. An agent has moved when its row shows **✓ this device**. Do not continue until every row in panel ③ shows **✓ this device**.
6. Only then revoke the lost key, from the successor's browser (**Security** → panel ② → **Revoke** on the lost key's row). The revocation is signed by the successor's key; agents that pin the successor tombstone and unpin the lost key on their next poll. Revoking it earlier would leave every agent it endorsed without a trusted operator, and revoking it from a device the agents do not trust is refused by the relay because no agent would honour it.

Use `status` to confirm the grant reads `used`; an unused grant expires on its own, or `cancel` it.

## Observability

- **Metrics.** `GET /metrics` exposes Prometheus-formatted counters (fleet/agent/delivery/dead-letter/rate-limit). Scrape it from Prometheus.
- **Logs.** Structured JSON (pino) on stdout. Aggregate with your log pipeline.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Relay exits immediately with "EKHO_OPERATOR_SESSION_SECRET is unset or set to the insecure default" | Set a strong secret, or `EKHO_DEV_INSECURE=1` for local dev. |
| Relay exits with "TLS is misconfigured" | You set one of `EKHO_TLS_CERT_PATH`/`EKHO_TLS_KEY_PATH` but not both. |
| Operators forced to re-login after a restart | The session secret changed between runs. Keep it stable. |
| `docker pull ghcr.io/...` returns 404 | Use a tagged release (`:0.3.2`), not a branch name. Images are published by the release workflow on `v*` tags. |
| Helm pod stuck in `ImagePullBackOff` | The image tag in `values.yaml` has no matching published release, or the package is private. |
| Agents get `401 replayed nonce` | The agent reused a nonce. Each signed request needs a fresh nonce. |
| Agents get `401 timestamp outside allowed skew` | Clock drift between agent and relay exceeds `EKHO_TIMESTAMP_SKEW_SECONDS` (default 300). Sync clocks (NTP). |
| Console is missing a feature the release notes describe, after an upgrade from source | The console bundle (`packages/relay/ui-dist`) was not rebuilt. Run `npm run ui:build -w @ekho/relay` and reload the console. |
| `/readyz` returns 503 | The relay can't reach SQLite — check the DB path, volume mount, and disk. |
| Messages never delivered, pile up in dead-letters | Recipient agent isn't polling its inbox or acking; after the max retry count (5) the delivery is dead-lettered. Inspect via the operator console. |
