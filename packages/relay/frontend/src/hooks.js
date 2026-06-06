import { useEffect, useMemo, useRef, useState } from "react";

export function useAutoRefresh(enabled, intervalMs, callback, deps = []) {
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      callback();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, callback, ...deps]);
}

export function useQueryState(initialState) {
  const [query, setQuery] = useState(initialState);

  function updateQuery(next) {
    setQuery((current) => ({ ...current, ...next }));
  }

  function resetQuery() {
    setQuery(initialState);
  }

  return { query, updateQuery, resetQuery };
}

export function useFilteredCollection(collection, predicate, deps = []) {
  return useMemo(() => collection.filter(predicate), [collection, predicate, ...deps]);
}

// iOS-style left-edge swipe-back. Returns touch handlers to spread onto an
// element; a drag that STARTS within `edge` px of the left screen edge and moves
// right past `threshold` px (more horizontally than vertically) fires onBack.
// Only arms on viewports matching `query` (mobile), so desktop is untouched. It
// never calls preventDefault, so vertical scrolling in the element is unaffected.
export function useEdgeSwipeBack(onBack, { edge = 24, threshold = 70, query = "(max-width: 960px)" } = {}) {
  const drag = useRef(null);

  const onTouchStart = (e) => {
    if (typeof window !== "undefined" && window.matchMedia && !window.matchMedia(query).matches) return;
    const t = e.touches && e.touches[0];
    if (!t || t.clientX > edge) {
      drag.current = null;
      return;
    }
    drag.current = { x0: t.clientX, y0: t.clientY, dx: 0, horizontal: false };
  };

  const onTouchMove = (e) => {
    const d = drag.current;
    const t = e.touches && e.touches[0];
    if (!d || !t) return;
    const dx = t.clientX - d.x0;
    const dy = t.clientY - d.y0;
    if (!d.horizontal && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) d.horizontal = true;
    if (d.horizontal) d.dx = dx;
  };

  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.horizontal && d.dx > threshold) onBack();
  };

  return { onTouchStart, onTouchMove, onTouchEnd };
}

// Re-renders once a minute so relative timestamps stay fresh without per-tick churn.
export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
