import { useEffect, useMemo, useState } from "react";

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

