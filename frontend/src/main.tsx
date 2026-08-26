import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { MotionRoot } from "./components/Animated";
import { readTokenFromHash } from "./api/client";
// Self-hosted, bundled by vite — never a CDN link. The console is
// loopback-only and often offline; a webfont that needs the network would
// silently fall back to system-ui, which is exactly the bug this fixes.
import "@fontsource-variable/inter";
import "./styles/tokens.css";
// Tailwind rides in layers and is bridged to the tokens (see the file's
// header); unlayered base.css always wins where they disagree.
import "./styles/tailwind.css";
import "./styles/base.css";

// The boot token arrives once in the URL fragment; stash it and strip it
// from the address bar before anything renders.
readTokenFromHash();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <MotionRoot>
        <App />
      </MotionRoot>
    </BrowserRouter>
  </React.StrictMode>,
);
