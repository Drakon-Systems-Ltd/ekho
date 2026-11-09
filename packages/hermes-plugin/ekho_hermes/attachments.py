"""Attachment upload/download helpers.

Mirrors the OpenClaw plugin's ``attachments.ts``: same mime allowlist, 25 MiB
size cap, per-message count cap, filename sanitization, id-prefixed scoped
paths, and 0600 perms on written bytes. The relay is still authoritative — this
just gives fast, clear local errors and keeps downloaded bytes safe on disk.

Degrades gracefully: if the SDK client lacks ``upload_attachment`` /
``download_attachment`` (older SDK), uploads/downloads are skipped with a log
line rather than raising.
"""

from __future__ import annotations

import base64
import errno
import logging
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger("ekho_hermes.attachments")

# 25 MiB — matches the relay default and the OpenClaw plugin.
ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
# Per-message count cap — matches the relay default.
ATTACHMENT_MAX_PER_MESSAGE = 10

# ext (no dot, lowercased) -> mime. Mirrors the relay's allowlist.
EXT_TO_MIME: Dict[str, str] = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "pdf": "application/pdf",
    "txt": "text/plain",
    "md": "text/markdown",
    "csv": "text/csv",
    "json": "application/json",
}

# Control chars (incl NUL) to strip from filenames: U+0000..U+001F and U+007F.
_CONTROL_CHARS = re.compile("[" + "".join(chr(c) for c in range(0x20)) + chr(0x7F) + "]")


def mime_for_path(file_path: str) -> Optional[str]:
    """Resolve a path's extension to an allowed mime, or ``None``."""
    ext = os.path.splitext(file_path)[1].lower().lstrip(".")
    return EXT_TO_MIME.get(ext)


def sanitize_filename(raw: Any) -> str:
    """Strip directories, control chars, separators, and leading dots.

    Returns a safe basename that cannot traverse directories or smuggle a
    second extension via NUL/CR/LF. Falls back to ``"file"`` if empty. Mirrors
    the relay's ``sanitizeFilename``.
    """
    base = os.path.basename(str(raw if raw is not None else ""))
    cleaned = _CONTROL_CHARS.sub("", base)
    cleaned = cleaned.replace("/", "").replace("\\", "")
    cleaned = re.sub(r"^\.+", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()[:200]
    return cleaned or "file"


def attachments_download_dir() -> str:
    """Absolute scoped dir where ``ekho_inbox`` writes downloaded bytes."""
    from .connection import DEFAULT_CONFIG_DIR

    return os.path.join(DEFAULT_CONFIG_DIR, "attachments")


def attachment_local_path(attachment_id: str, filename: str, base_dir: Optional[str] = None) -> str:
    """On-disk path for a downloaded attachment.

    Prefixes the SERVER-generated id so two attachments sharing a display name
    never collide, and so the sanitized user filename can never escape the
    scoped dir.
    """
    directory = base_dir or attachments_download_dir()
    safe_id = os.path.basename(str(attachment_id if attachment_id is not None else "")) or "att"
    safe_name = sanitize_filename(filename)
    return os.path.join(directory, f"{safe_id}__{safe_name}")


# ekho_send attachments are confined to one operator-chosen outbox directory,
# checked on the real (symlink-resolved) path; the plugin's own identity,
# credential and config files are never attached. Same rules as the OpenClaw
# plugin's ``readUploadFile``.

#: Default outbox, under the home dir: deliberately outside every state dir.
DEFAULT_OUTBOX_DIRNAME = "ekho-outbox"

# Identity/credential/config file names (Hermes + Ekho TS layouts, OpenClaw's
# config), refused wherever they sit — even if someone copies one into the outbox.
_PROTECTED_FILENAMES = frozenset(
    {
        ".ekho-identity.json",
        ".ekho-credentials.json",
        "identity.json",
        "credentials.json",
        "openclaw.json",
    }
)


def _home() -> str:
    return os.path.expanduser("~")


def _expand(path: str) -> str:
    return os.path.expandvars(os.path.expanduser(path))


def resolve_outbox_dir(outbox_dir: Optional[str] = None) -> str:
    """``outbox_dir`` argument → ``EKHO_OUTBOX_DIR`` → ``~/ekho-outbox``."""
    raw = (outbox_dir or "").strip() or (os.environ.get("EKHO_OUTBOX_DIR") or "").strip()
    if raw:
        return os.path.abspath(_expand(raw))
    return os.path.join(_home(), DEFAULT_OUTBOX_DIRNAME)


def _spellings(path: str) -> List[str]:
    """``path`` itself plus its real path, so a symlinked spelling of a
    protected dir is caught either way."""
    absolute = os.path.abspath(path)
    real = os.path.realpath(absolute)
    return [absolute] if real == absolute else [absolute, real]


def _protected_dirs(state_dir: Optional[str]) -> List[str]:
    """The Ekho state dir, the Hermes home and OpenClaw's state/config dir:
    never an upload source, and never allowed to overlap the outbox."""
    from .connection import DEFAULT_CONFIG_DIR

    home = _home()
    dirs = [
        DEFAULT_CONFIG_DIR,
        os.path.join(home, ".hermes"),
        os.path.join(home, ".openclaw"),
    ]
    if state_dir:
        dirs.append(state_dir)
    for var in ("EKHO_STATE_DIR", "HERMES_HOME", "OPENCLAW_STATE_DIR"):
        value = (os.environ.get(var) or "").strip()
        if value:
            dirs.append(_expand(value))
    out: List[str] = []
    for d in dirs:
        for spelling in _spellings(d):
            if spelling not in out:
                out.append(spelling)
    return out


def _is_within(child: str, parent: str) -> bool:
    """True when ``child`` is ``parent`` or anywhere beneath it."""
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:  # different drives (Windows)
        return False


def _overlaps(a: str, b: str) -> bool:
    return _is_within(a, b) or _is_within(b, a)


def _hidden_or_protected(name: str) -> bool:
    return name.startswith(".") or name.lower() in _PROTECTED_FILENAMES


_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_NONBLOCK = getattr(os, "O_NONBLOCK", 0)
_O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)

#: True where the final open can be anchored to an opened outbox directory
#: descriptor (``os.open(..., dir_fd=...)`` with ``O_DIRECTORY`` and
#: ``O_NOFOLLOW``, every POSIX platform CPython supports). Elsewhere the plugin
#: refuses every attachment and opens no file (fail closed).
ANCHORED_OPEN_SUPPORTED = (
    os.open in os.supports_dir_fd and _O_DIRECTORY != 0 and _O_NOFOLLOW != 0
)

#: Refusal text for a host without an anchored open. Names the platform only.
UNANCHORED_PLATFORM_REFUSAL = (
    f"this host ({sys.platform}) cannot anchor the open to the outbox "
    "directory, so no attachment can be sent from it"
)


class _AnchorError(Exception):
    """The open cannot be anchored to the outbox; the caller refuses."""


def _outbox_components(
    outbox: str, outbox_spellings: Sequence[str], candidate: str
) -> Optional[List[str]]:
    """The requested path's components below the outbox spelling it was
    given under, or ``None`` when it is not a strict descendant."""
    under = next((o for o in outbox_spellings if _is_within(candidate, o)), outbox)
    parts = os.path.relpath(candidate, under).split(os.sep)
    if not parts or any(p in ("", os.curdir, os.pardir) or os.sep in p for p in parts):
        return None
    return parts


def _open_inside_outbox(outbox_real: str, parts: Sequence[str]) -> int:
    """Open the leaf for reading, non-blocking and without following a symlink
    at ANY component, walking from the opened outbox directory. Raises the raw
    ``OSError`` (the caller maps ``errno``), or ``_AnchorError`` before opening
    anything where no anchored open exists: there is deliberately no
    open-by-pathname fallback."""
    if not ANCHORED_OPEN_SUPPORTED:
        raise _AnchorError(UNANCHORED_PLATFORM_REFUSAL)
    leaf_flags = os.O_RDONLY | _O_NOFOLLOW | _O_NONBLOCK | _O_CLOEXEC
    dir_flags = os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW | _O_CLOEXEC
    dir_fd = os.open(outbox_real, dir_flags)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, dir_flags, dir_fd=dir_fd)
            os.close(dir_fd)
            dir_fd = nxt
        return os.open(parts[-1], leaf_flags, dir_fd=dir_fd)
    finally:
        os.close(dir_fd)


def read_upload_file(
    file_path: str,
    *,
    outbox_dir: Optional[str] = None,
    state_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """Read + validate a local file for upload.

    The file must sit inside the outbox (see :func:`resolve_outbox_dir`) — a
    relative path is taken relative to it — and its real path must stay there,
    so ``..``, absolute paths elsewhere, outward symlinks and symlinked
    directories are all refused. The outbox itself is refused if it overlaps
    the Ekho/Hermes/OpenClaw state dirs; dotfiles and the trust-file names are
    refused everywhere. Then the extension must map to an allowed mime and the
    size must be within the cap. The open itself is anchored to the outbox
    directory descriptor and follows no symlink at any component (so a symlink
    anywhere beneath the outbox is refused even when it points inside), and
    only a regular file is read: a FIFO or device is refused without blocking.
    Raises ``ValueError`` (the tool surfaces it as a tool-result error) naming
    the outbox but never a symlink target or file contents. Returns
    ``{bytes, mime, filename}``.
    """
    requested = str(file_path if file_path is not None else "")
    shown = sanitize_filename(requested)
    outbox = resolve_outbox_dir(outbox_dir)

    def refuse(why: str) -> ValueError:
        return ValueError(
            f'attachment "{shown}" refused: {why}. ekho_send only attaches files '
            f"from the Ekho outbox directory {outbox} — copy the file there "
            "first, then pass its path (or its name relative to the outbox)."
        )

    mime = mime_for_path(requested)
    if not mime:
        allowed = ", ".join(sorted(EXT_TO_MIME))
        raise ValueError(
            f'attachment "{os.path.basename(requested)}" has an unsupported '
            f"type — allowed: {allowed}"
        )
    if _hidden_or_protected(os.path.basename(requested)):
        raise refuse("hidden files and Ekho/OpenClaw credential files are never attached")

    guarded = _protected_dirs(state_dir)
    outbox_spellings = _spellings(outbox)
    if any(_overlaps(o, g) for o in outbox_spellings for g in guarded):
        raise refuse(
            "the configured outbox overlaps the Ekho, Hermes or OpenClaw state "
            "directory, so no attachment can be sent until it is moved"
        )
    outbox_real = outbox_spellings[-1]

    candidate = os.path.abspath(os.path.join(outbox, requested))
    if not any(_is_within(candidate, o) and candidate != o for o in outbox_spellings):
        raise refuse("it is not inside the outbox")
    if not os.path.lexists(candidate):
        raise refuse("no such file in the outbox")
    # Re-check on the real path: catches symlinks (file or any parent dir) that
    # lead out of the outbox. Deliberately does not say where they lead.
    real = os.path.realpath(candidate)
    if not _is_within(real, outbox_real) or real == outbox_real:
        raise refuse("it resolves to a location outside the outbox")
    if any(_is_within(real, g) for g in guarded):
        raise refuse("it resolves into a protected state directory")
    if any(_hidden_or_protected(part) for part in os.path.relpath(real, outbox_real).split(os.sep)):
        raise refuse("hidden files and Ekho/OpenClaw credential files are never attached")

    # The open walks each path component from an opened outbox directory
    # descriptor, never following a symlink, and opens the leaf non-blocking;
    # fstat then rejects anything that is not a regular file. A host with no
    # anchored open is refused here and no file is opened.
    parts = _outbox_components(outbox, outbox_spellings, candidate)
    if parts is None:
        raise refuse("it is not inside the outbox")
    try:
        fd = _open_inside_outbox(outbox_real, parts)
    except _AnchorError as exc:
        raise refuse(str(exc)) from None
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise refuse("symlinks are never followed inside the outbox") from None
        if exc.errno == errno.ENOENT:
            raise refuse("no such file in the outbox") from None
        raise ValueError(
            f'could not read attachment "{shown}" from the outbox: '
            f"{exc.strerror or 'open failed'}"
        ) from exc
    with os.fdopen(fd, "rb") as fh:
        st = os.fstat(fh.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise refuse("it is not a regular file")
        if st.st_size > ATTACHMENT_MAX_BYTES:
            raise ValueError(
                f'attachment "{shown}" is {st.st_size} bytes, '
                f"over the {ATTACHMENT_MAX_BYTES}-byte cap"
            )
        data = fh.read(ATTACHMENT_MAX_BYTES + 1)
    if len(data) > ATTACHMENT_MAX_BYTES:
        raise ValueError(
            f'attachment "{shown}" is over the {ATTACHMENT_MAX_BYTES}-byte cap'
        )
    return {"bytes": data, "mime": mime, "filename": os.path.basename(requested)}


def _can_upload(client: Any) -> bool:
    return callable(getattr(client, "upload_attachment", None))


def _can_download(client: Any) -> bool:
    return callable(getattr(client, "download_attachment", None))


def upload_paths(
    client: Any,
    paths: Sequence[str],
    *,
    outbox_dir: Optional[str] = None,
    state_dir: Optional[str] = None,
) -> List[str]:
    """Read + upload each local path via the SDK; return attachment ids.

    Validates count + each file locally (outbox boundary included, see
    :func:`read_upload_file`) for a fast, clear error before hitting the wire. If the SDK client can't upload, logs and returns ``[]`` so a send
    still goes through (without attachments).
    """
    paths = [p for p in (paths or []) if p]
    if not paths:
        return []
    if not _can_upload(client):
        logger.warning(
            "Ekho SDK client has no upload_attachment; skipping %d attachment(s)",
            len(paths),
        )
        return []
    if len(paths) > ATTACHMENT_MAX_PER_MESSAGE:
        raise ValueError(
            f"too many attachments ({len(paths)}); max "
            f"{ATTACHMENT_MAX_PER_MESSAGE} per message"
        )

    # Every path passes the boundary checks before anything is uploaded.
    infos = [read_upload_file(path, outbox_dir=outbox_dir, state_dir=state_dir) for path in paths]
    ids: List[str] = []
    for info in infos:
        data_base64 = base64.b64encode(info["bytes"]).decode("ascii")
        result = client.upload_attachment(
            filename=info["filename"],
            mime=info["mime"],
            data_base64=data_base64,
        )
        attachment_id = result.get("id") if isinstance(result, dict) else None
        if attachment_id:
            ids.append(attachment_id)
        else:
            logger.warning("upload_attachment returned no id for %s", info["filename"])
    return ids


def _meta_get(meta: Any, key: str, default: Any = None) -> Any:
    if isinstance(meta, dict):
        return meta.get(key, default)
    return getattr(meta, key, default)


def download_inbox_attachments(
    client: Any,
    messages: Sequence[Any],
    base_dir: Optional[str] = None,
) -> List[List[Dict[str, Any]]]:
    """Download each message's attachments to a scoped local dir.

    Returns a list parallel to ``messages``; each element is the list of local
    attachment descriptors (``id, filename, mime, size_bytes, local_path``) for
    that message. Each download is isolated — one bad/oversize/failed attachment
    is skipped and never fails the whole inbox read. Bytes are written 0600
    under an id-prefixed, sanitized filename (no collisions, no traversal).

    Degrades gracefully: if the SDK can't download, returns empty lists.
    """
    directory = base_dir or attachments_download_dir()
    can_download = _can_download(client)
    dir_ready = False

    def _ensure_dir() -> None:
        nonlocal dir_ready
        if not dir_ready:
            os.makedirs(directory, exist_ok=True)
            try:
                os.chmod(directory, 0o700)
            except OSError:
                pass
            dir_ready = True

    results: List[List[Dict[str, Any]]] = []
    for message in messages:
        metas = (
            message.get("attachments")
            if isinstance(message, dict)
            else getattr(message, "attachments", None)
        ) or []
        local: List[Dict[str, Any]] = []
        for meta in metas:
            attachment_id = _meta_get(meta, "id")
            if not isinstance(attachment_id, str) or not attachment_id:
                continue
            size_bytes = _meta_get(meta, "size_bytes", 0)
            if isinstance(size_bytes, int) and size_bytes > ATTACHMENT_MAX_BYTES:
                continue  # size guard mirrors the upload cap
            filename = sanitize_filename(_meta_get(meta, "filename") or attachment_id)
            local_path = attachment_local_path(attachment_id, filename, directory)
            descriptor = {
                "id": attachment_id,
                "filename": filename,
                "mime": _meta_get(meta, "mime") or "application/octet-stream",
                "size_bytes": size_bytes if isinstance(size_bytes, int) else 0,
                "local_path": local_path,
            }
            if not can_download:
                # No bytes — still surface the metadata so the agent knows an
                # attachment exists, just without a readable file.
                descriptor.pop("local_path", None)
                local.append(descriptor)
                continue
            try:
                if not os.path.exists(local_path):
                    data = client.download_attachment(attachment_id)
                    if not isinstance(data, (bytes, bytearray)):
                        # Some SDKs may return a wrapper; try a ``.bytes`` attr.
                        data = getattr(data, "bytes", None)
                    if not isinstance(data, (bytes, bytearray)):
                        continue
                    if len(data) > ATTACHMENT_MAX_BYTES:
                        continue  # trust decoded length too
                    _ensure_dir()
                    fd = os.open(local_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                    try:
                        with os.fdopen(fd, "wb") as fh:
                            fh.write(data)
                    finally:
                        try:
                            os.chmod(local_path, 0o600)
                        except OSError:
                            pass
                local.append(descriptor)
            except Exception as exc:  # noqa: BLE001 — one bad attachment never fails the read
                logger.debug("attachment %s download failed: %s", attachment_id, exc)
        results.append(local)
    return results
