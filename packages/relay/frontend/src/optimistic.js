// Reconcile pending ("optimistic") operator messages against the server-echoed
// conversation timeline. An optimistic bubble is shown the instant the operator
// hits send; once the relay echoes that message back into the timeline we drop
// the placeholder so the real, signed copy takes over.
//
// We match on the real message id we bound at send time — NOT on text. Two
// messages with identical text ("ok", "ping", "yes") each carry their own id,
// so they reconcile independently instead of vanishing together the moment the
// first one is echoed.
export function reconcileOptimistic(optimistic, events, conversationId) {
  const echoed = new Set(
    (events || [])
      .filter((e) => e && e.resource_id)
      .map((e) => String(e.resource_id))
  );
  return (optimistic || []).filter((o) => {
    if (o.conversationId !== conversationId) return true; // another thread — untouched
    if (o.messageId) return !echoed.has(String(o.messageId)); // bound → drop once echoed
    return true; // send still in flight (no id yet) — keep until it resolves
  });
}
