# Ekho Setup

## Quickstart Path

1. Run `npm run setup`
2. Capture the bootstrap operator credentials and first enrollment token
3. Build the operator console with `npm run ui:build -w @ekho/relay` (the script lives in `packages/relay/package.json`, so from the repo root it needs `-w @ekho/relay`)
4. Start the relay with `npm start`
5. Open `/ui/` and log in with the bootstrap operator
6. Enroll your first agent at `POST /v1/enroll`
7. Verify the agent heartbeat, inbox, approvals, and operator overview

## What `npm run setup` does

`npm run setup` runs `packages/relay/src/setup.ts`. In order, it:

1. Loads the relay configuration, including `packages/relay/.env` (see [Which `.env`](operations.md#from-source)), and opens the database at `EKHO_DB_PATH`, creating it and applying migrations if needed.
2. Loads the license, if one is configured.
3. Checks for an operator session secret. If `EKHO_OPERATOR_SESSION_SECRET` is unset, empty or still `change-me`, it generates a random one and saves it to `.env` in its working directory (`packages/relay/.env` under `npm run setup`); if it cannot write the file, it prints the secret for you to set.
4. Stops there if a fleet named `default` already exists, so running it again does not create a second operator.
5. Otherwise checks that the license allows another fleet, then creates the `default` fleet and the first operator: `EKHO_BOOTSTRAP_EMAIL` (default `admin@example.com`) with `EKHO_BOOTSTRAP_PASSWORD`, or a generated password that is printed once and stored only as a hash.
6. Issues one enrollment token and prints it with the relay's base URL and the next steps.

It does not bind any address, start the relay, or contact the network. `--help` prints usage and exits without doing any of the above.

## Not implemented: Tailscale-aware setup

[ARCHITECTURE.md](../ARCHITECTURE.md) is a design document and describes a setup wizard that would detect `tailscaled`, resolve the machine's Tailscale IP and MagicDNS name, bind the relay and console to the tailnet interface only, offer guided Tailscale installation when it is missing, and finish with a smoke test of heartbeat, message delivery and ack. **None of that is implemented**: `setup.ts` does none of these steps. Today you choose the bind address yourself with `EKHO_HOST` and put the relay behind HTTPS yourself (for example with [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve)); `EKHO_OPERATOR_REQUIRE_TAILNET` and `EKHO_TRUSTED_PROXY_IPS` (see the [Operations Guide](operations.md#required-configuration)) restrict operator access to requests carrying a Tailscale identity from a trusted proxy.

## Doctor Command

Run `npm run doctor -w @ekho/relay` (the script lives in `packages/relay/package.json`, not the root `package.json`; from inside `packages/relay` the `-w` flag is not needed). It checks:

- Node version (22 or newer)
- database directory exists (the parent of `EKHO_DB_PATH`)
- operator session secret differs from the shipped `change-me` default (`EKHO_OPERATOR_SESSION_SECRET`); doctor does not reject an explicitly empty value, although the server refuses to start with one unless `EKHO_DEV_INSECURE` is set
- base URL is configured (`EKHO_BASE_URL`)
- port is free (`EKHO_PORT`; it binds the port on 127.0.0.1 briefly, then releases it)
- license tier (Pro with its org and expiry, otherwise OSS)

It runs offline: it does not contact a relay or anything else over the network.
