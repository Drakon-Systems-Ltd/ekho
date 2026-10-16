/**
 * Host-only entry point for one-off operator-key recovery grants (#93).
 * See src/recovery-grant-cli.ts. Run on the relay host from packages/relay:
 *   npm run recovery-grant -- status --fleet default
 *
 * Help is answered before ./db is loaded: importing it opens, creates and
 * migrates the database, which asking for usage must never do (#130).
 */
import { isHelpRequest, USAGE } from "./recovery-grant-usage";

const argv = process.argv.slice(2);
if (isHelpRequest(argv)) {
  console.log(USAGE);
  process.exitCode = 0;
} else {
  void Promise.all([import("./db"), import("./recovery-grant-cli")]).then(([{ db }, { run }]) => {
    process.exitCode = run(argv, db);
  });
}
