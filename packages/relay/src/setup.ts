import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config";
import { db } from "./db";
import { loadLicense, assertFleetCreationAllowed, getLoadedLicense } from "./license";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function pass(label: string, msg: string) { console.log(`  ${green("✓")} ${bold(label.padEnd(12))} ${msg}`); }
function warn(label: string, msg: string) { console.log(`  ${yellow("!")} ${bold(label.padEnd(12))} ${msg}`); }
function fail(label: string, msg: string) { console.log(`  ${red("✗")} ${bold(label.padEnd(12))} ${msg}`); }

/** Write or replace a single KEY=value line in the repo-root .env file. */
function upsertEnv(key: string, value: string): string {
  const envPath = path.join(process.cwd(), ".env");
  const lines = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf-8").split("\n")
    : [];
  const entry = `${key}=${value}`;
  const idx = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (idx >= 0) {
    lines[idx] = entry;
  } else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(entry);
  }
  fs.writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
  return envPath;
}

/**
 * Ensure a strong operator session secret exists. If one is already configured
 * via the environment we leave it alone; otherwise we generate a random secret
 * and persist it to .env so the relay starts securely without manual steps.
 */
function ensureOperatorSecret() {
  if (config.operatorSessionSecret && config.operatorSessionSecret !== "change-me") {
    pass("Secret", "operator session secret configured");
    return;
  }
  const secret = crypto.randomBytes(32).toString("hex");
  try {
    const envPath = upsertEnv("EKHO_OPERATOR_SESSION_SECRET", secret);
    pass("Secret", `generated and saved to ${dim(envPath)}`);
  } catch (err) {
    warn("Secret", `could not write .env (${err instanceof Error ? err.message : String(err)})`);
    console.log(`    ${dim("Set this before starting:")} EKHO_OPERATOR_SESSION_SECRET=${secret}`);
  }
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => { server.close(); resolve(true); });
    server.listen(port, "127.0.0.1");
  });
}

async function runDoctor() {
  console.log(`\n  ${bold("Ekho Doctor")}\n`);

  // Node version
  const nodeVersion = parseInt(process.version.slice(1), 10);
  if (nodeVersion >= 22) {
    pass("Node", `${process.version}`);
  } else {
    warn("Node", `${process.version} ${dim("(>= 22 recommended)")}`);
  }

  // DB directory
  const dbDir = config.dbPath.replace(/\/[^/]+$/, "");
  if (fs.existsSync(dbDir)) {
    pass("Database", config.dbPath);
  } else {
    warn("Database", `directory ${dbDir} does not exist`);
  }

  // Session secret
  if (config.operatorSessionSecret !== "change-me") {
    pass("Secret", "operator session secret configured");
  } else {
    warn("Secret", `using default ${dim("(set EKHO_OPERATOR_SESSION_SECRET)")}`);
  }

  // Base URL
  if (config.baseUrl) {
    pass("Base URL", config.baseUrl);
  } else {
    warn("Base URL", `not set ${dim("(set EKHO_BASE_URL)")}`);
  }

  // Port availability
  const portAvailable = await checkPort(config.port);
  if (portAvailable) {
    pass("Port", `${config.port} available`);
  } else {
    warn("Port", `${config.port} is in use`);
  }

  // License
  loadLicense();
  const license = getLoadedLicense();
  if (license.tier === "pro") {
    pass("License", `Pro — ${license.org} (expires ${license.expires_at.split("T")[0]})`);
  } else {
    pass("License", `OSS ${dim("(1 fleet, basic policies)")}`);
  }

  console.log("");
}

function runSetup() {
  console.log(`\n  ${bold("Ekho Setup")}\n`);

  loadLicense();
  ensureOperatorSecret();

  const existing = db.findFleetByName("default");
  if (existing) {
    pass("Fleet", `default ${dim("(already initialized)")}`);
    console.log("");
    return;
  }

  // Check license allows fleet creation
  const fleetCount = (db.raw().prepare("SELECT COUNT(*) AS count FROM fleets").get() as { count: number }).count;
  try {
    assertFleetCreationAllowed(fleetCount);
  } catch (err) {
    fail("License", err instanceof Error ? err.message : String(err));
    console.log("");
    process.exit(1);
  }

  const email = process.env.EKHO_BOOTSTRAP_EMAIL ?? "admin@example.com";
  const password = process.env.EKHO_BOOTSTRAP_PASSWORD ?? "changeme123";
  const bootstrap = db.createBootstrap("default", email, password);
  const token = db.issueEnrollmentToken(bootstrap.fleetId, bootstrap.operatorId);

  pass("Fleet", `default ${dim(`(${bootstrap.fleetId})`)}`);
  pass("Operator", email);
  pass("Token", token);
  pass("Relay", config.baseUrl);

  console.log(`\n  ${bold("Next steps:")}`);
  console.log(`    1. ${dim("Start the relay:")}  npm start`);
  console.log(`    2. ${dim("Open the UI:")}      ${config.baseUrl}/ui/`);
  console.log("");
}

if (process.argv.includes("--doctor")) {
  runDoctor();
} else {
  runSetup();
}
