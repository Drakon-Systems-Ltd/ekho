# Ekho Setup Wizard

## Quickstart Path

1. Run `npm run setup`
2. Capture the bootstrap operator credentials and first enrollment token
3. Build the operator console with `npm run ui:build -w @ekho/relay` (the script lives in `packages/relay/package.json`, so from the repo root it needs `-w @ekho/relay`)
4. Start the relay with `npm start`
5. Open `/ui/` and log in with the bootstrap operator
6. Enroll your first agent at `POST /v1/enroll`
7. Verify the agent heartbeat, inbox, approvals, and operator overview

## Existing Tailscale Network

In the production product, the wizard should:

1. Detect `tailscaled`
2. Resolve Tailscale IP and MagicDNS name
3. Bind relay and UI to the tailnet interface only
4. Initialize storage
5. Create the first fleet and operator
6. Generate an enrollment token
7. Run a smoke test covering heartbeat, message delivery, and ack

## No Tailscale Installed

In the production product, the wizard should:

1. Detect the missing private-network prerequisite
2. Explain why Ekho expects a private network
3. Offer guided Tailscale installation steps
4. Resume bootstrap once networking is ready

## Doctor Command

Run `npm run doctor -w @ekho/relay` (the script lives in `packages/relay/package.json`, not the root `package.json`; from inside `packages/relay` the `-w` flag is not needed). It checks:

- Node version (22 or newer)
- database directory exists (the parent of `EKHO_DB_PATH`)
- operator session secret is set to something other than the default
- base URL is configured (`EKHO_BASE_URL`)
- port is free (`EKHO_PORT`; it binds the port on 127.0.0.1 briefly, then releases it)
- license tier (Pro with its org and expiry, otherwise OSS)

It runs offline: it does not contact a relay or anything else over the network.
