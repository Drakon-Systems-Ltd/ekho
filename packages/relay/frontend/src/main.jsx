import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import CommandDeck from "./CommandDeck";
import { ErrorBoundary } from "./components";
import "./styles.css";

// Hash route: #deck renders the full-screen Command Deck (its own auth + polling),
// anything else renders the operator console. Open #deck in its own tab/window to
// dedicate a monitor to it.
function Root() {
  const [hash, setHash] = React.useState(() => window.location.hash);
  React.useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return hash.startsWith("#deck") ? <CommandDeck /> : <App />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>
);
