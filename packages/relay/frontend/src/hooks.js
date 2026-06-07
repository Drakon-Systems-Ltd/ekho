import { useEffect, useMemo, useRef, useState } from "react";

export function useAutoRefresh(enabled, intervalMs, callback, deps = []) {
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let timer = null;
    const start = () => {
      if (timer == null) timer = window.setInterval(() => callback(), intervalMs);
    };
    const stop = () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    // A backgrounded tab stops hitting the relay; on return we catch up once
    // immediately, then resume the interval. Saves battery on a left-open console.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        callback();
        start();
      }
    };

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, callback, ...deps]);
}

// Tracks page visibility so heavy views can pause polling + animations when the
// tab is hidden. Returns true while visible, false while backgrounded.
export function usePageVisible() {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden"
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
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
    if (drag.current) return; // an in-progress swipe owns the gesture — ignore extra fingers
    if (typeof window !== "undefined" && window.matchMedia && !window.matchMedia(query).matches) return;
    const t = e.touches && e.touches[0];
    if (!t || t.clientX > edge) return;
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

  // touchcancel (e.g. the OS taking over the gesture) drops the in-progress drag
  // so it can't survive to fire a spurious back on a later touchend.
  const onTouchCancel = () => { drag.current = null; };

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel };
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
