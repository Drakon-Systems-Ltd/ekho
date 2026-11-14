"""The identity file is never silently replaced and never observed torn.

Synthetic fixtures only. The contracts: a present file that cannot be read as
an identity is kept and refused, a save replaces the file only through a
complete sibling, and a reader always sees a complete identity.
"""

from __future__ import annotations

import json
import os
import stat
import threading

import pytest

from ekho_hermes import credentials as creds_mod
from ekho_hermes.credentials import (
    ALLOW_NEW_IDENTITY_ENV,
    EkhoIdentity,
    IdentityUnavailableError,
    load_or_create_identity,
    save_identity,
    should_allow_new_identity,
)

SEED = "11" * 32
PINS = {"kid-a": "pub-a", "kid-b": "pub-b"}
TOMBSTONES = {"kid-dead": "2026-10-01T00:00:00Z"}
ADMISSIONS = {"kid-a": {"admitted_by": "tofu", "admitted_at": "2026-10-01T00:00:00Z"}}


def _write_full_identity(tmp_path) -> bytes:
    ident = EkhoIdentity(
        seed_hex=SEED,
        pinned_operator_keys=dict(PINS),
        tofu_at="2026-10-01T00:00:00Z",
        revoked_operator_keys=dict(TOMBSTONES),
        operator_key_admissions=dict(ADMISSIONS),
        extra={"future_field": {"x": 1}},
    )
    save_identity(str(tmp_path), ident)
    return (tmp_path / "identity.json").read_bytes()


def _unusable_copies(tmp_path):
    return sorted(p for p in tmp_path.iterdir() if ".unusable-" in p.name)


def _tmp_leftovers(tmp_path):
    return sorted(p for p in tmp_path.iterdir() if ".tmp-" in p.name)


# --- present but unusable: refuse, preserve, never regenerate ----------------


@pytest.mark.parametrize(
    "corrupt",
    [
        pytest.param(b"", id="empty"),
        pytest.param(b"{\"seed_hex\": \"" + SEED.encode()[:20], id="truncated-mid-string"),
        pytest.param(b"{}", id="json-without-seed"),
        pytest.param(b"[]", id="json-list-not-object"),
        pytest.param(b"null", id="json-null"),
        pytest.param(json.dumps({"seed_hex": "zz" * 32}).encode(), id="seed-not-hex"),
        pytest.param(json.dumps({"seed_hex": "11" * 16}).encode(), id="seed-wrong-length"),
        pytest.param(json.dumps({"seed_hex": 12345}).encode(), id="seed-not-a-string"),
        pytest.param(b"\xff\xfe\x00garbage\x80", id="not-utf8"),
    ],
)
def test_unusable_identity_file_is_refused_and_kept(tmp_path, corrupt):
    path = tmp_path / "identity.json"
    path.write_bytes(corrupt)

    with pytest.raises(IdentityUnavailableError) as excinfo:
        load_or_create_identity(str(tmp_path))

    assert excinfo.value.reason == "unreadable"
    # The original bytes are exactly where they were: nothing minted over them.
    assert path.read_bytes() == corrupt
    # And a byte-exact forensic copy sits beside them, owner-only.
    copies = _unusable_copies(tmp_path)
    assert len(copies) == 1
    assert copies[0].read_bytes() == corrupt
    assert stat.S_IMODE(copies[0].stat().st_mode) == 0o600
    assert excinfo.value.preserved_path == copies[0]
    # A second attempt still refuses — refusal is not a one-shot.
    with pytest.raises(IdentityUnavailableError):
        load_or_create_identity(str(tmp_path))
    assert path.read_bytes() == corrupt


def test_truncated_identity_keeps_pins_and_tombstones_recoverable(tmp_path):
    """A torn file loses nothing: restore the bytes and every pin, the TOFU
    latch, every tombstone and unknown fields come back."""
    full = _write_full_identity(tmp_path)
    path = tmp_path / "identity.json"
    torn = full[: len(full) // 2]
    path.write_bytes(torn)

    with pytest.raises(IdentityUnavailableError):
        load_or_create_identity(str(tmp_path))
    assert path.read_bytes() == torn  # untouched

    path.write_bytes(full)  # operator restores from backup
    back = load_or_create_identity(str(tmp_path))
    assert back.seed_hex == SEED
    assert back.pinned_operator_keys == PINS
    assert back.tofu_at == "2026-10-01T00:00:00Z"
    assert back.revoked_operator_keys == TOMBSTONES
    assert back.operator_key_admissions == ADMISSIONS
    assert back.extra == {"future_field": {"x": 1}}
    assert _unusable_copies(tmp_path)  # the torn copy is still there for forensics


def test_dangling_symlink_is_present_but_unusable(tmp_path):
    path = tmp_path / "identity.json"
    path.symlink_to(tmp_path / "does-not-exist.json")
    with pytest.raises(IdentityUnavailableError) as excinfo:
        load_or_create_identity(str(tmp_path))
    assert excinfo.value.reason == "unreadable"
    assert path.is_symlink()  # not replaced by a minted file
    assert not (tmp_path / "does-not-exist.json").exists()


def test_refusal_never_regenerates_even_with_allow_create(tmp_path):
    """allow_create governs an ABSENT file only. A present-but-unusable file is
    refused regardless: the flag is "mint a new agent key", not "overwrite
    whatever is there"."""
    path = tmp_path / "identity.json"
    path.write_bytes(b"not json")
    with pytest.raises(IdentityUnavailableError):
        load_or_create_identity(str(tmp_path), allow_create=True)
    assert path.read_bytes() == b"not json"


# --- absent file: mint only when allowed ------------------------------------


def test_absent_file_mints_on_first_enrolment(tmp_path):
    ident = load_or_create_identity(str(tmp_path))
    assert len(bytes.fromhex(ident.seed_hex)) == 32
    assert (tmp_path / "identity.json").exists()


def test_absent_file_refused_for_enrolled_agent(tmp_path):
    with pytest.raises(IdentityUnavailableError) as excinfo:
        load_or_create_identity(str(tmp_path), allow_create=False)
    assert excinfo.value.reason == "missing"
    assert not (tmp_path / "identity.json").exists()
    assert list(tmp_path.iterdir()) == []  # nothing written at all


@pytest.mark.parametrize(
    "env,stored,config,expected",
    [
        ({}, False, False, True),  # fresh enrolment: mint
        ({}, True, False, False),  # token-enrolled: credentials.json exists
        ({}, False, True, False),  # agent_id + secret in config
        ({ALLOW_NEW_IDENTITY_ENV: "1"}, True, False, True),  # operator says so
        ({ALLOW_NEW_IDENTITY_ENV: "1"}, False, True, True),
        ({ALLOW_NEW_IDENTITY_ENV: "true"}, True, False, False),  # exactly "1"
        ({ALLOW_NEW_IDENTITY_ENV: "0"}, True, False, False),
    ],
)
def test_should_allow_new_identity_rule(env, stored, config, expected):
    assert (
        should_allow_new_identity(
            env, has_stored_credentials=stored, has_config_credentials=config
        )
        is expected
    )


# --- atomic save ------------------------------------------------------------


def test_save_is_atomic_when_rename_fails(tmp_path, monkeypatch):
    full = _write_full_identity(tmp_path)
    path = tmp_path / "identity.json"

    def boom(src, dst):
        raise OSError("simulated rename failure")

    monkeypatch.setattr(creds_mod.os, "replace", boom)
    ident = load_or_create_identity(str(tmp_path))
    ident.pinned_operator_keys["kid-new"] = "pub-new"
    with pytest.raises(OSError):
        save_identity(str(tmp_path), ident)

    assert path.read_bytes() == full  # previous complete file untouched
    assert _tmp_leftovers(tmp_path) == []  # temp cleaned up


def test_save_never_truncates_the_live_file_mid_write(tmp_path, monkeypatch):
    """Fail half-way through writing. The previous complete file is intact."""
    full = _write_full_identity(tmp_path)
    path = tmp_path / "identity.json"
    real_write = os.write
    state = {"calls": 0}

    def failing_write(fd, data):
        state["calls"] += 1
        if state["calls"] == 1:
            raise OSError("simulated disk full")
        return real_write(fd, data)

    monkeypatch.setattr(creds_mod.os, "write", failing_write)
    ident = load_or_create_identity(str(tmp_path))
    ident.pinned_operator_keys["kid-new"] = "pub-new"
    with pytest.raises(OSError):
        save_identity(str(tmp_path), ident)

    assert path.read_bytes() == full
    assert _tmp_leftovers(tmp_path) == []
    assert load_or_create_identity(str(tmp_path)).pinned_operator_keys == PINS


def test_save_fsyncs_the_temp_file_before_rename(tmp_path, monkeypatch):
    order = []
    real_fsync, real_replace = os.fsync, os.replace

    def spy_fsync(fd):
        order.append(("fsync", os.fstat(fd).st_mode & stat.S_IFMT(0o170000)))
        return real_fsync(fd)

    def spy_replace(src, dst):
        order.append(("replace", str(src), str(dst)))
        return real_replace(src, dst)

    monkeypatch.setattr(creds_mod.os, "fsync", spy_fsync)
    monkeypatch.setattr(creds_mod.os, "replace", spy_replace)
    save_identity(str(tmp_path), EkhoIdentity(seed_hex=SEED))

    kinds = [e[0] for e in order]
    assert "fsync" in kinds and "replace" in kinds
    # A regular-file fsync happens before the rename; the dir fsync after.
    first_file_fsync = next(i for i, e in enumerate(order) if e[0] == "fsync" and e[1] == stat.S_IFREG)
    replace_at = kinds.index("replace")
    assert first_file_fsync < replace_at
    assert any(e[0] == "fsync" and e[1] == stat.S_IFDIR for e in order[replace_at:])
    src = order[replace_at][1]
    assert ".tmp-" in src and src.startswith(str(tmp_path / "identity.json"))


def test_save_permissions_and_no_leftovers(tmp_path):
    save_identity(str(tmp_path), EkhoIdentity(seed_hex=SEED))
    path = tmp_path / "identity.json"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o700
    assert _tmp_leftovers(tmp_path) == []
    assert sorted(p.name for p in tmp_path.iterdir()) == ["identity.json"]


def test_temp_file_is_created_owner_only_from_the_start(tmp_path, monkeypatch):
    """The seed must never be briefly world-readable in the temp file either."""
    real_open = os.open
    seen = {}

    def spy_open(p, flags, mode=0o777, *a, **k):
        fd = real_open(p, flags, mode, *a, **k)
        if ".tmp-" in str(p):
            seen["flags"], seen["mode"] = flags, stat.S_IMODE(os.fstat(fd).st_mode)
        return fd

    monkeypatch.setattr(creds_mod.os, "open", spy_open)
    save_identity(str(tmp_path), EkhoIdentity(seed_hex=SEED))
    assert seen["mode"] == 0o600
    assert seen["flags"] & os.O_EXCL  # exclusive creation required


def test_unencodable_payload_touches_nothing(tmp_path):
    full = _write_full_identity(tmp_path)
    ident = load_or_create_identity(str(tmp_path))
    ident.extra["bad"] = object()  # not JSON-serialisable
    with pytest.raises(TypeError):
        save_identity(str(tmp_path), ident)
    assert (tmp_path / "identity.json").read_bytes() == full
    assert _tmp_leftovers(tmp_path) == []


# --- concurrent readers -----------------------------------------------------


def test_reader_during_a_write_sees_the_previous_complete_identity(tmp_path, monkeypatch):
    """Deterministic interleaving: the writer is frozen after it has opened its
    output and before it has written the payload; a reader loads at exactly
    that moment. The live file is untouched and the reader gets the same
    seed and the previous complete state."""
    _write_full_identity(tmp_path)
    real_write = os.write
    writer_paused = threading.Event()
    reader_done = threading.Event()
    state = {"paused": False}

    def pausing_write(fd, data):
        if not state["paused"]:
            state["paused"] = True
            writer_paused.set()
            assert reader_done.wait(5), "reader never ran"
        return real_write(fd, data)

    monkeypatch.setattr(creds_mod.os, "write", pausing_write)
    ident = load_or_create_identity(str(tmp_path))
    ident.pinned_operator_keys["kid-c"] = "pub-c"
    errors = []

    def writer():
        try:
            save_identity(str(tmp_path), ident)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    t = threading.Thread(target=writer)
    t.start()
    assert writer_paused.wait(5)
    try:
        seen = load_or_create_identity(str(tmp_path))  # concurrent reader
    finally:
        reader_done.set()
        t.join(5)
    assert not errors
    assert seen.seed_hex == SEED
    assert seen.pinned_operator_keys == PINS  # previous complete state
    final = load_or_create_identity(str(tmp_path))
    assert final.seed_hex == SEED
    assert final.pinned_operator_keys == {**PINS, "kid-c": "pub-c"}
    assert _unusable_copies(tmp_path) == []


def test_many_readers_and_writers_never_rotate_the_key(tmp_path):
    """Unscripted stress: readers and a writer race for real. Every load must
    yield the one seed and a complete pin set, and no reader may ever hit a
    torn file (which would surface as IdentityUnavailableError)."""
    _write_full_identity(tmp_path)
    stop = threading.Event()
    problems = []
    reads = {"n": 0}

    def reader():
        while not stop.is_set():
            try:
                ident = load_or_create_identity(str(tmp_path))
            except IdentityUnavailableError as exc:
                problems.append(f"torn read: {exc}")
                return
            reads["n"] += 1
            if ident.seed_hex != SEED:
                problems.append("seed rotated")
                return
            if not set(PINS) <= set(ident.pinned_operator_keys):
                problems.append(f"pins lost: {ident.pinned_operator_keys}")
                return

    def writer():
        for i in range(150):
            ident = EkhoIdentity(
                seed_hex=SEED,
                pinned_operator_keys={**PINS, f"kid-{i}": f"pub-{i}"},
                revoked_operator_keys=dict(TOMBSTONES),
            )
            save_identity(str(tmp_path), ident)
        stop.set()

    threads = [threading.Thread(target=reader) for _ in range(3)] + [threading.Thread(target=writer)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    stop.set()
    assert problems == []
    assert reads["n"] > 0
    final = load_or_create_identity(str(tmp_path))
    assert final.seed_hex == SEED
    assert final.revoked_operator_keys == TOMBSTONES
    assert "kid-149" in final.pinned_operator_keys
    assert _tmp_leftovers(tmp_path) == []
    assert _unusable_copies(tmp_path) == []


# --- wiring: connection and send paths never mint over a refusal ------------


def _wire(monkeypatch, tmp_path, *, stored_credentials: bool):
    from types import SimpleNamespace

    from ekho import AgentCredentials
    from ekho_hermes import connection

    class _FakeSdkClient:
        def __init__(self, creds):
            self.registered = []

        def register_identity_key(self, public_key):
            self.registered.append(public_key)
            return {"key_id": "k"}

        def close(self):
            pass

    monkeypatch.setattr(connection, "_connection", None)
    monkeypatch.setattr(connection, "_heartbeat_thread", None)
    monkeypatch.setattr(connection, "EkhoAgentClient", _FakeSdkClient)
    monkeypatch.setattr(
        connection,
        "load_credentials",
        lambda _dir: (
            AgentCredentials(agent_id="agt", secret="s", relay_base_url="http://r")
            if stored_credentials
            else None
        ),
    )
    monkeypatch.setattr(
        connection,
        "enroll_or_load",
        lambda config, config_dir: AgentCredentials(
            agent_id="agt", secret="s", relay_base_url="http://r"
        ),
    )
    monkeypatch.setattr(creds_mod, "_last_enroll_operator_keys", None)
    return connection, SimpleNamespace


def test_ensure_connected_enrolled_agent_without_identity_file_runs_unsigned(
    monkeypatch, tmp_path, caplog
):
    from ekho_hermes.config import EkhoConfig

    connection, _ = _wire(monkeypatch, tmp_path, stored_credentials=True)
    monkeypatch.delenv(ALLOW_NEW_IDENTITY_ENV, raising=False)
    config = EkhoConfig(relay_url="http://r", fleet_id="flt")
    with caplog.at_level("ERROR", logger="ekho_hermes.connection"):
        conn = connection.ensure_connected(config, config_dir=str(tmp_path), start_heartbeat=False)
    try:
        assert conn is not None  # connecting is never blocked
        assert not (tmp_path / "identity.json").exists()  # nothing minted
        assert conn.client.registered == []  # nothing registered with the relay
        assert any("identity unavailable" in r.getMessage() for r in caplog.records)
    finally:
        monkeypatch.setattr(connection, "_connection", None)


def test_ensure_connected_enrolled_agent_mints_only_with_operator_flag(monkeypatch, tmp_path):
    from ekho_hermes.config import EkhoConfig

    connection, _ = _wire(monkeypatch, tmp_path, stored_credentials=True)
    monkeypatch.setenv(ALLOW_NEW_IDENTITY_ENV, "1")
    config = EkhoConfig(relay_url="http://r", fleet_id="flt")
    conn = connection.ensure_connected(config, config_dir=str(tmp_path), start_heartbeat=False)
    try:
        assert (tmp_path / "identity.json").exists()
        assert len(conn.client.registered) == 1
    finally:
        monkeypatch.setattr(connection, "_connection", None)


def test_ensure_connected_fresh_enrolment_still_mints(monkeypatch, tmp_path):
    from ekho_hermes.config import EkhoConfig

    connection, _ = _wire(monkeypatch, tmp_path, stored_credentials=False)
    monkeypatch.delenv(ALLOW_NEW_IDENTITY_ENV, raising=False)
    config = EkhoConfig(relay_url="http://r", fleet_id="flt")
    conn = connection.ensure_connected(config, config_dir=str(tmp_path), start_heartbeat=False)
    try:
        assert (tmp_path / "identity.json").exists()
        assert len(conn.client.registered) == 1
    finally:
        monkeypatch.setattr(connection, "_connection", None)


def test_ensure_connected_corrupt_identity_is_kept_and_unregistered(monkeypatch, tmp_path, caplog):
    from ekho_hermes.config import EkhoConfig

    full = _write_full_identity(tmp_path)
    torn = full[:10]
    (tmp_path / "identity.json").write_bytes(torn)
    connection, _ = _wire(monkeypatch, tmp_path, stored_credentials=False)
    monkeypatch.setenv(ALLOW_NEW_IDENTITY_ENV, "1")  # even the flag does not overwrite
    config = EkhoConfig(relay_url="http://r", fleet_id="flt", operator_pubkey="AAAA")
    with caplog.at_level("ERROR", logger="ekho_hermes.connection"):
        conn = connection.ensure_connected(config, config_dir=str(tmp_path), start_heartbeat=False)
    try:
        assert conn is not None
        assert (tmp_path / "identity.json").read_bytes() == torn
        assert conn.client.registered == []
        assert _unusable_copies(tmp_path)
        assert any("UNSIGNED" in r.getMessage() for r in caplog.records)
    finally:
        monkeypatch.setattr(connection, "_connection", None)


def test_autoreply_start_never_mints_an_identity(monkeypatch, tmp_path):
    from types import SimpleNamespace

    from ekho import AgentCredentials
    from ekho_hermes import connection

    monkeypatch.setattr(connection, "_autoreply_stop", None)
    captured = {}

    def fake_start(**kwargs):
        captured.update(kwargs)
        return lambda: None

    conn = SimpleNamespace(
        client=object(),
        credentials=AgentCredentials(agent_id="agt", secret="s", relay_base_url="http://r"),
        config_dir=str(tmp_path),
    )
    connection.start_autoreply_once(conn, env={}, start_fn=fake_start)
    try:
        assert captured["identity_obj"] is None
        # Not a silent downgrade to "no verification": the loop is told the
        # identity is unavailable and withholds every wake until it is back
        # (tests/test_identity_unavailable_autoreply.py drives the real loop).
        assert captured["identity_unavailable"]
        assert callable(captured["reload_identity"])
        assert not (tmp_path / "identity.json").exists()  # and nothing minted
    finally:
        monkeypatch.setattr(connection, "_autoreply_stop", None)


def test_autoreply_start_uses_an_existing_identity(monkeypatch, tmp_path):
    from types import SimpleNamespace

    from ekho import AgentCredentials
    from ekho_hermes import connection

    _write_full_identity(tmp_path)
    monkeypatch.setattr(connection, "_autoreply_stop", None)
    captured = {}

    def fake_start(**kwargs):
        captured.update(kwargs)
        return lambda: None

    conn = SimpleNamespace(
        client=object(),
        credentials=AgentCredentials(agent_id="agt", secret="s", relay_base_url="http://r"),
        config_dir=str(tmp_path),
    )
    connection.start_autoreply_once(conn, env={}, start_fn=fake_start)
    try:
        assert captured["identity_obj"].seed_hex == SEED
        # The persisted-change callback goes through the atomic save.
        captured["identity_obj"].pinned_operator_keys["kid-z"] = "pub-z"
        captured["on_identity_changed"](captured["identity_obj"])
        assert load_or_create_identity(str(tmp_path)).pinned_operator_keys["kid-z"] == "pub-z"
        assert _tmp_leftovers(tmp_path) == []
    finally:
        monkeypatch.setattr(connection, "_autoreply_stop", None)


# --- preserved copies stay bounded ------------------------------------------


def test_repeated_loads_of_the_same_unusable_file_keep_one_copy(tmp_path):
    """Retrying an unchanged unusable file reuses its byte-exact copy."""
    path = tmp_path / "identity.json"
    corrupt = b"\xff\xfe not an identity"
    path.write_bytes(corrupt)
    for _ in range(25):
        with pytest.raises(IdentityUnavailableError):
            load_or_create_identity(str(tmp_path), allow_create=False)
    copies = _unusable_copies(tmp_path)
    assert len(copies) == 1
    assert copies[0].read_bytes() == corrupt
    assert stat.S_IMODE(copies[0].stat().st_mode) == 0o600
    assert path.read_bytes() == corrupt


def test_a_different_unusable_content_gets_its_own_copy(tmp_path):
    """One copy per distinct content: new bytes are preserved once more."""
    path = tmp_path / "identity.json"
    first, second = b"{", b"{ still not an identity"
    for content in (first, first, second, second, first):
        path.write_bytes(content)
        with pytest.raises(IdentityUnavailableError):
            load_or_create_identity(str(tmp_path), allow_create=False)
    assert sorted(p.read_bytes() for p in _unusable_copies(tmp_path)) == sorted([first, second])


def test_a_failed_copy_leaves_no_partial_file(tmp_path, monkeypatch):
    """A copy that cannot be written completely is not left beside the file."""
    path = tmp_path / "identity.json"
    path.write_bytes(b"not json")
    real_fdopen = os.fdopen

    class _Failing:
        def __init__(self, fh):
            self._fh = fh

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self._fh.close()
            return False

        def write(self, data):
            self._fh.write(data[:3])
            raise OSError("disk full")

    monkeypatch.setattr(creds_mod.os, "fdopen", lambda fd, mode: _Failing(real_fdopen(fd, mode)))
    with pytest.raises(IdentityUnavailableError) as excinfo:
        load_or_create_identity(str(tmp_path), allow_create=False)
    assert excinfo.value.preserved_path is None
    assert _unusable_copies(tmp_path) == []
    assert path.read_bytes() == b"not json"
