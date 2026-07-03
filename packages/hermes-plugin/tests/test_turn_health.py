"""Turn-health telemetry parity with the OpenClaw plugin (connection.ts)."""

from ekho_hermes.connection import (
    derive_turn_health,
    note_model_call_ended,
    _turn_health_metrics,
    _reset_turn_health,
)

T0 = 1_700_000_000_000.0  # fixed epoch ms so thresholds are deterministic


def ok(t):
    return (t, True, "")


def err(t, category="not_found"):
    return (t, False, category)


def test_unknown_with_no_calls_in_window():
    assert derive_turn_health([], T0)["turn_health"] == "unknown"
    # older than the 1h window -> pruned -> still unknown
    assert derive_turn_health([ok(T0 - 2 * 3600_000)], T0)["turn_health"] == "unknown"


def test_ok_when_all_recent_completed():
    h = derive_turn_health([ok(T0 - 10_000), ok(T0 - 5_000), ok(T0 - 1_000)], T0)
    assert h["turn_health"] == "ok"
    assert h["errors_1h"] == 0
    assert h["last_error"] is None


def test_down_when_nothing_completes():
    h = derive_turn_health([err(T0 - 9_000), err(T0 - 3_000)], T0)
    assert h["turn_health"] == "down"
    assert h["last_error"] == "not_found"
    assert h["calls_1h"] == 2 and h["errors_1h"] == 2


def test_degraded_when_mixed():
    h = derive_turn_health([ok(T0 - 20_000), err(T0 - 10_000), ok(T0 - 5_000)], T0)
    assert h["turn_health"] == "degraded"
    assert h["errors_1h"] == 1


def test_down_after_three_consecutive_failures():
    h = derive_turn_health(
        [ok(T0 - 60_000), err(T0 - 30_000), err(T0 - 20_000), err(T0 - 10_000)], T0
    )
    assert h["turn_health"] == "down"


def test_metrics_module_state_down_then_ok():
    _reset_turn_health()
    assert _turn_health_metrics(T0) == {}
    note_model_call_ended("error", "unauthorized", T0 - 5_000)
    note_model_call_ended("error", "unauthorized", T0 - 1_000)
    m = _turn_health_metrics(T0)
    assert m["turn_health"] == "down"
    assert m["last_error"] == "unauthorized"
    assert m["model_errors_1h"] == "2" and m["model_calls_1h"] == "2"
    note_model_call_ended("completed", None, T0 - 500)
    m2 = _turn_health_metrics(T0)
    assert m2["turn_health"] == "degraded"  # success after the failing run
    _reset_turn_health()


def test_reply_turn_outcome_feeds_health():
    """The autoreply reply-turn exit status is Hermes' cognitive-health signal."""
    from ekho_hermes.autoreply import _note_turn_outcome
    from ekho_hermes import connection as conn

    conn._reset_turn_health()
    # A reply turn that keeps failing (e.g. every call 404s) → down.
    _note_turn_outcome("error", "exit_1")
    _note_turn_outcome("error", "exit_1")
    m = conn._turn_health_metrics()
    assert m["turn_health"] == "down"
    assert m["last_error"] == "exit_1"
    conn._reset_turn_health()
    # A clean reply turn → ok.
    _note_turn_outcome("completed")
    assert conn._turn_health_metrics()["turn_health"] == "ok"
    conn._reset_turn_health()
