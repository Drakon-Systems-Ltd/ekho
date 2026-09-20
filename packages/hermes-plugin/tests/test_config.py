"""Tests for the env-sourced config, including the peer-delegation knobs."""

from ekho_hermes.config import EkhoConfig


def test_peer_autoreply_defaults_on_when_unset():
    # Peer delegation is ON by default: an UNSET env var yields True. There is
    # no default turn limit (0) — the rate gate bounds ping-pong.
    cfg = EkhoConfig.from_env(env={"EKHO_RELAY_URL": "http://relay"})
    assert cfg.peer_autoreply is True
    assert cfg.peer_turn_budget == 0


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


def test_peer_turn_budget_invalid_means_no_limit():
    cfg = EkhoConfig.from_env(
        env={"EKHO_RELAY_URL": "http://relay", "EKHO_PEER_TURN_BUDGET": "nope"}
    )
    assert cfg.peer_turn_budget == 0


def test_peer_turn_budget_zero_or_negative_means_no_limit():
    for raw in ("0", "-3", "", "   "):
        cfg = EkhoConfig.from_env(
            env={"EKHO_RELAY_URL": "http://relay", "EKHO_PEER_TURN_BUDGET": raw}
        )
        assert cfg.peer_turn_budget == 0, raw


def test_peer_turn_budget_positive_is_a_local_cap():
    cfg = EkhoConfig.from_env(
        env={"EKHO_RELAY_URL": "http://relay", "EKHO_PEER_TURN_BUDGET": "25"}
    )
    assert cfg.peer_turn_budget == 25  # 25 typed in is a real cap, not a default


def test_require_signed_defaults_to_warn():
    cfg = EkhoConfig.from_env(env={"EKHO_RELAY_URL": "http://relay"})
    assert cfg.require_signed == "warn"


def test_require_signed_parsed_from_env():
    # #5: EKHO_REQUIRE_SIGNED drives the peer-wake strictness; junk -> "warn".
    for raw, expected in (
        ("require", "require"),
        (" REQUIRE ", "require"),
        ("off", "off"),
        ("warn", "warn"),
        ("nonsense", "warn"),
        ("", "warn"),
    ):
        cfg = EkhoConfig.from_env(
            env={"EKHO_RELAY_URL": "http://relay", "EKHO_REQUIRE_SIGNED": raw}
        )
        assert cfg.require_signed == expected, repr(raw)
