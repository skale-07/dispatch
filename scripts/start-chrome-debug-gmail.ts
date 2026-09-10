#!/usr/bin/env node
/**
 * #233 (operator directive 2026-09-10): a SECOND debug Chrome, dedicated to
 * the Gmail tail, so drafting and verification-code reads never compete
 * with the applier for the browser it is typing into.
 *
 * Chrome locks a running profile's cookie store, so the obvious approach —
 * copy the jobright debug profile — dies on EBUSY at
 * `Default\Network\Cookies`, which is the one file that matters. Instead
 * the session is carried across the way Playwright's storage state does
 * it: read the cookies out of the RUNNING applier browser over CDP, start
 * a second Chrome on its own profile, and inject them there. No file the
 * other process holds is ever touched, and the transfer works while the
 * applier is mid-application.
 *
 * Usage: npm run chrome:debug:gmail            (default port 9223)
 *        npm run chrome:debug:gmail -- --port 9333
 * Then set OUTREACH_CDP_URL=http://127.0.0.1:9223 in .env.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Cookie } from "playwright";
import {
  cdpUserDataDir,
  chromeCdpLaunchArgs,
  findChromeExecutable,
} from "../src/auth/loginFlow.js";
import { getConfig } from "../src/config/index.js";

const DEFAULT_PORT = "9223";
const portFlagIndex = process.argv.indexOf("--port");
const port =
  portFlagIndex >= 0 && process.argv[portFlagIndex + 1]
    ? String(process.argv[portFlagIndex + 1])
    : DEFAULT_PORT;

const chrome = findChromeExecutable();
if (!chrome) {
  console.error("Google Chrome not found. Install Chrome or set CHROME_PATH to chrome.exe");
  process.exit(1);
}

const applierCdp = getConfig().agentCdpUrl;
const applierDir = cdpUserDataDir("jobright");
const gmailDir = path.join(path.dirname(applierDir), "gmail-cdp");
const cdpUrl = `http://127.0.0.1:${port}`;

const reachable = async (url: string): Promise<boolean> => {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2_000);
    const res = await fetch(new URL("/json/version", url), { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
};

if (await reachable(cdpUrl)) {
  console.log(`Gmail debug Chrome already answering on ${cdpUrl} — nothing to do.`);
  process.exit(0);
}

/**
 * Cookies out of the running applier browser — ONLY on a first launch.
 *
 * Once this profile exists it holds its own Google session (the operator
 * signs in once in this window), and Google binds a session to the profile
 * anyway, so a transfer would add nothing. It would also fight the applier:
 * attaching to that browser mid-fill times out, which is exactly what
 * happened on the night29 relaunch. A profile that exists is left alone.
 */
const firstLaunch = !fs.existsSync(gmailDir);
let cookies: Cookie[] = [];
if (!firstLaunch) {
  console.log(`Reusing the existing Gmail profile at ${gmailDir} (no cookie transfer needed)`);
} else if (await reachable(applierCdp)) {
  const browser = await chromium.connectOverCDP(applierCdp, { timeout: 20_000 });
  try {
    const context = browser.contexts()[0];
    if (context) cookies = await context.cookies();
  } finally {
    await browser.close().catch(() => undefined);
  }
  console.log(`Read ${cookies.length} cookie(s) from the applier browser at ${applierCdp}`);
} else {
  console.log(
    `Applier browser at ${applierCdp} is not running — starting Gmail Chrome with whatever ` +
      `session its own profile already holds.`,
  );
}

fs.mkdirSync(gmailDir, { recursive: true });
console.log(`Starting Gmail debug Chrome on ${cdpUrl} (profile: ${gmailDir})`);
const child = spawn(
  chrome,
  chromeCdpLaunchArgs({ port, userDataDir: gmailDir, startUrl: "about:blank" }),
  { detached: true, stdio: "ignore" },
);
child.unref();

// Bounded readiness poll — no unbounded wait loops.
let ready = false;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1_000));
  if (await reachable(cdpUrl)) {
    ready = true;
    break;
  }
}
if (!ready) {
  console.error(`Gmail Chrome did not answer on ${cdpUrl} within 20s.`);
  process.exit(1);
}

if (cookies.length > 0) {
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 20_000 });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("new Chrome exposed no browser context");
    await context.addCookies(cookies);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://mail.google.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`Injected ${cookies.length} cookie(s); Gmail opened at ${page.url()}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

console.log("");
console.log(`Ready. Set in .env:  OUTREACH_CDP_URL=${cdpUrl}`);
