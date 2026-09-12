import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { MotionRoot } from "./components/Animated";
import { readTokenFromHash } from "./api/client";
import { CONSOLE_ENABLED } from "./lib/appConfig";
// Self-hosted, bundled by vite — never a CDN link. The console is
// loopback-only and often offline; a webfont that needs the network would
// silently fall back to system-ui, which is exactly the bug this fixes.
// Self-hosted variable faces (CLAUDE.md "Frontend aesthetics"): the UI
// face, the display face with its optical-size axis, and the mono face.
// No CDN — the console is a loopback-only tool and must render with no
// network; the public app gets the same bytes from its own bundle.
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
// Tailwind rides in layers and is bridged to the tokens (see the file's
// header). base.css is imported FROM tailwind.css into its own `console`
// layer, below utilities — so a utility can override a console rule.
import "./styles/tailwind.css";

// CONSOLE surface only: the boot token arrives once in the URL fragment;
// stash it and strip it before anything renders. The public app must NOT
// run this — its magic-link sign-in also travels in the fragment, and a
// stray strip here would race the auth client reading it.
if (CONSOLE_ENABLED) readTokenFromHash();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <MotionRoot>
        <App />
      </MotionRoot>
    </BrowserRouter>
  </React.StrictMode>,
);
