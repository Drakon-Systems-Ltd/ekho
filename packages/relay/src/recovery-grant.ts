/**
 * Host-only entry point for one-off operator-key recovery grants (#93).
 * See src/recovery-grant-cli.ts. Run on the relay host from packages/relay:
 *   npm run recovery-grant -- status --fleet default
 */
import { db } from "./db";
import { run } from "./recovery-grant-cli";

process.exitCode = run(process.argv.slice(2), db);
