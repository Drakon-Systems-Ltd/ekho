"""``ekho_send`` attachments come only from the outbox.

Uploads are confined to the outbox directory, checked on the real path; the
Ekho, Hermes and OpenClaw state dirs and the identity, credential and config
file names are refused outright. Every path here is under a scratch ``HOME``;
the real ``~/.hermes`` is never touched.
"""

import json
import os
import shutil
import threading

import pytest

from ekho_hermes import attachments as att


@pytest.fixture()
def box(tmp_path, monkeypatch):
    home = tmp_path.resolve() / "home"
    hermes = home / ".hermes"
    state = hermes / "ekho-state"
    oc = home / ".openclaw"
    outbox = home / "ekho-outbox"
    outside = home / "elsewhere"
    for d in (state, oc, outbox, outside):
        d.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    for var in ("EKHO_OUTBOX_DIR", "HERMES_HOME", "OPENCLAW_STATE_DIR", "EKHO_STATE_DIR"):
        monkeypatch.delenv(var, raising=False)
    (state / "identity.json").write_text(json.dumps({"seed": "ab" * 32}))
    (state / "credentials.json").write_text(json.dumps({"agent_id": "a", "secret": "s3cret"}))
    (oc / "openclaw.json").write_text(json.dumps({"token": "provider-key"}))
    (outside / "notes.txt").write_text("outside the outbox")
    (outbox / "report.md").write_text("# report\n")

    class Box:
        pass

    b = Box()
    b.home, b.hermes, b.state, b.oc, b.outbox, b.outside = home, hermes, state, oc, outbox, outside
    return b


def read(box, path, outbox=None):
    return att.read_upload_file(
        str(path), outbox_dir=str(outbox or box.outbox), state_dir=str(box.state)
    )


def refused(box, path, outbox=None):
    with pytest.raises(ValueError) as exc:
        read(box, path, outbox)
    return str(exc.value)


def test_happy_path_absolute_and_outbox_relative(box):
    info = read(box, box.outbox / "report.md")
    assert info["bytes"] == b"# report\n"
    assert info["mime"] == "text/markdown"
    assert info["filename"] == "report.md"
    (box.outbox / "sub").mkdir()
    (box.outbox / "sub" / "data.csv").write_text("a,b\n")
    assert read(box, "sub/data.csv")["bytes"] == b"a,b\n"


def test_refuses_identity_file(box):
    msg = refused(box, box.state / "identity.json")
    assert str(box.outbox) in msg
    assert "ab" * 32 not in msg


def test_refuses_credentials_file(box):
    assert "s3cret" not in refused(box, box.state / "credentials.json")


def test_refuses_openclaw_json(box):
    refused(box, box.oc / "openclaw.json")


def test_refuses_dotdot_traversal(box):
    refused(box, "../elsewhere/notes.txt")
    refused(box, os.path.join(str(box.outbox), "..", "elsewhere", "notes.txt"))
    refused(box, os.path.join(str(box.outbox), "..", ".hermes", "ekho-state", "identity.json"))


def test_refuses_absolute_path_outside(box):
    assert str(box.outbox) in refused(box, box.outside / "notes.txt")


def test_refuses_symlink_pointing_out_without_naming_target(box):
    os.symlink(box.state / "identity.json", box.outbox / "innocent.json")
    os.symlink(box.outside / "notes.txt", box.outbox / "notes.txt")
    msg = refused(box, box.outbox / "innocent.json")
    assert str(box.state) not in msg
    assert "identity.json" not in msg
    refused(box, "notes.txt")


def test_refuses_symlinked_directory_inside_outbox(box):
    os.symlink(box.state, box.outbox / "state")
    os.symlink(box.outside, box.outbox / "away")
    refused(box, box.outbox / "state" / "credentials.json")
    refused(box, "away/notes.txt")


def test_refuses_outbox_with_symlinked_parent_into_state(box):
    (box.state / "outbox").mkdir()
    (box.state / "outbox" / "x.txt").write_text("x")
    os.symlink(box.state, box.home / "linked")
    sneaky = box.home / "linked" / "outbox"
    refused(box, sneaky / "x.txt", outbox=sneaky)


def test_refuses_outbox_overlapping_state_or_config_dirs(box):
    (box.state / "x.txt").write_text("x")
    (box.home / "x.txt").write_text("x")
    (box.oc / "out").mkdir()
    (box.oc / "out" / "x.txt").write_text("x")
    refused(box, box.state / "identity.json", outbox=box.state)
    refused(box, box.state / "x.txt", outbox=box.state)
    refused(box, box.state / "x.txt", outbox=box.hermes)
    refused(box, box.oc / "out" / "x.txt", outbox=box.oc / "out")
    refused(box, box.home / "x.txt", outbox=box.home)  # home contains ~/.hermes
    refused(box, box.home / "x.txt", outbox="/")


def test_refuses_trust_file_names_and_dotfiles_inside_outbox(box):
    shutil.copy(box.state / "identity.json", box.outbox / "identity.json")
    shutil.copy(box.state / "credentials.json", box.outbox / "credentials.json")
    for name in (".ekho-identity.json", ".ekho-credentials.json", "openclaw.json", ".hidden.txt"):
        (box.outbox / name).write_text("{}")
    for name in ("identity.json", "credentials.json", ".ekho-identity.json",
                 ".ekho-credentials.json", "openclaw.json", ".hidden.txt"):
        refused(box, box.outbox / name)


def test_keeps_extension_allowlist(box):
    (box.outbox / "run.sh").write_text("echo")
    assert "unsupported type" in refused(box, box.outbox / "run.sh")


def test_missing_file_names_only_the_outbox(box):
    assert str(box.outbox) in refused(box, "missing.txt")


def test_outbox_resolution_order(box, monkeypatch):
    assert att.resolve_outbox_dir() == str(box.home / "ekho-outbox")
    env_outbox = box.home / "env-outbox"
    monkeypatch.setenv("EKHO_OUTBOX_DIR", str(env_outbox))
    assert att.resolve_outbox_dir() == str(env_outbox)
    assert att.resolve_outbox_dir(str(box.outside)) == str(box.outside)
    env_outbox.mkdir()
    (env_outbox / "e.txt").write_text("env")
    info = att.read_upload_file("e.txt", state_dir=str(box.state))
    assert info["bytes"] == b"env"


def test_upload_paths_refuses_before_uploading(box, monkeypatch):
    monkeypatch.setenv("EKHO_OUTBOX_DIR", str(box.outbox))
    uploaded = []

    class Client:
        def upload_attachment(self, **kw):
            uploaded.append(kw["filename"])
            return {"id": "att_1"}

    with pytest.raises(ValueError):
        att.upload_paths(Client(), [str(box.state / "identity.json")], state_dir=str(box.state))
    assert uploaded == []
    assert att.upload_paths(Client(), ["report.md"], state_dir=str(box.state)) == ["att_1"]


# The next tests check the open itself as well as the path checks: the
# directory layout is changed deterministically from inside the helper's own
# os calls, and the file must still be refused.
PRIVATE = "PRIVATE_FIXTURE_ONLY"
anchored = pytest.mark.skipif(
    not att.ANCHORED_OPEN_SUPPORTED, reason="no dir_fd open on this platform"
)


def plant_swap(box):
    sub = box.outbox / "sub"
    sub.mkdir()
    (sub / "report.txt").write_text("public")
    (box.state / "report.txt").write_text(PRIVATE)
    done = []

    def swap():
        if done:
            return
        done.append(True)
        os.rename(sub, box.outbox / "sub-old")
        os.symlink(box.state, sub, target_is_directory=True)

    return swap, done


@anchored
def test_refuses_parent_swapped_for_symlink_after_checks(box, monkeypatch):
    swap, done = plant_swap(box)
    original = os.path.realpath
    target = str(box.outbox / "sub" / "report.txt")

    def realpath_then_swap(path, *args, **kwargs):
        out = original(path, *args, **kwargs)
        if str(path) == target:
            swap()
        return out

    monkeypatch.setattr(os.path, "realpath", realpath_then_swap)
    msg = refused(box, "sub/report.txt")
    assert done
    assert PRIVATE not in msg
    assert str(box.state) not in msg


@anchored
def test_refuses_parent_swapped_for_symlink_just_before_open(box, monkeypatch):
    swap, done = plant_swap(box)
    original = os.open

    def swap_then_open(*args, **kwargs):
        swap()
        return original(*args, **kwargs)

    monkeypatch.setattr(os, "open", swap_then_open)
    msg = refused(box, "sub/report.txt")
    assert done
    assert PRIVATE not in msg
    assert str(box.state) not in msg


@anchored
def test_refuses_symlink_inside_outbox_even_when_it_points_inside(box):
    (box.outbox / "sub").mkdir()
    (box.outbox / "sub" / "data.csv").write_text("a,b\n")
    os.symlink(box.outbox / "report.md", box.outbox / "alias.md")
    os.symlink(box.outbox / "sub", box.outbox / "subdir", target_is_directory=True)
    assert "symlinks are never followed" in refused(box, "alias.md")
    assert "symlinks are never followed" in refused(box, "subdir/data.csv")
    assert read(box, "sub/data.csv")["bytes"] == b"a,b\n"


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="no FIFOs on this platform")
def test_refuses_fifo_in_outbox_without_blocking(box):
    fifo = box.outbox / "pipe.txt"
    os.mkfifo(fifo)
    result = {}

    def run():
        try:
            read(box, "pipe.txt")
            result["value"] = "read"
        except ValueError as exc:
            result["error"] = str(exc)

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(3.0)
    if worker.is_alive():
        # Release the stuck opener (a writer end unblocks a reader open) so the
        # interpreter can exit cleanly, then fail.
        try:
            os.close(os.open(fifo, os.O_WRONLY | os.O_NONBLOCK))
        except OSError:
            pass
        pytest.fail("read_upload_file blocked on a FIFO instead of refusing it")
    assert "not a regular file" in result.get("error", "")
    assert "pipe.txt" in result["error"]
    assert str(box.state) not in result["error"]


# Runs on every platform, POSIX included: the anchored tests above have to
# skip where there is no dir_fd open. Forcing the flag off exercises that
# branch here: a valid, regular file in the outbox must be refused and no
# os.open call of any kind may be made. This test must fail if an open by
# pathname (even with leaf O_NOFOLLOW) is ever used where the open cannot be
# anchored.
def test_refuses_every_attachment_without_opening_where_open_cannot_be_anchored(box, monkeypatch):
    import sys

    monkeypatch.setattr(att, "ANCHORED_OPEN_SUPPORTED", False)
    opened = []
    original = os.open

    def record_open(*args, **kwargs):
        opened.append((args[0], kwargs.get("dir_fd")))
        return original(*args, **kwargs)

    monkeypatch.setattr(os, "open", record_open)
    assert (box.outbox / "report.md").read_text() == "# report\n"  # a file that reads fine when anchored
    with pytest.raises(ValueError) as info:
        read(box, "report.md")
    msg = str(info.value)
    assert 'attachment "report.md" refused' in msg
    assert f"this host ({sys.platform}) cannot anchor the open to the outbox directory" in msg
    assert str(box.outbox) in msg
    assert "# report" not in msg
    assert opened == [], "the fallback opened a pathname"
