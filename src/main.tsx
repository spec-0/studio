import React from "react";
import ReactDOM from "react-dom/client";
// Bundled, not fetched: a desktop app shouldn't reach the network to render text,
// and these are the two faces the spec0 design system actually specifies.
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { isMac } from "./lib/platform";
import "./styles.css";

// Lets the stylesheet leave room for the macOS traffic lights only where they exist.
document.documentElement.classList.add(isMac ? "platform-mac" : "platform-other");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
