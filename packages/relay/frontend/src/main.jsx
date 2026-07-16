import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "./components";

// Hash routes, lazy-loaded so each surface's stylesheet only loads with it:
//   (default)  Wire — the messenger-first operator console (wire.css)
//   #classic   the previous operator console (styles.css), kept as a fallback
//   #deck      the full-screen Command Deck (deck.css, own auth + polling)
// Crossing between route families reloads the page so the global stylesheets
// of the two console skins can never fight in one document.
const WireApp = React.lazy(() => import("./WireApp"));
const ClassicApp = React.lazy(() => import("./App"));
const CommandDeck = React.lazy(() => import("./CommandDeck"));

function family(hash) {
  if (hash.startsWith("#deck")) return "deck";
  if (hash.startsWith("#classic")) return "classic";
  return "wire";
}

function Root() {
  const initial = React.useRef(family(window.location.hash));
  const [route, setRoute] = React.useState(initial.current);
  React.useEffect(() => {
    const onHash = () => {
      const next = family(window.location.hash);
      if (next !== initial.current) window.location.reload();
      else setRoute(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const fallback = <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", color: "#8B91A1", fontFamily: "system-ui" }}>Loading…</div>;
  return (
    <React.Suspense fallback={fallback}>
      {route === "deck" ? <CommandDeck /> : route === "classic" ? <ClassicApp /> : <WireApp />}
    </React.Suspense>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>
);
