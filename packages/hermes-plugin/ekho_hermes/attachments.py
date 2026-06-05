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
import logging
import os
import re
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
    return os.path.join(os.path.expanduser("~"), ".hermes", "ekho", "attachments")


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


def read_upload_file(file_path: str) -> Dict[str, Any]:
    """Read + validate a local file for upload.

    Validates the extension maps to an allowed mime and the byte length is
    within the cap. Raises ``ValueError`` on any violation (the tool surfaces it
    as a tool-result error). Returns ``{bytes, mime, filename}``.
    """
    mime = mime_for_path(file_path)
    if not mime:
        allowed = ", ".join(sorted(EXT_TO_MIME))
        raise ValueError(
            f'attachment "{os.path.basename(file_path)}" has an unsupported '
            f"type — allowed: {allowed}"
        )
    try:
        with open(file_path, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        raise ValueError(f'could not read attachment "{file_path}": {exc}') from exc
    if len(data) > ATTACHMENT_MAX_BYTES:
        raise ValueError(
            f'attachment "{os.path.basename(file_path)}" is {len(data)} bytes, '
            f"over the {ATTACHMENT_MAX_BYTES}-byte cap"
        )
    return {"bytes": data, "mime": mime, "filename": os.path.basename(file_path)}


def _can_upload(client: Any) -> bool:
    return callable(getattr(client, "upload_attachment", None))


def _can_download(client: Any) -> bool:
    return callable(getattr(client, "download_attachment", None))


def upload_paths(client: Any, paths: Sequence[str]) -> List[str]:
    """Read + upload each local path via the SDK; return attachment ids.

    Validates count + each file locally for a fast, clear error before hitting
    the wire. If the SDK client can't upload, logs and returns ``[]`` so a send
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

    ids: List[str] = []
    for path in paths:
        info = read_upload_file(path)
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
