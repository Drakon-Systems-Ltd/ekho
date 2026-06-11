// The relay link is "stale" once auto-refresh has gone without a successful poll
// for longer than a few intervals — long enough to be a real outage, not a
// single dropped request. Mirrors the Command Deck's lastOkRef/stale heuristic.
export function isConnectionStale(lastOkAt, now, pollIntervalMs, factor = 2.5) {
  return now - lastOkAt > pollIntervalMs * factor;
}
