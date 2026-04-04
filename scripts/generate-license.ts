#!/usr/bin/env npx tsx
/**
 * Ekho License Key Generator
 *
 * Generates signed Pro license JWTs for distribution to customers.
 * The private key must be kept secret — never commit it to the repo.
 *
 * Usage:
 *   npx tsx scripts/generate-license.ts --org "Acme Corp" --fleets 10 --expires 2027-04-01
 *   npx tsx scripts/generate-license.ts --org "Acme Corp" --fleets 5 --features multi_fleet,advanced_policies,analytics
 *   npx tsx scripts/generate-license.ts --generate-keypair
 *
 * Options:
 *   --generate-keypair          Generate a new RSA-2048 keypair and print paths
 *   --private-key <path>        Path to PEM private key (default: ~/.ekho/license-private-key.pem)
 *   --org <name>                Organisation name (required)
 *   --fleets <number>           Max fleet count (default: 10)
 *   --features <csv>            Comma-separated feature list (default: multi_fleet,advanced_policies,analytics)
 *   --expires <YYYY-MM-DD>      Expiry date (default: 1 year from now)
 *   --output <path>             Write license to file instead of stdout
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PRIVATE_KEY_PATH = path.join(process.env.HOME ?? "~", ".ekho", "license-private-key.pem");
const PUBLIC_KEY_PATH = path.join(__dirname, "..", "packages", "relay", "src", "license-public-key.pem");

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

function generateKeypair() {
  const keyDir = path.dirname(DEFAULT_PRIVATE_KEY_PATH);
  fs.mkdirSync(keyDir, { recursive: true });

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  fs.writeFileSync(DEFAULT_PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_PATH, publicKey);

  console.log("\n  Keypair generated:\n");
  console.log(`  Private key: ${DEFAULT_PRIVATE_KEY_PATH}`);
  console.log(`  Public key:  ${PUBLIC_KEY_PATH}`);
  console.log("\n  The public key has been written to the relay source.");
  console.log("  The private key is in ~/.ekho/ — keep it secret.\n");
}

function generateLicense(args: Record<string, string>) {
  const org = args.org;
  if (!org) {
    console.error("Error: --org is required");
    process.exit(1);
  }

  const privateKeyPath = args["private-key"] ?? DEFAULT_PRIVATE_KEY_PATH;
  if (!fs.existsSync(privateKeyPath)) {
    console.error(`Error: Private key not found at ${privateKeyPath}`);
    console.error("Run with --generate-keypair first, or specify --private-key <path>");
    process.exit(1);
  }

  const privateKey = fs.readFileSync(privateKeyPath, "utf-8");
  const maxFleets = parseInt(args.fleets ?? "10", 10);
  const features = (args.features ?? "multi_fleet,advanced_policies,analytics").split(",").map((s) => s.trim());

  const now = new Date();
  const defaultExpiry = new Date(now);
  defaultExpiry.setFullYear(defaultExpiry.getFullYear() + 1);
  const expiresAt = args.expires ? new Date(`${args.expires}T23:59:59.000Z`) : defaultExpiry;

  const payload = {
    tier: "pro",
    org,
    max_fleets: maxFleets,
    features,
    issued_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  const header = base64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64urlEncode(JSON.stringify(payload));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  const signature = base64urlEncode(signer.sign(privateKey));
  const token = `${header}.${body}.${signature}`;

  if (args.output) {
    fs.writeFileSync(args.output, token);
    console.log(`\n  License written to ${args.output}\n`);
  } else {
    console.log("\n  License key:\n");
    console.log(`  ${token}`);
  }

  console.log("\n  Payload:");
  console.log(`    Org:      ${payload.org}`);
  console.log(`    Tier:     ${payload.tier}`);
  console.log(`    Fleets:   ${payload.max_fleets}`);
  console.log(`    Features: ${payload.features.join(", ")}`);
  console.log(`    Issued:   ${payload.issued_at}`);
  console.log(`    Expires:  ${payload.expires_at}`);
  console.log("");
}

const args = parseArgs(process.argv);

if (args["generate-keypair"]) {
  generateKeypair();
} else {
  generateLicense(args);
}
