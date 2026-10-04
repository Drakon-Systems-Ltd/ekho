import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { CredentialsUnavailableError, IdentityUnavailableError } from "./credentials.js";

/**
 * Where this plugin keeps its durable state (credentials, identity, dead
 * letters, attachment downloads). It used to be the plugin's own install dir,
 * `~/.openclaw/extensions/ekho-adapter/` — which `openclaw plugins update`
 * replaces wholesale, deleting both trust files with it (ekho#98). State now
 * lives under OpenClaw's state root, beside (not inside) the extensions dir.
 */

/** The pre-#98 location: the install dir for local-path / hand-copied installs. */
export const LEGACY_EKHO_DIR = path.join(os.homedir(), ".openclaw", "extensions", "ekho-adapter");

const CREDENTIALS_FILE = ".ekho-credentials.json";
const IDENTITY_FILE = ".ekho-identity.json";

type StatePaths = typeof import("openclaw/plugin-sdk/state-paths");

/**
 * OpenClaw's state root via the host's own resolver, so OPENCLAW_STATE_DIR and
 * the host's legacy-dir rules apply exactly as they do to the host. Loaded with
 * a synchronous require inside try/catch rather than a static import: a host
 * that predates this SDK module (or a loader that cannot resolve it) must fall
 * back, never fail to load the plugin.
 */
function resolveOpenClawStateDir(): string {
  try {
    const statePaths = createRequire(import.meta.url)("openclaw/plugin-sdk/state-paths") as StatePaths;
    const dir = statePaths.resolveStateDir();
    if (typeof dir === "string" && dir.trim()) return dir;
  } catch {
    /* fall through to the default below */
  }
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".openclaw");
}

/** `stateDir` config → EKHO_STATE_DIR → `<OpenClaw state dir>/ekho-adapter`. */
export function resolveEkhoStateDir(config?: { stateDir?: string }): string {
  const fromConfig = typeof config?.stateDir === "string" ? config.stateDir.trim() : "";
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.EKHO_STATE_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(resolveOpenClawStateDir(), "ekho-adapter");
}

type MigrationLog = {
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
};

interface StateFileSpec {
  name: string;
  usable: (data: unknown) => boolean;
  unavailable: (message: string) => Error;
}

// Same acceptance rules the loaders apply (storedCredentialsState /
// loadOrCreateIdentity): a file they would refuse is not worth migrating.
const STATE_FILES: StateFileSpec[] = [
  {
    name: CREDENTIALS_FILE,
    usable: (d) =>
      !!d && typeof (d as Record<string, unknown>).agentId === "string" &&
      typeof (d as Record<string, unknown>).secret === "string",
    unavailable: (message) => new CredentialsUnavailableError(message)
  },
  {
    name: IDENTITY_FILE,
    usable: (d) => !!d && !!(d as Record<string, unknown>).seedHex,
    unavailable: (message) => new IdentityUnavailableError(message, "unreadable")
  }
];

function readUsable(filePath: string, spec: StateFileSpec): boolean {
  try {
    return spec.usable(JSON.parse(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return false;
  }
}

// Per-process: a caller may run the migration on every connect attempt, and
// "legacy state still exists" is worth saying once, not on every retry.
const warnedLegacy = new Set<string>();

/**
 * Copy pre-#98 state files from `legacyDir` into `newDir`, once, before
 * anything reads `newDir`. Copy, never move: the legacy files stay put, so a
 * rollback to an older plugin build still finds them.
 *
 * Per file: new dir present → it wins, untouched. Legacy usable and new absent
 * → copied (0600). Legacy present but unusable and new absent → throws the
 * loaders' own Unavailable error rather than leaving the new dir empty, where
 * an empty dir would read as a first enrolment and mint. Idempotent.
 */
export function migrateLegacyEkhoState(newDir: string, legacyDir: string, log?: MigrationLog): void {
  if (path.resolve(newDir) === path.resolve(legacyDir)) return;

  // Every file gets its chance before anything throws; a credentials failure
  // is reported ahead of an identity one (it stops the connect outright).
  const failures: Error[] = [];
  for (const spec of STATE_FILES) {
    const legacyPath = path.join(legacyDir, spec.name);
    const newPath = path.join(newDir, spec.name);
    if (!fs.existsSync(legacyPath)) continue;

    if (fs.existsSync(newPath)) {
      const key = `${legacyPath}\0${newPath}`;
      if (!warnedLegacy.has(key)) {
        warnedLegacy.add(key);
        log?.warn?.(
          `[ekho] legacy ${spec.name} still exists at ${legacyDir} and is no longer used; the copy in ${newDir} is authoritative`
        );
      }
      continue;
    }

    if (!readUsable(legacyPath, spec)) {
      failures.push(
        spec.unavailable(
          `[ekho] legacy state file ${legacyPath} is present but unusable and ${newPath} does not exist; ` +
            `refusing to migrate it or to start without it. Restore ${spec.name} from a backup into ${newDir}.`
        )
      );
      continue;
    }

    try {
      copyNoClobber(legacyPath, newPath, newDir, spec);
    } catch (err) {
      failures.push(err as Error);
      continue;
    }
    // Copied this run: the legacy file is expected to still be there, so the
    // "no longer used" note on a later call in this process is just noise.
    warnedLegacy.add(`${legacyPath}\0${newPath}`);
    log?.info?.(`[ekho] migrated ${spec.name} from ${legacyDir} to ${newDir} (legacy copy left in place)`);
  }

  if (failures.length) {
    throw failures.find((e) => e instanceof CredentialsUnavailableError) ?? failures[0];
  }
}

/**
 * Copy via a sibling temp file, validated before it becomes visible, then
 * hard-link it into place: the link fails if the target appeared meanwhile
 * (another process sharing the dir), so a newer file is never overwritten and
 * no reader ever sees a half-written one.
 */
function copyNoClobber(src: string, dest: string, destDir: string, spec: StateFileSpec): void {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const tmp = `${dest}.migrate-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(tmp, 0o600);
    if (!readUsable(tmp, spec)) {
      throw spec.unavailable(`[ekho] copy of ${src} did not read back as valid state; nothing was migrated`);
    }
    try {
      fs.linkSync(tmp, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return; // someone else got there first: theirs wins
      // No hard links on this filesystem: exclusive copy keeps the no-clobber rule.
      try {
        fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL);
      } catch (copyErr) {
        if ((copyErr as NodeJS.ErrnoException).code === "EEXIST") return;
        throw copyErr;
      }
      fs.chmodSync(dest, 0o600);
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
}
