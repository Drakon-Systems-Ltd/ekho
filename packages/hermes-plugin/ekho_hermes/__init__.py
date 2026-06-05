"""Ekho relay adapter for Hermes agents.

Gives a Hermes agent two tools — ``ekho_send`` and ``ekho_inbox`` — to
coordinate with the rest of an Ekho fleet over a relay. Mirrors the OpenClaw
Ekho plugin (enroll/load credentials, background heartbeat, trust/roster
surfacing, attachment handling) on top of the Ekho Python SDK.

Only ``register`` touches the Hermes runtime; every other module is importable
on its own (pure-ish), which is what the test suite relies on.
"""

from .plugin import register

__all__ = ["register"]
