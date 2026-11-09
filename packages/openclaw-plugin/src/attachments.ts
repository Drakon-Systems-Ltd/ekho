import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveEkhoStateDir, resolveOpenClawStateDir } from "./state-dir.js";

/**
 * Plugin-side attachment helpers. Mirrors the relay's allowlist, size cap, and
 * filename sanitization so the plugin rejects bad inputs locally with a clear
 * tool-result error before hitting the wire (the relay is still authoritative).
 *
 * Kept dependency-free so it bundles cleanly with esbuild (openclaw external).
 */

// 25 MiB — matches the relay default (config.attachmentMaxBytes).
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
// Per-message count cap — matches the relay default (config.attachmentMaxPerMessage).
export const ATTACHMENT_MAX_PER_MESSAGE = 10;

/** ext (no dot, lowercased) -> mime. Mirrors the relay's ATTACHMENT_MIME_ALLOWLIST. */
export const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json"
};

// Control chars (incl NUL) to strip from filenames: U+0000..U+001F and U+007F.
// Built via RegExp/fromCharCode so the source file stays pure-ASCII (no literal
// control bytes), while matching the same range as the relay's sanitizeFilename.
const CONTROL_CHARS = new RegExp(
  "[" + String.fromCharCode(0) + "-" + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + "]",
  "g"
);

/** Resolve a local file path's extension to an allowed mime, or undefined. */
export function mimeForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  return EXT_TO_MIME[ext];
}

/**
 * Strip path separators, control chars, and leading dots; collapse whitespace;
 * cap length. Returns a safe basename that can never traverse directories or
 * smuggle a second extension via NUL/CR/LF. Falls back to "file" if empty.
 * Mirrors the relay's sanitizeFilename.
 */
export function sanitizeFilename(raw: string): string {
  const base = path.basename(String(raw ?? "")); // drops any dir component
  const cleaned = base
    .replace(CONTROL_CHARS, "")                     // control chars incl NUL
    .replace(/[/\\]/g, "")                          // belt-and-braces separators
    .replace(/^\.+/, "")                            // no leading dots (".." / dotfiles)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned || "file";
}

/** Absolute scoped dir where ekho_inbox writes downloaded attachment bytes.
 *  Under the plugin's state dir, not its install dir (#98). */
export function attachmentsDownloadDir(config?: { stateDir?: string }): string {
  return path.join(resolveEkhoStateDir(config), "attachments");
}

/**
 * Local on-disk path for a downloaded attachment. Prefixes the SERVER-generated
 * id so two attachments with the same display name never collide, and so the
 * (sanitized) user filename can never traverse out of the scoped dir.
 */
export function attachmentLocalPath(id: string, filename: string, config?: { stateDir?: string }): string {
  const safeId = path.basename(String(id ?? "")) || "att";
  const safeName = sanitizeFilename(filename);
  return path.join(attachmentsDownloadDir(config), `${safeId}__${safeName}`);
}

// ekho_send attachments are confined to one operator-chosen outbox directory,
// checked on the real (symlink-resolved) path; the plugin's own identity,
// credential and config files are never attached.

/** Default outbox, under the home dir: deliberately outside every state dir. */
export const DEFAULT_OUTBOX_DIRNAME = "ekho-outbox";

/** Identity/credential/config file names (Ekho TS + Hermes layouts, OpenClaw's
 *  config), refused wherever they sit — even if someone copies one into the outbox. */
const PROTECTED_FILENAMES = new Set([
  ".ekho-identity.json",
  ".ekho-credentials.json",
  "identity.json",
  "credentials.json",
  "openclaw.json"
]);

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** `outboxDir` config → EKHO_OUTBOX_DIR → `~/ekho-outbox`. */
export function resolveOutboxDir(config?: { outboxDir?: string }): string {
  const fromConfig = typeof config?.outboxDir === "string" ? config.outboxDir.trim() : "";
  const raw = fromConfig || process.env.EKHO_OUTBOX_DIR?.trim() || "";
  return raw ? path.resolve(expandHome(raw)) : path.join(os.homedir(), DEFAULT_OUTBOX_DIRNAME);
}

/** `p` itself, plus its real path when it exists, so a symlinked spelling of a
 *  protected dir is caught either way. */
function spellings(p: string): string[] {
  const resolved = path.resolve(p);
  try {
    const real = fs.realpathSync(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

/** The plugin state dir, OpenClaw's state/config dir and the Hermes home: never
 *  an upload source, and never allowed to overlap the outbox. */
function protectedDirs(config?: { stateDir?: string }): string[] {
  const home = os.homedir();
  const dirs = [
    resolveEkhoStateDir(config),
    resolveOpenClawStateDir(),
    path.join(home, ".openclaw"),
    path.join(home, ".hermes")
  ];
  for (const v of [process.env.EKHO_STATE_DIR, process.env.OPENCLAW_STATE_DIR, process.env.HERMES_HOME]) {
    const t = v?.trim();
    if (t) dirs.push(expandHome(t));
  }
  return [...new Set(dirs.flatMap(spellings))];
}

/** True when `child` is `parent` or anywhere beneath it. */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

const overlaps = (a: string, b: string) => isWithin(a, b) || isWithin(b, a);

const O = fs.constants;
const O_NOFOLLOW = O.O_NOFOLLOW ?? 0;
const O_NONBLOCK = O.O_NONBLOCK ?? 0;
const O_DIRECTORY = O.O_DIRECTORY ?? 0;

/**
 * True where the final open can be anchored to an opened outbox directory
 * descriptor. Node has no openat(); on Linux the kernel's /proc/self/fd magic
 * links give the same thing (a lookup relative to the directory INODE that is
 * open). Elsewhere the plugin refuses every attachment and opens no file
 * (fail closed).
 */
export const ANCHORED_OPEN_SUPPORTED = process.platform === "linux";

/** Refusal text for a host without an anchored open. Names the platform only. */
export const UNANCHORED_PLATFORM_REFUSAL =
  `this host (${process.platform}) cannot anchor the open to the outbox directory, so no attachment can be sent from it`;

class AnchorError extends Error {}
class OverCap extends Error {}

/** The requested path's components below the outbox spelling it was given under. */
function outboxComponents(outbox: string, outboxSpellings: string[], candidate: string): string[] {
  const under = outboxSpellings.find((o) => isWithin(candidate, o)) ?? outbox;
  const parts = path.relative(under, candidate).split(path.sep);
  if (parts.length === 0 || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new AnchorError("it is not inside the outbox");
  }
  return parts;
}

/** open(2) of a single path component relative to an open directory descriptor. */
function openAt(dirFd: number, name: string, flags: number): number {
  if (name.includes("/") || name === "" || name === "." || name === "..") throw new AnchorError("it is not inside the outbox");
  return fs.openSync(`/proc/self/fd/${dirFd}/${name}`, flags);
}

/**
 * Open the leaf for reading, non-blocking and without following a symlink at
 * ANY component, walking from the opened outbox directory. Throws the raw
 * ErrnoException (caller maps codes) or an AnchorError (caller refuses).
 * Where no anchored open exists it throws before opening anything: there is
 * deliberately no open-by-pathname fallback.
 */
function openInsideOutbox(outboxReal: string, parts: string[]): number {
  if (!ANCHORED_OPEN_SUPPORTED) throw new AnchorError(UNANCHORED_PLATFORM_REFUSAL);
  const leafFlags = O.O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
  const dirFlags = O.O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
  let dirFd = fs.openSync(outboxReal, dirFlags);
  try {
    try {
      fs.readlinkSync(`/proc/self/fd/${dirFd}`);
    } catch {
      throw new AnchorError("this host cannot pin the outbox directory (no /proc/self/fd), so no attachment can be sent");
    }
    for (let i = 0; i < parts.length - 1; i++) {
      const next = openAt(dirFd, parts[i], dirFlags);
      fs.closeSync(dirFd);
      dirFd = next;
    }
    return openAt(dirFd, parts[parts.length - 1], leafFlags);
  } finally {
    fs.closeSync(dirFd);
  }
}

/** Read at most `cap` bytes from fd; throws OverCap once more than that arrives
 *  (a file can grow between fstat and read). */
function readBounded(fd: number, cap: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buf = Buffer.allocUnsafe(Math.min(1024 * 1024, cap - total + 1));
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    total += n;
    if (total > cap) throw new OverCap();
    chunks.push(n === buf.length ? buf : buf.subarray(0, n));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Read a local file for upload. The file must sit inside the outbox (see
 * resolveOutboxDir) — a relative path is taken relative to it — and its real
 * path must stay there, so `..`, absolute paths elsewhere, outward symlinks and
 * symlinked directories are all refused. The outbox itself is refused if it
 * overlaps the plugin/OpenClaw/Hermes state dirs; dotfiles and the trust-file
 * names are refused everywhere. Then the extension must map to an allowed mime
 * and the size must be within the cap. The open itself is anchored to the
 * outbox directory descriptor and follows no symlink at any component (so a
 * symlink anywhere beneath the outbox is refused even when it points inside),
 * and only a regular file is read: a FIFO or device is refused without
 * blocking. Throws a clear Error that names the outbox but never a symlink
 * target or file contents.
 */
export function readUploadFile(
  filePath: string,
  config?: { outboxDir?: string; stateDir?: string }
): { bytes: Buffer; mime: string; filename: string } {
  const requested = String(filePath ?? "");
  const shown = sanitizeFilename(requested);
  const outbox = resolveOutboxDir(config);
  const refuse = (why: string) =>
    new Error(
      `attachment "${shown}" refused: ${why}. ekho_send only attaches files from the Ekho outbox directory ` +
        `${outbox} — copy the file there first, then pass its path (or its name relative to the outbox).`
    );

  const mime = mimeForPath(requested);
  if (!mime) {
    throw new Error(
      `attachment "${path.basename(requested)}" has an unsupported type — allowed: ${Object.keys(EXT_TO_MIME).join(", ")}`
    );
  }
  const isHiddenOrProtected = (name: string) => name.startsWith(".") || PROTECTED_FILENAMES.has(name.toLowerCase());
  if (isHiddenOrProtected(path.basename(requested))) throw refuse("hidden files and Ekho/OpenClaw credential files are never attached");

  const guarded = protectedDirs(config);
  const outboxSpellings = spellings(outbox);
  if (outboxSpellings.some((o) => guarded.some((g) => overlaps(o, g)))) {
    throw refuse("the configured outbox overlaps the Ekho, OpenClaw or Hermes state directory, so no attachment can be sent until it is moved");
  }
  const outboxReal = outboxSpellings[outboxSpellings.length - 1];

  const candidate = path.resolve(outbox, requested);
  if (!outboxSpellings.some((o) => isWithin(candidate, o) && candidate !== o)) {
    throw refuse("it is not inside the outbox");
  }
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw refuse("no such file in the outbox");
  }
  // Re-check on the real path: catches symlinks (file or any parent dir) that
  // lead out of the outbox. Deliberately does not say where they lead.
  if (!isWithin(real, outboxReal) || real === outboxReal) throw refuse("it resolves to a location outside the outbox");
  if (guarded.some((g) => isWithin(real, g))) throw refuse("it resolves into a protected state directory");
  if (path.relative(outboxReal, real).split(path.sep).some(isHiddenOrProtected)) {
    throw refuse("hidden files and Ekho/OpenClaw credential files are never attached");
  }

  // The open walks each path component from an opened outbox directory
  // descriptor, never following a symlink, and opens the leaf non-blocking;
  // fstat then rejects anything that is not a regular file. A host with no
  // anchored open is refused here and no file is opened.
  const parts = outboxComponents(outbox, outboxSpellings, candidate);
  let fd: number;
  try {
    fd = openInsideOutbox(outboxReal, parts);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP" || code === "ENOTDIR") throw refuse("symlinks are never followed inside the outbox");
    if (code === "ENOENT") throw refuse("no such file in the outbox");
    if (err instanceof AnchorError) throw refuse(err.message);
    throw new Error(`could not read attachment "${shown}" from the outbox: ${code ?? "open failed"}`);
  }
  let bytes: Buffer;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw refuse("it is not a regular file");
    if (st.size > ATTACHMENT_MAX_BYTES) {
      throw new Error(`attachment "${shown}" is ${st.size} bytes, over the ${ATTACHMENT_MAX_BYTES}-byte cap`);
    }
    bytes = readBounded(fd, ATTACHMENT_MAX_BYTES);
  } catch (err) {
    if (err instanceof OverCap) throw new Error(`attachment "${shown}" is over the ${ATTACHMENT_MAX_BYTES}-byte cap`);
    throw err;
  } finally {
    fs.closeSync(fd);
  }
  return { bytes, mime, filename: path.basename(requested) };
}
