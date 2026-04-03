import fs from "node:fs";
import { config } from "./config";
import { db } from "./db";

function runDoctor() {
  const checks = [
    { name: "db directory", ok: fs.existsSync(config.dbPath) || fs.existsSync(config.dbPath.replace(/\/[^/]+$/, "")) },
    { name: "operator session secret configured", ok: config.operatorSessionSecret !== "change-me" },
    { name: "base url set", ok: Boolean(config.baseUrl) }
  ];

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "WARN"} ${check.name}`);
  }
}

function runSetup() {
  const existing = db.findFleetByName("default");
  if (existing) {
    console.log("Ekho is already initialized for fleet 'default'.");
    return;
  }

  const email = process.env.EKHO_BOOTSTRAP_EMAIL ?? "admin@example.com";
  const password = process.env.EKHO_BOOTSTRAP_PASSWORD ?? "changeme123";
  const bootstrap = db.createBootstrap("default", email, password);
  const token = db.issueEnrollmentToken(bootstrap.fleetId, bootstrap.operatorId);

  console.log("Ekho setup complete.");
  console.log(`Fleet: default (${bootstrap.fleetId})`);
  console.log(`Operator email: ${email}`);
  console.log(`Operator password: ${password}`);
  console.log(`Enrollment token: ${token}`);
  console.log(`Relay URL: ${config.baseUrl}`);
  console.log("");
  console.log("Next steps:");
  console.log("1. Start the relay with: npm start");
  console.log("2. Log in via POST /v1/operator/login");
  console.log("3. Enroll an agent via POST /v1/enroll using the token above");
}

if (process.argv.includes("--doctor")) {
  runDoctor();
} else {
  runSetup();
}
