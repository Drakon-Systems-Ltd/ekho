# Ekho Setup Wizard

## Quickstart Path

1. Run `npm run setup`
2. Capture the bootstrap operator credentials and first enrollment token
3. Build the operator console with `npm run ui:build`
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

Run `npm run doctor` to check:

- database path availability
- base URL configuration
- operator session secret configuration
