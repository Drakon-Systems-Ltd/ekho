"""Which ``ekho`` copy Hermes loads — asked of Hermes, or not answered at all.

#85 follow-up to #86. The first cut of the shadow check decided the verdict
itself: it read ``plugin.yaml`` with a line parser
(:func:`bundle_identity.plugin_name`) and looked only at ``~/.hermes/plugins``.
Both halves fail in the same direction — a confident PASS about a directory
Hermes never read, and silence about a copy Hermes loads:

* the parser answers ``'>-'`` for a block scalar, ``'!!str ekho'`` for a typed
  one, ``'ek\\u0068o'`` for an escaped one and ``None`` for a portable
  ``plugin.json`` package — four manifests whose key, to Hermes, is ``ekho``;
* ``~/.hermes/plugins`` is not where Hermes looks when ``HERMES_HOME`` points
  elsewhere, and it is not the only place it looks when the box has profiles.

So this module asks Hermes both questions and answers neither on its own.
``hermes_cli.plugins_discovery`` decides which copies exist and which one wins;
``hermes_constants`` decides which directories are in scope. When either import
is unavailable, or the filesystem will not answer a question the verdict rests
on, the result is *undetermined*: the healthcheck WARNs and names the path and
the error, and ``--repair`` moves nothing anywhere. Undetermined is never PASS,
because "I could not look" and "there is nothing here" are the two answers a
shadow check must never conflate.

Nothing here reads a field off a Hermes manifest object beyond the path, and
nothing parses a manifest. That is the rule that ends the stand-in parser.
"""

from __future__ import annotations

import contextlib
import functools
import logging
import os
import stat
import threading
from dataclasses import dataclass
from pathlib import Path

PLUGIN_NAME = "ekho"
# Every filename Hermes will pick a directory up by. The pre-verdict child
# check opens each one that is there and takes a byte out of it: Hermes reads
# their CONTENTS to decide the key, so stat-ing them proves nothing.
MANIFEST_NAMES = ("plugin.yaml", "plugin.yml", "plugin.json")
# Per-harness manifest dirs Hermes refuses to treat as plugins
# (``plugins_discovery._FOREIGN_HARNESS_MANIFEST_DIRS``). Never read there.
FOREIGN_HARNESS_DIRS = frozenset(
    {".claude-plugin", ".codex-plugin", ".cursor-plugin", ".devin-plugin", ".kimi-plugin"}
)
# How far down an exception's ``__cause__``/``__context__`` chain to look for
# the filesystem error underneath it. Hermes wraps a manifest read failure once
# (``AgentPluginError(...) from PermissionError``); this is slack for a wrapper
# of a wrapper and a hard stop for a chain that loops.
MAX_EXCEPTION_CHAIN = 8
# The repair walks every discovered plugin tree looking for a symlink. A plugin
# tree is a few dozen files; past this shared budget the walk stops and the
# answer is "a symlink here cannot be ruled out", which refuses the repair
# exactly as finding one would.
MAX_SYMLINK_WALK_ENTRIES = 50_000

# The sentence that goes with a filesystem non-answer. Not "run the gateway's
# python": that fixes a missing import, and this is a path on this box that
# this user cannot read.
FS_REMEDY = (
    "A directory this check cannot read may hold a copy — or the install another "
    "root reaches through — so nothing is claimed about it and --repair moves "
    "nothing. Make the path readable by the user running this check (the Hermes "
    "gateway's user may not be this one) and re-run."
)


# --- what the filesystem would not say -------------------------------------
#
# A directory that is not there and a directory that would not be READ are
# different answers, and only one of them is safe to read as "nothing here".
# The stdlib's convenience calls erase the difference: ``Path.exists()``,
# ``Path.is_dir()`` and ``os.path.islink()`` all swallow PermissionError and
# answer False — and False is the answer that PERMITS a move. So every
# enumeration and every stat that feeds the verdict or the plan answers in two
# parts: the fact, and why we could not establish it.


def _fs_reason(path, exc: OSError) -> str:
    """What could not be read, and what the filesystem said about it."""
    return f"{path} could not be read ({type(exc).__name__}: {exc})"


def _list_dir(path) -> tuple[tuple[Path, ...], str | None]:
    """``(the entries, why we cannot be sure there are no others)``, sorted.

    A directory that is genuinely not there lists empty and is no reason to
    doubt anything; one that would not be listed is.
    """
    try:
        with os.scandir(path) as entries:
            return tuple(sorted(Path(entry.path) for entry in entries)), None
    except FileNotFoundError:
        return (), None
    except OSError as exc:  # PermissionError, NotADirectoryError, ELOOP, ...
        return (), _fs_reason(path, exc)


def _dir_kind(path) -> tuple[str | None, str | None]:
    """``('dir' | 'other' | 'absent', why we cannot be sure)``."""
    try:
        mode = os.stat(path).st_mode
    except FileNotFoundError:
        return "absent", None
    except OSError as exc:
        return None, _fs_reason(path, exc)
    return ("dir" if stat.S_ISDIR(mode) else "other"), None


def _is_symlink(path) -> tuple[bool, str | None]:
    """``(is it a symlink?, why we cannot be sure)``.

    ``os.lstat`` rather than ``os.path.islink``: False has to mean "this is not
    a link", not "I could not look", because False is what lets the repair move
    it. Genuinely absent is not a link.
    """
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return False, None
    except OSError as exc:
        return False, _fs_reason(path, exc)
    return stat.S_ISLNK(mode), None


def _real_path(path) -> tuple[str, str | None]:
    """``(the path with every symlink resolved, why we cannot be sure)``.

    ``strict=True`` so a component that could not be resolved raises instead of
    being left as written: two entangled trees must not compare unequal because
    of a permission error. A discovered copy that has since gone is a
    filesystem moving under the check, so absence is a problem here too.
    """
    try:
        return os.path.realpath(path, strict=True), None
    except OSError as exc:
        return os.path.realpath(path), _fs_reason(path, exc)


@dataclass(frozen=True)
class Unreadable:
    """A path Hermes' discovery reads and this check could not.

    One of these under a root costs that root its verdict. Not because the dir
    looks like a copy — nothing here can tell, which is the point — but because
    a manifest keyed ``ekho`` may be sitting in it, read by the gateway's user
    and invisible to this one.
    """

    path: Path
    reason: str


def _manifest_read_problem(child: Path) -> str | None:
    """Why one of *child*'s manifest candidates would not be READ — or None.

    ``scan_directory`` picks a child up by asking ``(child / "plugin.yaml")
    .exists()``, then OPENS what it found, and those are two different
    permissions. ``ekho.bak-portable/plugin.json`` at mode 0600 owned by the
    service stats for anyone and opens for nobody but the gateway — so every
    candidate that is there is opened and one byte is taken out of it.

    Absent is the ordinary case and no problem. A candidate that is not a
    regular file is an answer too: nobody reads a directory as a manifest,
    here or there.
    """
    for filename in MANIFEST_NAMES:
        candidate = Path(child) / filename
        try:
            mode = os.stat(candidate).st_mode
        except FileNotFoundError:
            continue
        except OSError as exc:
            return _fs_reason(candidate, exc)
        if not stat.S_ISREG(mode):
            continue
        try:
            with open(candidate, "rb") as handle:
                handle.read(1)
        except OSError as exc:
            return _fs_reason(candidate, exc)
    return None


def unreadable_children(root: Path) -> tuple[Unreadable, ...]:
    """Every direct child of *root* that Hermes reads and this process cannot.

    The children ``scan_directory`` considers, asked the questions it asks —
    lstat the entry, stat what it points at, list it, stat AND READ each
    manifest candidate — with the failures Hermes discards kept instead. Dunder
    and foreign-harness dirs are skipped because Hermes never looks in them.
    """
    children, problem = _list_dir(root)
    if problem:
        return (Unreadable(Path(root), problem),)
    found: list[Unreadable] = []
    for child in children:
        if child.name in FOREIGN_HARNESS_DIRS:
            continue
        if child.name.startswith("__") and child.name.endswith("__"):
            continue
        _linked, problem = _is_symlink(child)  # the entry itself
        if problem is None:
            kind, problem = _dir_kind(child)  # what it points at
            if problem is None and kind != "dir":
                continue  # a file, or gone since the listing: both answers
            if problem is None:
                _entries, problem = _list_dir(child)
            if problem is None:
                problem = _manifest_read_problem(child)
        if problem:
            found.append(Unreadable(child, problem))
    return tuple(found)


def _merge_unreadable(*groups) -> tuple[Unreadable, ...]:
    """One entry per path, in the order they were first reported."""
    merged: dict[str, Unreadable] = {}
    for group in groups:
        for entry in group:
            merged.setdefault(str(entry.path), entry)
    return tuple(merged.values())


# --- where Hermes looks ----------------------------------------------------
#
# Neither answer is guessable from the env var. ``$VAR`` and ``~`` are both
# expanded (``HERMES_HOME=$HOME/.hermes`` read literally is a relative path
# that exists nowhere, and the scan of it comes back clean while the gateway
# loads a backup); a home anywhere under the native ``~/.hermes`` keeps
# ``~/.hermes`` as its root whatever its shape; a custom root is recognised
# only by a ``profiles`` segment. So both come from ``hermes_constants`` — the
# module the gateway itself resolves them with.


@dataclass(frozen=True)
class HermesRoots:
    """The plugins dirs this check covers — or why we cannot name them.

    ``roots`` is one set used for everything: the verdict, the symlink walk and
    the plan, so a shadow in a sibling profile is visible and is protected by
    the same preflight that guards the root it would break.

    Undetermined has the same shape as :class:`Discovery`'s: ``roots`` EMPTY
    and staying that way. No verdict, no repair, and a WARN that says why.
    """

    roots: tuple[Path, ...] = ()
    active: Path | None = None  # ``<home>/plugins`` for the home we run from
    home: Path | None = None  # $HERMES_HOME, as Hermes expands it
    root: Path | None = None  # the containing root, when home is a profile
    undetermined: bool = False
    reason: str | None = None
    remedy: str | None = None


_CONSTANTS_ERROR: BaseException | None = None


@functools.lru_cache(maxsize=1)
def hermes_resolution():
    """Hermes' own home/root resolution, or None when it is not importable.

    ``hermes_constants`` is a *different* import from ``hermes_cli``: a box can
    have one without the other, so the two unavailabilities are tracked apart.
    Only the import is cached — the functions read the environment live, so a
    changed ``HERMES_HOME`` is still honoured.
    """
    global _CONSTANTS_ERROR
    try:
        from hermes_constants import get_default_hermes_root, get_hermes_home
    except Exception as exc:  # noqa: BLE001 — a partial Hermes must not raise out of here
        _CONSTANTS_ERROR = exc
        return None
    return get_hermes_home, get_default_hermes_root


def _resolution_reason() -> str:
    """Why we cannot say where Hermes looks, in the operator's words."""
    if _CONSTANTS_ERROR is None:
        return "hermes_constants not importable"
    return (
        "hermes_constants not importable: "
        f"{type(_CONSTANTS_ERROR).__name__}: {_CONSTANTS_ERROR}"
    )


def hermes_homes() -> tuple[Path | None, Path | None, str | None]:
    """``(active home, containing root, why not)`` — Hermes' own answers."""
    entry_points = hermes_resolution()
    if entry_points is None:
        return None, None, _resolution_reason()
    get_home, get_root = entry_points
    try:
        return Path(get_home()), Path(get_root()), None
    except Exception as exc:  # noqa: BLE001 — a raising resolver is an unknown, not a default
        return None, None, f"hermes_constants raised {type(exc).__name__}: {exc}"


def hermes_roots() -> HermesRoots:
    """Every plugins dir this check covers, from the containing Hermes root.

    ``<root>/plugins`` (always, whether or not it exists yet) — so a check run
    from inside ``profiles/work`` still sees the DEFAULT root, whose
    ``plugins/ekho`` is allowed to be a symlink into this profile's tree —
    every ``<root>/profiles/<name>/plugins/`` that exists, and the active
    home's own ``plugins/`` for the layout where it is neither.

    Building that set is three filesystem questions and each one can fail to
    answer. A genuinely absent ``profiles/`` contributes nothing and is no
    reason to doubt the rest; anything else makes the WHOLE set undetermined,
    because a protective set missing an unknown number of roots is not one.
    """
    home, root, reason = hermes_homes()
    if home is None or root is None:
        return HermesRoots(undetermined=True, reason=reason)
    roots = [root / "plugins"]
    profiles, problem = _list_dir(root / "profiles")
    if problem:
        return HermesRoots(undetermined=True, reason=problem, remedy=FS_REMEDY)
    for profile in profiles:
        kind, problem = _dir_kind(profile)
        if problem:
            return HermesRoots(undetermined=True, reason=problem, remedy=FS_REMEDY)
        if kind != "dir":
            continue  # a stray file beside the profiles is not a profile
        candidate = profile / "plugins"
        kind, problem = _dir_kind(candidate)
        if problem:
            return HermesRoots(undetermined=True, reason=problem, remedy=FS_REMEDY)
        if kind == "dir":
            roots.append(candidate)
    active = home / "plugins"
    if active not in roots:
        roots.append(active)
    return HermesRoots(roots=tuple(roots), active=active, home=home, root=root)


# --- discovery: ask Hermes, or say nothing ---------------------------------


@dataclass(frozen=True)
class Discovery:
    """What Hermes discovers for one plugins root — or why we cannot say.

    Exactly one of two shapes. Hermes answered: ``copies`` and ``winner`` are
    its answer and ``undetermined`` is False. Hermes could not be asked:
    ``copies`` and ``winner`` are EMPTY and stay that way, because nothing else
    here is entitled to fill them in.

    ``unreadable`` is a third thing and rides along with the first shape:
    Hermes answered, for the dirs it and we could read. The answer is complete
    only if it is empty.
    """

    copies: tuple[Path, ...] = ()
    winner: Path | None = None
    # EVERY manifest dir Hermes found here, under any key — not just ours. This
    # is what the repair must not break: ``profiles/work/plugins/security/ekho
    # -> <root>/plugins/ekho.bak-x`` is keyed ``security/ekho``, is not a copy
    # of ours by any test, and dangles the moment that backup moves.
    discovered: tuple[Path, ...] = ()
    undetermined: bool = False
    reason: str | None = None
    remedy: str | None = None
    unreadable: tuple[Unreadable, ...] = ()


_IMPORT_ERROR: BaseException | None = None


@functools.lru_cache(maxsize=1)
def hermes_discovery():
    """Hermes' own discovery entry points, or None when not importable.

    Cached: the import either works in this interpreter or it never will.
    """
    global _IMPORT_ERROR
    try:
        from hermes_cli.plugins_discovery import resolve_manifest_winners, scan_directory
        from hermes_cli.plugins_manifest import manifest_key
    except Exception as exc:  # noqa: BLE001 — a partial hermes_cli must not break the check
        _IMPORT_ERROR = exc
        return None
    return scan_directory, resolve_manifest_winners, manifest_key


def _import_reason() -> str:
    """Why the only path to a verdict is unavailable, in the operator's words."""
    if _IMPORT_ERROR is None:
        return "hermes_cli not importable"
    return f"hermes_cli not importable: {type(_IMPORT_ERROR).__name__}: {_IMPORT_ERROR}"


# ``plugins_discovery`` and ``plugins_manifest`` both log to
# ``hermes_cli.plugins``, which the loader and the dispatcher share, so the
# logger name alone cannot separate our scan from anything else using it.
# ``_DISCOVERY_MODULES`` does: a record is only swallowed when it came out of
# one of the modules we called, on the thread we called it from.
_DISCOVERY_LOGGERS = (
    "hermes_cli.plugins",
    "hermes_cli.plugins_discovery",
    "hermes_cli.plugins_manifest",
    "hermes_cli.agent_plugins",
)
_DISCOVERY_MODULES = frozenset(
    {"plugins_discovery", "plugins_manifest", "agent_plugins", "plugins"}
)


class _Collector(logging.Filter):
    """Swallows our scan's records and keeps them; passes everything else on."""

    def __init__(self) -> None:
        super().__init__()
        self.thread = threading.get_ident()
        self.records: list[logging.LogRecord] = []

    def filter(self, record: logging.LogRecord) -> bool:
        if getattr(record, "module", None) not in _DISCOVERY_MODULES:
            return True
        if record.thread is not None and record.thread != self.thread:
            return True  # a concurrent gateway scan is not ours to silence
        self.records.append(record)
        return False


@contextlib.contextmanager
def _quiet_hermes_logging():
    """Capture, and keep off the console, what Hermes logs while it scans.

    ``scan_directory`` warns about every unreadable dir and unparseable
    manifest it meets — useful to the gateway, noise in a healthcheck that is
    *about* those dirs. Suppressing them is fine; discarding what they SAID is
    how a child Hermes skipped became a clean verdict, so they are kept and
    read by :func:`_unreadable_from_records`. Filters go on the emitting
    loggers themselves (an ancestor's filters never see a child's records).
    """
    collector = _Collector()
    attached = [logging.getLogger(name) for name in _DISCOVERY_LOGGERS]
    for target in attached:
        target.addFilter(collector)
    try:
        yield collector
    finally:
        for target in attached:
            target.removeFilter(collector)


def _os_error_in_chain(exc):
    """The filesystem failure underneath *exc* — or None if there is not one.

    Hermes does not always log the error it met: ``agent_plugins
    ._read_json_object`` turns a PermissionError on ``plugin.json`` into an
    ``AgentPluginError`` — a ValueError — with ``raise ... from exc``, and
    ``plugins_discovery`` logs that wrapper. Judged on the logged object alone
    it is indistinguishable from a manifest that failed schema validation,
    which is an ANSWER, so a directory neither Hermes nor this process could
    read would be recorded as "not a plugin" and the root would come out clean.

    So the chain is walked: ``__cause__`` first, then ``__context__``, bounded
    by :data:`MAX_EXCEPTION_CHAIN` with a seen-set for the cycles
    ``__context__`` can form. FileNotFoundError is not one of these at any
    depth — a manifest that went away mid-scan was discovered by nobody.
    """
    seen: set[int] = set()
    while isinstance(exc, BaseException) and len(seen) < MAX_EXCEPTION_CHAIN:
        if id(exc) in seen:
            return None
        seen.add(id(exc))
        if isinstance(exc, OSError) and not isinstance(exc, FileNotFoundError):
            return exc
        exc = exc.__cause__ if exc.__cause__ is not None else exc.__context__
    return None


def _record_exceptions(record: logging.LogRecord, args) -> list:
    """Every exception this record carries: in its args, and in ``exc_info``.

    Hermes logs the exception as a formatting argument (``"Failed to parse %s:
    %s", path, exc``) and sometimes also attaches it. Both are read, because
    which one is populated is a Hermes-side setting.
    """
    found = [arg for arg in args if isinstance(arg, BaseException)]
    info = record.exc_info
    if isinstance(info, tuple) and len(info) > 1 and isinstance(info[1], BaseException):
        found.append(info[1])
    return found


def _unreadable_from_records(records) -> tuple[Unreadable, ...]:
    """The filesystem failures Hermes met while scanning, kept rather than dropped.

    The test is on the record's arguments rather than its wording, so a
    rephrased log line still counts. A manifest that merely parsed wrong is not
    one of these: there Hermes' answer is "this is not a plugin", which is a
    verdict and not a gap.
    """
    found = []
    for record in records:
        args = record.args if isinstance(record.args, tuple) else (record.args,)
        exc = next(
            (
                underneath
                for underneath in (
                    _os_error_in_chain(candidate)
                    for candidate in _record_exceptions(record, args)
                )
                if underneath is not None
            ),
            None,
        )
        if exc is None:
            continue
        named = next((arg for arg in args if isinstance(arg, (str, os.PathLike))), None)
        path = Path(named or getattr(exc, "filename", None) or "(path not reported)")
        found.append(Unreadable(path, _fs_reason(path, exc)))
    return tuple(found)


def _discover_via_hermes(root: Path, name: str, entry_points, unreadable) -> Discovery:
    """The loader's own verdict for one root: same scan, same winner rule.

    *unreadable* is what our own pre-verdict check already found under this
    root; what Hermes logged while scanning is added to it, because the two see
    different things — a manifest that opened for Hermes' user and not for
    ours, and vice versa.
    """
    scan_directory, resolve_manifest_winners, manifest_key = entry_points
    with _quiet_hermes_logging() as captured:
        manifests = scan_directory(Path(root), "user")
        copies = sorted(
            Path(m.path) for m in manifests if manifest_key(m) == name and m.path
        )
        discovered = sorted({Path(m.path) for m in manifests if m.path})
        won = resolve_manifest_winners(manifests).get(name)
    return Discovery(
        copies=tuple(copies),
        winner=Path(won.path) if won is not None and won.path else None,
        discovered=tuple(discovered),
        unreadable=_merge_unreadable(
            unreadable, _unreadable_from_records(captured.records)
        ),
    )


def discover(root: Path, name: str = PLUGIN_NAME) -> Discovery:
    """Which dirs under *root* claim ``name``, and which one Hermes loads.

    Hermes' own discovery or nothing: if it cannot be imported, or it raises,
    the answer carries no verdict at all.

    The root itself is listed first. ``scan_directory`` answers an unreadable
    directory with an empty list and a log line, which is right for the loader
    — it cannot load what it cannot read — but here it would come out as "no
    ekho copy under <root>", the one sentence that tells an operator to stop
    looking. Its CHILDREN are read before any verdict for the same reason: the
    same empty answer comes back for a single ``plugins/ekho.bak-x`` the
    service owns and this user cannot open, and that is a copy the gateway
    loads.
    """
    entry_points = hermes_discovery()
    if entry_points is None:
        return Discovery(undetermined=True, reason=_import_reason())
    _entries, problem = _list_dir(root)
    if problem:
        return Discovery(undetermined=True, reason=problem, remedy=FS_REMEDY)
    unreadable = unreadable_children(Path(root))
    try:
        return _discover_via_hermes(Path(root), name, entry_points, unreadable)
    except Exception as exc:  # noqa: BLE001 — a scan that dies must not take the check with it
        return Discovery(
            undetermined=True,
            reason=f"Hermes discovery raised {type(exc).__name__}: {exc}",
        )


# --- what a root looks like ------------------------------------------------


@dataclass(frozen=True)
class RootScan:
    """What Hermes would discover for one plugins root."""

    root: Path
    # Hermes' own list of dirs whose key is ours, and the one it loads.
    copies: tuple[Path, ...] = ()
    winner: Path | None = None
    # ``copies`` collapsed by realpath: ``ekho -> ekho-0.5.4`` is ONE install
    # that Hermes happens to find under two names, not a shadow. The entry
    # literally named ``ekho`` represents its group.
    installs: tuple[Path, ...] = ()
    canonical: Path | None = None  # ``<root>/ekho``, when it is one of them
    discovered: tuple[Path, ...] = ()
    undetermined: bool = False
    reason: str | None = None
    remedy: str | None = None
    unreadable: tuple[Unreadable, ...] = ()

    @property
    def shadowed(self) -> bool:
        """True when more than one distinct install declares the key here.

        Whichever sorts last owns it today, and a rename or a fresh backup
        beside it changes that with no other signal.
        """
        return len(self.installs) > 1

    @property
    def shadows(self) -> tuple[Path, ...]:
        """Every install that is not the canonical one — what ``--repair`` moves.

        Empty without a canonical copy, whatever else is here. With one install
        that is simply not called ``ekho``, "everything but the canonical one"
        is the live install itself, and moving it takes the plugin off the box;
        with several, which one to keep is a human's call and
        :func:`no_canonical_refusal` says so.
        """
        if self.canonical is None:
            return ()
        return tuple(p for p in self.installs if p != self.canonical)


def _collapse_by_real(copies, name: str) -> tuple[tuple[Path, ...], tuple[Unreadable, ...]]:
    """Group *copies* by the directory they actually are.

    ``plugins/ekho -> plugins/ekho-0.5.4`` is discovered twice by Hermes and
    loads the same bytes either way; calling that a shadow would fail every
    versioned install. A path that will not resolve is not grouped and not
    dismissed — it becomes an :class:`Unreadable`, which costs the root its
    verdict rather than quietly counting as its own install or as a duplicate.
    """
    by_real: dict[str, Path] = {}
    problems: list[Unreadable] = []
    for path in copies:
        real, problem = _real_path(path)
        if problem:
            problems.append(Unreadable(path, problem))
            continue
        if real not in by_real or path.name == name:
            by_real[real] = path
    return tuple(sorted(by_real.values())), tuple(problems)


def scan_root(root: Path, name: str = PLUGIN_NAME) -> RootScan:
    found = discover(Path(root), name)
    if found.undetermined:
        return RootScan(
            root=Path(root),
            undetermined=True,
            reason=found.reason,
            remedy=found.remedy,
        )
    installs, unresolvable = _collapse_by_real(found.copies, name)
    target = Path(root) / name
    return RootScan(
        root=Path(root),
        copies=found.copies,
        winner=found.winner,
        installs=installs,
        canonical=target if target in installs else None,
        discovered=found.discovered,
        unreadable=_merge_unreadable(found.unreadable, unresolvable),
    )


def scan(roots) -> tuple[RootScan, ...]:
    """One :class:`RootScan` per root, from one pass."""
    return tuple(scan_root(Path(root)) for root in roots)


def dangling_canonical(root: Path, name: str = PLUGIN_NAME) -> tuple[bool, str | None]:
    """``(is <root>/<name> a symlink to nothing?, why we cannot be sure)``.

    Discovery cannot report this: ``scan_directory`` skips a child that is not
    a directory, so the live install pointing at a tree that was deleted looks
    exactly like no install at all — and "not installed here" is the sentence
    that sends the operator to the wrong box.
    """
    target = Path(root) / name
    linked, problem = _is_symlink(target)
    if problem:
        return False, problem
    if not linked:
        return False, None
    kind, problem = _dir_kind(target)
    if problem:
        return False, problem
    return kind != "dir", None


# --- the repair preflight: all roots, or none ------------------------------


def undetermined_refusal(scans) -> str | None:
    """Why no root may be repaired: something was never established.

    Without Hermes' discovery nothing here knows which dirs are copies, let
    alone which one loads, so "move the others" has no others to speak of. The
    roots it DID answer for are refused too: a root it could not read may hold
    the install that reaches into one it could.

    This one outlives an empty plan. Every other preflight answers "is THIS
    move safe" and has nothing to refuse when nothing is moving; this answers
    the prior question — do we know what is on this disk at all — and "no
    shadowing plugin copies to move" is the same false all-clear as a PASS.
    """
    for scan_result in tuple(scans):
        if scan_result.undetermined:
            detail = scan_result.reason or "reason not reported"
            remedy = scan_result.remedy or (
                "Run this check with the python of the venv the Hermes service "
                "uses, where hermes_cli and hermes_constants import."
            )
            return (
                f"cannot tell what Hermes loads under {scan_result.root}: {detail} "
                f"— nothing was moved in any root. {remedy}"
            )
        for entry in scan_result.unreadable:
            return (
                f"{entry.reason}, so the shape of the install under "
                f"{scan_result.root} cannot be established; nothing was moved in "
                f"any root. {FS_REMEDY}"
            )
    return None


def no_canonical_refusal(scans) -> str | None:
    """Why no root may be repaired: one of them is shadowed but has no ``ekho/``.

    Which of several copies is the real install is a human's call, and nothing
    in that root can be moved until they make it. Declining per root would
    still let the OTHER roots be repaired around it, which is not what
    all-or-nothing means: the operator told to choose should find the rest of
    the box as they left it. Like :func:`undetermined_refusal` this outlives an
    empty plan — an unchoosable root contributes nothing to move, and reporting
    "nothing to move" for it is the false all-clear.

    A root with exactly ONE install that is not called ``ekho`` is not this: a
    bare ``plugins/ekho-0.5.4`` is what Hermes loads and there is nothing to
    choose between.
    """
    for scan_result in tuple(scans):
        if scan_result.undetermined or not scan_result.shadowed:
            continue
        if scan_result.canonical is None:
            listed = ", ".join(str(p) for p in scan_result.installs)
            return (
                f"{scan_result.root} has no dir named '{PLUGIN_NAME}' — a human must "
                f"say which of {listed} is the real install; rename it to "
                f"'{PLUGIN_NAME}' and re-run. Nothing was moved in any root"
            )
    return None


def _components_beneath(root: Path, path: Path) -> list[Path]:
    """Every path component from *root* down to *path*, inclusive.

    A copy at ``plugins/cat/ekho`` depends on ``plugins/cat`` as much as on
    itself, and an intermediate component being a link is exactly what
    comparing the two ends' realpaths cannot see.
    """
    try:
        relative = Path(path).relative_to(Path(root))
    except ValueError:
        return [Path(path)]
    walked = []
    current = Path(root)
    for part in relative.parts:
        current = current / part
        walked.append(current)
    return walked


def _symlink_reason(link: Path) -> str:
    try:
        points_at = os.readlink(link)
    except OSError:
        points_at = "(unreadable)"
    return (
        f"{link} is a symlink -> {points_at}: symlinked plugin layouts must be "
        "resolved by hand — a link anywhere in a discovered copy may be what "
        "another root's install reaches through, and moving the copy takes it "
        "away. Nothing was moved in any root"
    )


def _walk_for_symlink(top: Path, budget: int) -> tuple[Path | None, int, str | None]:
    """``(the first symlink at or under *top*, budget left, why we cannot be sure)``.

    ``followlinks=False``, so a symlinked directory is reported where it is met
    and never descended into. Failing to establish that there is no symlink
    here is the same answer, for our purposes, as finding one.
    """
    problems: list[str] = []

    def _note(exc: OSError) -> None:
        problems.append(_fs_reason(getattr(exc, "filename", None) or top, exc))

    seen = 0
    for parent, dirnames, filenames in os.walk(top, followlinks=False, onerror=_note):
        for entry in sorted(dirnames) + sorted(filenames):
            seen += 1
            if seen > budget:
                return None, 0, (
                    f"{top} could not be read to the bottom within "
                    f"{MAX_SYMLINK_WALK_ENTRIES} entries, so a symlink inside it "
                    "cannot be ruled out: resolve the layout by hand. Nothing was "
                    "moved in any root"
                )
            found = Path(parent) / entry
            linked, problem = _is_symlink(found)
            if problem:
                return None, max(budget - seen, 0), f"{problem}. {FS_REMEDY}"
            if linked:
                return found, budget - seen, None
    left = max(budget - seen, 0)
    return None, left, (f"{problems[0]}. {FS_REMEDY}" if problems else None)


def symlink_refusal(scans) -> str | None:
    """Why NO copy in ANY root may be moved — or None when no symlink is in play.

    Endpoint comparisons lose to a link in the MIDDLE:
    ``profiles/work/plugins/ekho -> plugins/ekho.bak-x/forward -> /srv/...``
    shares no realpath with anything and every comparison passes. So this stops
    comparing. Every root, every directory Hermes discovered in it — under ANY
    key, not just ours, because the profile install that reaches into the
    backup is keyed ``security/ekho`` — every path component from the root down
    to it, and every entry in its tree: one symlink anywhere in any of that and
    the repair moves nothing and says where the link is.

    One ``lstat`` in all that which will not answer costs exactly the same:
    ``os.path.islink`` says False to a PermissionError, and False is the answer
    that lets the move happen.
    """
    budget = MAX_SYMLINK_WALK_ENTRIES
    for scan_result in tuple(scans):
        if scan_result.undetermined:
            continue  # refused by undetermined_refusal; no copies to walk
        root = Path(scan_result.root)
        linked, problem = _is_symlink(root)
        if problem:
            return f"{problem}. {FS_REMEDY}"
        if linked:
            return _symlink_reason(root)
        candidates = sorted({*scan_result.copies, *scan_result.discovered})
        for candidate in candidates:
            for component in _components_beneath(root, candidate):
                linked, problem = _is_symlink(component)
                if problem:
                    return f"{problem}. {FS_REMEDY}"
                if linked:
                    return _symlink_reason(component)
            found, budget, unsure = _walk_for_symlink(candidate, budget)
            if found is not None:
                return _symlink_reason(found)
            if unsure:
                return unsure
    return None


def plan_refusal(scans, moving: bool = True) -> str | None:
    """Why the WHOLE plan is refused — or None when every item of it is safe.

    One preflight over one consistent set of scans: Hermes answered for every
    root, every directory it reads there could be read here, every root with
    copies has a canonical one, and no symlink is in play anywhere in anything
    Hermes discovered. First reason wins and refuses the lot.

    *moving* false is an empty plan, and only the refusals that outlive one
    apply: with nothing going anywhere, walking every discovered tree for a
    symlink decides nothing, while "I could not tell" still has to be said.
    """
    scans = tuple(scans)
    refusal = undetermined_refusal(scans) or no_canonical_refusal(scans)
    if refusal or not moving:
        return refusal
    return symlink_refusal(scans)
