-- Peer auto-reply ON by default. Bounded agent-to-agent delegation graduated
-- from opt-in to the default: every agent now wakes on teammate messages too
-- (still latched per conversation by peer_turn_budget). Flip the existing live
-- fleet on so deployed agents pick up the new default without re-enrollment;
-- agents an operator had explicitly left off are indistinguishable from the old
-- default, so this intentionally turns the whole fleet on.
UPDATE agents SET peer_autoreply = 1 WHERE peer_autoreply = 0;
