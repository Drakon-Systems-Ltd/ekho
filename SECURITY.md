# Security Policy

## Supported Versions

Ekho is in the `0.x` line and receives security fixes on the latest minor release only. Once `1.0` ships the previous minor will continue to receive critical fixes for six months.

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security reports.** Public disclosure before a patch is available puts every Ekho deployment at risk.

Report privately using one of these channels, in order of preference:

1. **GitHub Security Advisories** — https://github.com/Drakon-Systems-Ltd/ekho/security/advisories/new (preferred; encrypted by GitHub, gives us an audit trail)
2. **Email** — security@drakonsystems.com (PGP key available on request)

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce, or a proof-of-concept
- The affected Ekho version(s) / commit SHAs
- Any suggested mitigations

We acknowledge reports within **48 hours** and aim to ship a fix within **14 days** for high-severity issues.

## Scope

In scope:

- The relay server (`packages/relay`)
- The agent SDK (`packages/sdk`) and its signing protocol
- The operator console web app
- The license verification code path
- A2A protocol endpoints

Out of scope:

- Bugs in dependencies — please report upstream. We will bump affected versions once upstream ships a fix.
- Denial of service achievable only with operator credentials (the operator is trusted)
- Social engineering of Drakon Systems staff or users
- Physical access to a relay host

## Hardening Checklist for Operators

If you run Ekho in production, these defaults keep the blast radius small:

- Set `EKHO_OPERATOR_SESSION_SECRET` to a random 32+ byte value — the default string literally says `change-me`
- Terminate TLS at a reverse proxy (Caddy, nginx, Traefik) — the relay itself speaks plain HTTP
- Keep the relay behind a private network (Tailscale, WireGuard, VPC). Ekho is designed for mesh networks, not the open internet
- Rotate agent secrets by revoking and re-enrolling on any suspected compromise
- Pin the Docker image to a specific SHA, not `latest`
- Review `EKHO_RATE_LIMIT_MAX_MESSAGES` and `EKHO_HEARTBEAT_TIMEOUT_SECONDS` for your workload — too lax = abuse window; too strict = false quarantines
- **If the console is reachable beyond your private network, set `EKHO_OPERATOR_REQUIRE_TAILNET=1`** (optionally with `EKHO_OPERATOR_TAILNET_USER`). It rejects operator requests that do not arrive from `tailscale serve` carrying a Tailscale identity, *before* credentials are processed, so a published relay does not expose its login to the open internet. The identity headers (`Tailscale-User-Login` / `Tailscale-User-Name`) are only believed when the connection's socket peer is a configured trusted proxy (`EKHO_TRUSTED_PROXY_IPS`, default loopback — where Serve terminates); a client connecting directly to the bind address cannot pass the gate by setting those headers itself. Point `EKHO_TRUSTED_PROXY_IPS` at the Serve/proxy hop and never expose the relay port to anything but that hop
- Shorten `EKHO_OPERATOR_SESSION_TTL_SECONDS` (default 24h) if operators work from shared or untrusted machines — it bounds how long a stolen token stays usable
- Tighten `EKHO_LOGIN_MAX_FAILURES` / `EKHO_LOGIN_WINDOW_SECONDS` if the login endpoint is exposed to untrusted networks
- Serve the console over HTTPS. The relay's `Strict-Transport-Security` and `upgrade-insecure-requests` are emitted only for requests that arrived over TLS, so a plain-HTTP deployment silently forgoes both
- Monitor the dead-letter table and rate-limit violation history — sustained growth is almost always a signal of abuse or misconfiguration

## Coordinated Disclosure

Once a patch is available we will:

1. Publish a GitHub Security Advisory with CVE (if applicable)
2. Tag a patched release and note the fix in `CHANGELOG.md`
3. Credit the reporter (unless anonymity is requested)
4. Hold public details for 7 days after release to give operators time to upgrade

Thanks for helping keep Ekho and its users safe.
