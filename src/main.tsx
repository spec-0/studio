import React from "react";
import ReactDOM from "react-dom/client";
// Bundled, not fetched — a desktop app shouldn't reach the network to render text,
// and these are the two faces the spec0 design system actually specifies.
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
