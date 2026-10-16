/**
 * Usage text for the recovery-grant CLI (#93), kept apart from
 * recovery-grant-cli.ts with no imports at all, so the entry file can answer
 * `--help` without loading ./db, which opens and migrates the database on
 * import (#130). The two TTL figures must equal RECOVERY_GRANT_DEFAULT_TTL_MINUTES
 * and RECOVERY_GRANT_MAX_TTL_MINUTES in db.ts; cli-help-gate.test.ts at the
 * repo root asserts that they do.
 */
export const USAGE_DEFAULT_TTL_MINUTES = 30;
export const USAGE_MAX_TTL_MINUTES = 120;

export const USAGE = `Usage (on the relay host, from packages/relay):
  npm run recovery-grant -- status --fleet <fleet id or name>
  npm run recovery-grant -- arm --fleet <fleet id or name> --endorser <key id> --successor <key id> \\
      --confirmed-by "<who confirmed, how, when>" [--ttl-minutes ${USAGE_DEFAULT_TTL_MINUTES}]
  npm run recovery-grant -- cancel --fleet <fleet id or name> --grant <grant id>

A grant lets <endorser> endorse <successor> (an operator key, never an agent key)
exactly once, within --ttl-minutes (default ${USAGE_DEFAULT_TTL_MINUTES}, max ${USAGE_MAX_TTL_MINUTES}).`;

/** True when argv (after the script name) asks for help: the first word is help, --help or -h. */
export function isHelpRequest(argv: string[]): boolean {
  const command = argv[0];
  return command === "help" || command === "--help" || command === "-h";
}
