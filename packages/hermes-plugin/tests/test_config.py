"""Tests for the env-sourced config, including the peer-delegation knobs."""

from ekho_hermes.config import EkhoConfig


def test_peer_autoreply_defaults_on_when_unset():
    # Bounded delegation is ON by default now: an UNSET env var yields True (the
    # latch still caps peer ping-pong per conversation).
    cfg = EkhoConfig.from_env(env={"EKHO_RELAY_URL": "http://relay"})
    assert cfg.peer_autoreply is True
    assert cfg.peer_turn_budget == 6


def test_peer_autoreply_truthy_values():
    for v in ("1", "true", "TRUE", "yes", "on"):
        cfg = EkhoConfig.from_env(
            env={"EKHO_RELAY_URL": "http://relay", "EKHO_PEER_AUTOREPLY": v}
        )
        assert cfg.peer_autoreply is True, v


def test_peer_autoreply_explicit_falsey_values_disable():
    # An explicit 0/false/no/off still opts the agent out of peer delegation.
    for v in ("0", "false", "FALSE", "no", "off"):
        cfg = EkhoConfig.from_env(
            env={"EKHO_RELAY_URL": "http://relay", "EKHO_PEER_AUTOREPLY": v}
        )
        assert cfg.peer_autoreply is False, v


def test_peer_autoreply_empty_string_is_treated_as_unset():
    # Empty/whitespace is not an explicit opt-out -> falls back to the ON default.
    for v in ("", "   "):
        cfg = EkhoConfig.from_env(
            env={"EKHO_RELAY_URL": "http://relay", "EKHO_PEER_AUTOREPLY": v}
        )
        assert cfg.peer_autoreply is True, repr(v)


def test_peer_turn_budget_parsed():
    cfg = EkhoConfig.from_env(
        env={"EKHO_RELAY_URL": "http://relay", "EKHO_PEER_TURN_BUDGET": "10"}
    )
    assert cfg.peer_turn_budget == 10


def test_peer_turn_budget_invalid_falls_back_to_default():
    cfg = EkhoConfig.from_env(
        env={"EKHO_RELAY_URL": "http://relay", "EKHO_PEER_TURN_BUDGET": "nope"}
    )
    assert cfg.peer_turn_budget == 6


def test_peer_turn_budget_floor_of_one():
    cfg = EkhoConfig.from_env(
        env={"EKHO_RELAY_URL": "http://relay", "EKHO_PEER_TURN_BUDGET": "0"}
    )
    assert cfg.peer_turn_budget == 6  # <=0 is meaningless -> default
