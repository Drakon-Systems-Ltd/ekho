/**
 * One-shot orchestrator for the writer/reviewer demo.
 *
 * Spawns the reviewer first, waits for it to enroll and announce its
 * agent_id via IPC, then spawns the writer with that agent_id in its
 * environment. Both processes exit cleanly once the conversation completes.
 *
 * Usage:
 *   EKHO_FLEET_ID=flt_... \
 *   EKHO_WRITER_TOKEN=... \
 *   EKHO_REVIEWER_TOKEN=... \
 *   npm run example:writer-reviewer
 */

import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { colour } from "./shared";

type ReadyMessage =
  | { type: "writer_ready"; agentId: string }
  | { type: "reviewer_ready"; agentId: string };

function fatal(msg: string): never {
  console.error(colour.error(`[run] ${msg}`));
  process.exit(1);
}

function printBanner() {
  const hr = colour.dim("─".repeat(68));
  console.log("");
  console.log(hr);
  console.log(`  ${colour.bold("Ekho example: writer  →  reviewer")}`);
  console.log(colour.dim("  A writer agent drafts an article; a reviewer agent critiques it."));
  console.log(hr);
  console.log("");
}

function checkPrereqs() {
  const missing: string[] = [];
  if (!process.env.EKHO_FLEET_ID) missing.push("EKHO_FLEET_ID");
  if (!process.env.EKHO_WRITER_TOKEN) missing.push("EKHO_WRITER_TOKEN");
  if (!process.env.EKHO_REVIEWER_TOKEN) missing.push("EKHO_REVIEWER_TOKEN");

  if (missing.length === 0) return;

  console.error(colour.error(colour.bold("Missing environment variables: ")) + missing.join(", "));
  console.error("");
  console.error(colour.bold("How to get them:"));
  console.error("");
  console.error("  1. Start the relay in a separate terminal:");
  console.error(colour.dim("       npm install && npm run build && npm run setup && npm start"));
  console.error("");
  console.error("  2. The `npm run setup` output prints your fleet id and a first enrollment token.");
  console.error("     You need " + colour.bold("two") + " enrollment tokens (one per agent).");
  console.error("");
  console.error("  3. Generate a second token via the operator console at");
  console.error(colour.dim("       http://localhost:4000/ui/"));
  console.error("     (sign in as admin@example.com with the password `npm run setup` printed,");
  console.error("      then Agents → Enroll Agent),");
  console.error("     or via the API:");
  console.error(colour.dim("       curl -X POST http://localhost:4000/v1/operator/enrollment-tokens \\"));
  console.error(colour.dim("            -H \"authorization: Bearer <operator_token>\""));
  console.error("");
  console.error("  4. Export the values and re-run:");
  console.error(colour.dim("       export EKHO_FLEET_ID=flt_..."));
  console.error(colour.dim("       export EKHO_WRITER_TOKEN=..."));
  console.error(colour.dim("       export EKHO_REVIEWER_TOKEN=..."));
  console.error(colour.dim("       npm run example:writer-reviewer"));
  console.error("");
  process.exit(1);
}

function spawnAgent(script: string, env: NodeJS.ProcessEnv): ChildProcess {
  const scriptPath = path.join(__dirname, script);
  return fork(scriptPath, [], {
    env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    // Run TypeScript directly via tsx's loader.
    execArgv: ["--import", "tsx"]
  });
}

function waitForReady(child: ChildProcess, expected: ReadyMessage["type"], timeoutMs = 15000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("message", onMessage);
      reject(new Error(`timed out waiting for ${expected}`));
    }, timeoutMs);

    function onMessage(raw: unknown) {
      const msg = raw as ReadyMessage;
      if (msg && msg.type === expected && msg.agentId) {
        clearTimeout(timer);
        child.removeListener("message", onMessage);
        resolve(msg.agentId);
      }
    }

    child.on("message", onMessage);
  });
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  printBanner();
  checkPrereqs();

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    EKHO_RELAY_URL: process.env.EKHO_RELAY_URL ?? "http://127.0.0.1:4000"
  };

  // 1. Spawn the reviewer and wait for its agent_id.
  console.log(colour.relay("[run]      starting reviewer..."));
  const reviewer = spawnAgent("reviewer.ts", baseEnv);

  let reviewerAgentId: string;
  try {
    reviewerAgentId = await waitForReady(reviewer, "reviewer_ready");
  } catch (err) {
    reviewer.kill();
    fatal(
      `reviewer failed to enroll: ${(err as Error).message}. ` +
        "Check EKHO_REVIEWER_TOKEN and that the relay is running."
    );
  }
  console.log(colour.relay(`[run]      reviewer ready as ${colour.bold(reviewerAgentId)}`));

  // 2. Spawn the writer with the reviewer's agent_id in env.
  console.log(colour.relay("[run]      starting writer..."));
  const writer = spawnAgent("writer.ts", { ...baseEnv, EKHO_REVIEWER_AGENT_ID: reviewerAgentId });

  try {
    const writerAgentId = await waitForReady(writer, "writer_ready");
    console.log(colour.relay(`[run]      writer ready as ${colour.bold(writerAgentId)}`));
  } catch (err) {
    writer.kill();
    reviewer.kill();
    fatal(
      `writer failed to enroll: ${(err as Error).message}. ` +
        "Check EKHO_WRITER_TOKEN and that the relay is running."
    );
  }

  // 3. Wait for both processes to exit.
  const [writerCode, reviewerCode] = await Promise.all([waitForExit(writer), waitForExit(reviewer)]);
  const ok = writerCode === 0 && reviewerCode === 0;

  console.log("");
  console.log(
    ok
      ? colour.success(colour.bold("Demo complete."))
      : colour.error(colour.bold(`Demo failed (writer=${writerCode}, reviewer=${reviewerCode}).`))
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(colour.error("[run] fatal:"), err);
  process.exit(1);
});
