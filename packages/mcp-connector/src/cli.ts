#!/usr/bin/env node
// `ekho-mcp`: enrol/load the agent, start the relay loops, serve MCP.
import { createRequire } from "node:module";
import { IdentityUnavailableError, keyId, fromB64url } from "@drakon-systems/ekho-sdk/identity";
import { EkhoConnectorAgent } from "./agent.js";
import { StaticBearerAuthenticator, type Authenticator } from "./auth.js";
import { ConfigError, loadConfig } from "./config.js";
import { CredentialsUnavailableError } from "./credentials.js";
import { createHttpServer } from "./http.js";
import { OAuthServer } from "./oauth.js";
import { WakeNotifier } from "./webhook.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

async function main(): Promise<void> {
  const config = loadConfig();
  const log = console;
  let notifier: WakeNotifier | undefined;
  const agent = new EkhoConnectorAgent({
    relayBaseUrl: config.relayBaseUrl,
    fleetId: config.fleetId,
    enrollmentToken: config.enrollmentToken,
    displayName: config.displayName,
    stateDir: config.stateDir,
    requireSigned: config.requireSigned,
    queueMax: config.queueMax,
    pollIntervalSeconds: config.pollIntervalSeconds,
    heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
    log,
    onNewMessages: (msgs) => notifier?.notify(msgs)
  });
  await agent.connect();
  const pub = agent.identityPublicKeyB64url!;
  log.info(`[ekho-mcp] v${pkg.version} agent=${agent.agentId} identity key_id=${keyId(fromB64url(pub))} public_key=${pub}`);
  log.info("[ekho-mcp] endorse this key from the operator console so peers verify this connector's messages");

  if (config.wakeWebhookUrl && config.wakeWebhookSecret) {
    notifier = new WakeNotifier({ url: config.wakeWebhookUrl, secret: config.wakeWebhookSecret, agentName: config.displayName, debounceMs: config.wakeDebounceMs, log });
    log.info(`[ekho-mcp] wake webhook configured (debounce ${config.wakeDebounceMs} ms)`);
  }

  let authenticator: Authenticator;
  let oauth: OAuthServer | undefined;
  if (config.auth === "oauth") {
    oauth = new OAuthServer({
      stateDir: config.stateDir,
      publicUrl: config.publicUrl!,
      mcpPath: config.mcpPath,
      password: config.oauthPassword!,
      allowedRedirectHosts: config.oauthAllowedRedirectHosts,
      log
    });
    authenticator = oauth.authenticator();
  } else {
    authenticator = new StaticBearerAuthenticator(config.bearer!);
  }

  const server = createHttpServer({ config, agent, authenticator, oauth, notifier, log, version: pkg.version });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  agent.start();
  log.info(`[ekho-mcp] MCP (Streamable HTTP, ${config.auth}) on http://${config.host}:${config.port}${config.mcpPath}; health on /healthz`);

  const shutdown = async (signal: string) => {
    log.info(`[ekho-mcp] ${signal}: shutting down`);
    await agent.stop();
    server.close();
    await notifier?.settle();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(`[ekho-mcp] configuration: ${err.message}`);
  else if (err instanceof IdentityUnavailableError || err instanceof CredentialsUnavailableError) console.error(`[ekho-mcp] REFUSING TO START: ${err.message}`);
  else console.error(`[ekho-mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
