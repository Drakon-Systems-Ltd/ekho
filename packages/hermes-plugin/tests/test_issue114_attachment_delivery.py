"""Issue #114: daemon attachment delivery on every auto-reply turn path."""

import pytest

from ekho import InboxMessage, InboxResponse
from ekho.verify import VerificationResult
from ekho_hermes import attachments, autoreply


def _message(*attachment_ids):
    return InboxMessage.from_dict({
        "message_id": "m114",
        "conversation_id": "review",
        "correlation_id": "handoff",
        "sender_agent_id": "peer",
        "sender_kind": "agent",
        "message_type": "direct",
        "priority": "normal",
        "body": {"text": "Please review the attached files"},
        "metadata": {},
        "created_at": "2026-10-08T00:00:00Z",
        "deadline_at": "2026-10-09T00:00:00Z",
        "attachments": [
            {"id": aid, "filename": f"{aid}.pdf", "mime": "application/pdf", "size_bytes": 4}
            for aid in attachment_ids
        ],
    })


class Client:
    def __init__(self, message, *, granted, failed=()):
        self.inbox = InboxResponse([message], [], False, [])
        self.granted = granted
        self.failed = set(failed)
        self.downloads = []
        self.acks = []
        self.releases = []

    def get_inbox(self, limit=25):
        return self.inbox

    def ack_messages(self, acks):
        self.acks.extend(acks)
        self.inbox = InboxResponse([], [], False, [])
        return {"ok": True}

    def acquire_floor(self, conversation_id, ttl_seconds=None):
        return {"granted": self.granted, "conversation_tail": []}

    def release_floor(self, conversation_id):
        self.releases.append(conversation_id)

    def download_attachment(self, attachment_id):
        self.downloads.append(attachment_id)
        if attachment_id in self.failed:
            raise OSError("download failed")
        return b"data"


@pytest.fixture
def download_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(attachments, "attachments_download_dir", lambda: str(tmp_path))
    return tmp_path


def _tick(client, state, prompts, now):
    return autoreply.process_inbox_once(
        client, "self", state,
        spawn=lambda cmd, env: prompts.append(" ".join(cmd)),
        now=now, peer_enabled=True, peer_turn_budget=25,
    )


@pytest.mark.parametrize("overrun", [False, True], ids=["retry", "expired"])
def test_acked_stash_downloads_when_delivered(download_dir, overrun):
    client = Client(_message("att1"), granted=False)
    state = autoreply.AutoReplyState()
    prompts = []

    first = _tick(client, state, prompts, 0.0)
    assert first["spawned"] == 0
    assert client.acks and client.downloads == ["att1"]
    assert "review" in state.deferred_by_conversation

    client.granted = True
    later = autoreply.DEFERRED_RETRY_TTL_S + 1 if overrun else 5.0
    second = _tick(client, state, prompts, later)
    assert second["spawned"] == 1
    assert len(prompts) == 1
    assert client.downloads == ["att1"]
    assert "saved locally at:" in prompts[0]
    assert str(download_dir / "att1__att1.pdf") in prompts[0]
    assert "call the ekho_inbox tool" not in prompts[0]
    assert client.releases == ([] if overrun else ["review"])


def test_download_failure_still_spawns_with_explicit_note(download_dir):
    client = Client(_message("bad"), granted=True, failed={"bad"})
    prompts = []
    result = _tick(client, autoreply.AutoReplyState(), prompts, 0.0)

    assert result["spawned"] == 1
    assert client.downloads == ["bad"]
    assert "bad.pdf (application/pdf, 4B)" in prompts[0]
    assert "could not be downloaded by the Ekho daemon and is NOT available to this turn" in prompts[0]
    assert "ask the sender to resend or paste it inline" in prompts[0]
    assert "call the ekho_inbox tool" not in prompts[0]


def test_whole_predownload_exception_still_spawns(download_dir, monkeypatch):
    client = Client(_message("bad"), granted=True)
    prompts = []

    def fail_entire_download(*args):
        raise OSError("storage unavailable")

    monkeypatch.setattr(autoreply, "download_inbox_attachments", fail_entire_download)
    result = _tick(client, autoreply.AutoReplyState(), prompts, 0.0)

    assert result["spawned"] == 1
    assert "bad.pdf (application/pdf, 4B) — could not be downloaded" in prompts[0]
    assert "call the ekho_inbox tool" not in prompts[0]


def test_skipped_attachment_is_reported(download_dir):
    message = _message("large")
    message.attachments[0].size_bytes = attachments.ATTACHMENT_MAX_BYTES + 1
    client = Client(message, granted=True)
    prompts = []
    result = _tick(client, autoreply.AutoReplyState(), prompts, 0.0)

    assert result["spawned"] == 1
    assert client.downloads == []
    assert "large.pdf" in prompts[0]
    assert "could not be downloaded by the Ekho daemon" in prompts[0]
    assert "call the ekho_inbox tool" not in prompts[0]


def test_partial_download_reports_both_files(download_dir):
    client = Client(_message("good", "bad"), granted=True, failed={"bad"})
    prompts = []
    result = _tick(client, autoreply.AutoReplyState(), prompts, 0.0)

    assert result["spawned"] == 1
    assert client.downloads == ["good", "bad"]
    assert f"good.pdf (application/pdf, 4B) — saved locally at: {download_dir / 'good__good.pdf'}" in prompts[0]
    assert "bad.pdf (application/pdf, 4B) — could not be downloaded" in prompts[0]
    assert "call the ekho_inbox tool" not in prompts[0]


def test_immediate_floor_still_downloads(download_dir):
    client = Client(_message("att1"), granted=True)
    prompts = []
    result = _tick(client, autoreply.AutoReplyState(), prompts, 0.0)

    assert result["spawned"] == 1
    assert client.downloads == ["att1"]
    assert f"saved locally at: {download_dir / 'att1__att1.pdf'}" in prompts[0]
    assert "call the ekho_inbox tool" not in prompts[0]


def test_retry_prepares_before_acquire_and_spawns_without_network_after_grant(download_dir):
    events = []
    client = Client(_message("one", "two"), granted=False)
    state = autoreply.AutoReplyState()
    prompts = []
    autoreply.stash_deferred(state, "review", client.inbox.messages, {}, 0.0)
    client.inbox = InboxResponse([], [], False, [])
    original_download = client.download_attachment
    original_acquire = client.acquire_floor

    def download(attachment_id):
        events.append(("download", attachment_id))
        return original_download(attachment_id)

    def acquire(conversation_id, ttl_seconds=None):
        events.append(("acquire", conversation_id))
        return original_acquire(conversation_id, ttl_seconds)

    client.download_attachment = download
    client.acquire_floor = acquire
    client.granted = True
    autoreply.process_inbox_once(
        client, "self", state,
        spawn=lambda cmd, env: (events.append(("spawn", None)), prompts.append(" ".join(cmd))),
        now=5.0, peer_enabled=True, peer_turn_budget=25,
    )
    assert events == [
        ("download", "one"), ("download", "two"),
        ("acquire", "review"), ("spawn", None),
    ]
    assert "review" not in state.deferred_by_conversation


def test_slow_retry_download_takes_floor_after_elapsed_ttl(download_dir):
    clock = [0.0]
    events = []
    client = Client(_message("slow"), granted=False)
    state = autoreply.AutoReplyState()
    prompts = []
    autoreply.stash_deferred(state, "review", client.inbox.messages, {}, clock[0])
    client.inbox = InboxResponse([], [], False, [])

    def download(attachment_id):
        clock[0] += autoreply.FLOOR_TTL_SECONDS + 1
        events.append(("download", clock[0]))
        return b"data"

    def acquire(conversation_id, ttl_seconds=None):
        events.append(("acquire", clock[0]))
        return {"granted": True, "conversation_tail": []}

    client.download_attachment = download
    client.acquire_floor = acquire
    result = autoreply.process_inbox_once(
        client, "self", state,
        spawn=lambda cmd, env: (events.append(("spawn", clock[0])), prompts.append(" ".join(cmd))),
        now=clock[0], peer_enabled=True, peer_turn_budget=25,
    )
    assert result["spawned"] == 1
    assert events == [
        ("download", autoreply.FLOOR_TTL_SECONDS + 1),
        ("acquire", autoreply.FLOOR_TTL_SECONDS + 1),
        ("spawn", autoreply.FLOOR_TTL_SECONDS + 1),
    ]
    assert client.releases == ["review"]
    assert "held back" in prompts[0].lower()


def test_retry_memoizes_preparation_while_floor_held(download_dir):
    client = Client(_message("once"), granted=False)
    state = autoreply.AutoReplyState()
    prompts = []
    _tick(client, state, prompts, 0.0)
    _tick(client, state, prompts, 1.0)
    _tick(client, state, prompts, 2.0)
    assert client.downloads == ["once"]
    assert state.deferred_by_conversation["review"]["attachments_prepared"] is True
    client.granted = True
    assert _tick(client, state, prompts, 3.0)["spawned"] == 1
    assert client.downloads == ["once"]
    assert "saved locally at:" in prompts[0]


def test_retry_failed_download_keeps_stash_and_verdict(download_dir):
    client = Client(_message("bad"), granted=False, failed={"bad"})
    client.inbox.messages[0].sender_kind = "operator"
    state = autoreply.AutoReplyState()
    verdict = VerificationResult(True, "peer", None, "trusted-key")
    autoreply.stash_deferred(state, "review", [client.inbox.messages[0]], {"m114": verdict}, 0.0)
    client.inbox = InboxResponse([], [], False, [])
    prompts = []
    assert _tick(client, state, prompts, 1.0)["spawned"] == 0
    stash = state.deferred_by_conversation["review"]
    assert autoreply.stash_verdicts(stash)[autoreply.held_key(stash["messages"][0])] is verdict
    assert stash["attachments_prepared"] is True
    assert client.downloads == ["bad"]
    client.granted = True
    assert _tick(client, state, prompts, 2.0)["spawned"] == 1
    assert client.downloads == ["bad"]
    assert "could not be downloaded by the Ekho daemon and is NOT available to this turn" in prompts[0]
    assert "CRYPTOGRAPHICALLY VERIFIED" in prompts[0]
    assert client.releases == ["review"]


def test_malformed_attachment_ids_do_not_abort_valid_sibling(download_dir):
    message = _message(["bad"], {"bad": "id"}, "good")
    message.attachments[0].filename = ""
    message.attachments[1].filename = ""
    client = Client(message, granted=True)
    prompts = []
    assert _tick(client, autoreply.AutoReplyState(), prompts, 0.0)["spawned"] == 1
    assert client.downloads == ["good"]
    assert prompts[0].count("file (application/pdf, 4B) — could not be downloaded") == 2
    assert f"good.pdf (application/pdf, 4B) — saved locally at: {download_dir / 'good__good.pdf'}" in prompts[0]


def test_malformed_prepared_ids_are_ignored_when_matching_paths():
    message = _message(["bad"], {"bad": "id"}, "good")
    note = autoreply._attachments_note(message, [
        {"id": ["bad"], "local_path": "/wrong-list"},
        {"id": {"bad": "id"}, "local_path": "/wrong-dict"},
        {"id": "good", "local_path": "/good"},
    ])
    assert note.count("could not be downloaded") == 2
    assert "good.pdf (application/pdf, 4B) — saved locally at: /good" in note


# --- #114 r2: overrun delivery prepares while the stash is still queued ---


def _second_message(*attachment_ids):
    message = _message(*attachment_ids)
    message.message_id = "m114b"
    message.body = {"text": "One more file"}
    return message


class OverrunClient(Client):
    """Counts floor calls and checks the queue from inside each download."""

    def __init__(self, message, state, *, failed=(), expect_verdict_keys=()):
        super().__init__(message, granted=False, failed=failed)
        self.state = state
        self.expect_verdict_keys = tuple(expect_verdict_keys)
        self.acquires = []
        self.seen_queued = []

    def acquire_floor(self, conversation_id, ttl_seconds=None):
        self.acquires.append(conversation_id)
        return super().acquire_floor(conversation_id, ttl_seconds)

    def download_attachment(self, attachment_id):
        stash = self.state.deferred_by_conversation.get("review")
        queued = stash is not None and bool(stash.get("messages"))
        verdicts = autoreply.stash_verdicts(stash) if stash else {}
        self.seen_queued.append((
            attachment_id,
            queued,
            all(verdicts.get(k) is not None for k in self.expect_verdict_keys),
        ))
        return super().download_attachment(attachment_id)


def _overrun_tick(client, state, prompts, now, *, spawn=None, dead_letter_path=None):
    return autoreply.process_inbox_once(
        client, "self", state,
        spawn=spawn or (lambda cmd, env: prompts.append(" ".join(cmd))),
        now=now, peer_enabled=True, peer_turn_budget=25,
        dead_letter_path=dead_letter_path,
    )


def test_cold_expired_stash_prepares_while_queued(download_dir):
    state = autoreply.AutoReplyState()
    held = _message("good", "bad")
    held.sender_kind = "operator"
    verdict = VerificationResult(True, "peer", None, "trusted-key")
    autoreply.stash_deferred(state, "review", [held], {"m114": verdict}, 0.0)
    stash = state.deferred_by_conversation["review"]
    assert not stash.get("attachments_prepared", False)  # cold: no memo
    key = autoreply.held_key(stash["messages"][0])
    client = OverrunClient(held, state, failed={"bad"}, expect_verdict_keys=[key])
    client.inbox = InboxResponse([], [], False, [])
    prompts = []

    result = _overrun_tick(client, state, prompts, autoreply.DEFERRED_RETRY_TTL_S + 1)

    assert result["spawned"] == 1
    assert len(prompts) == 1
    # Every download ran while the stash and its stored verdict were queued.
    assert client.seen_queued == [("good", True, True), ("bad", True, True)]
    assert "review" not in state.deferred_by_conversation
    # Overrun: no floor taken or released.
    assert client.acquires == [] and client.releases == []
    assert "WITHOUT the floor" in prompts[0]
    assert "CRYPTOGRAPHICALLY VERIFIED" in prompts[0]
    assert f"good.pdf (application/pdf, 4B) — saved locally at: {download_dir / 'good__good.pdf'}" in prompts[0]
    assert "bad.pdf (application/pdf, 4B) — could not be downloaded by the Ekho daemon and is NOT available to this turn" in prompts[0]


def test_expired_stash_plus_new_message_prepares_merged_stash_while_queued(download_dir):
    state = autoreply.AutoReplyState()
    held = _message("old")
    autoreply.stash_deferred(state, "review", [held], {}, 0.0)
    fresh = _second_message("new")
    client = OverrunClient(fresh, state)
    prompts = []

    result = _overrun_tick(client, state, prompts, autoreply.DEFERRED_RETRY_TTL_S + 1)

    assert result["spawned"] == 1
    assert len(prompts) == 1
    # The fresh message merged into the expired stash (rebuilt, cold), and
    # both messages' files downloaded while that merged stash was queued.
    assert sorted(client.seen_queued) == [("new", True, True), ("old", True, True)]
    assert "review" not in state.deferred_by_conversation
    # Only the fresh-message path asked for the floor; the overrun turn
    # neither acquired nor released one.
    assert client.acquires == ["review"]
    assert client.releases == []
    assert "WITHOUT the floor" in prompts[0]
    assert str(download_dir / "old__old.pdf") in prompts[0]
    assert str(download_dir / "new__new.pdf") in prompts[0]


def test_cold_expired_spawn_failure_still_dead_letters(download_dir, tmp_path):
    import json

    state = autoreply.AutoReplyState()
    held = _message("att1")
    autoreply.stash_deferred(state, "review", [held], {}, 0.0)
    client = OverrunClient(held, state)
    client.inbox = InboxResponse([], [], False, [])
    dl = tmp_path / "dl.jsonl"

    def boom(cmd, env):
        raise RuntimeError("no interpreter")

    result = _overrun_tick(
        client, state, [], autoreply.DEFERRED_RETRY_TTL_S + 1,
        spawn=boom, dead_letter_path=str(dl),
    )

    assert result["spawned"] == 0
    assert client.seen_queued == [("att1", True, True)]
    assert "review" not in state.deferred_by_conversation
    assert client.acquires == [] and client.releases == []
    records = [json.loads(line) for line in dl.read_text().splitlines()]
    assert [r["message"]["message_id"] for r in records] == ["m114"]
    assert records[0]["reason"] == autoreply.DEFERRED_SPAWN_FAILED_REASON
