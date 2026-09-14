#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { getConfig } from "../config/index.js";
import { assessPremiumText } from "../tenants/capture.js";
import { redactConnectUrl, resolveRemoteBrowserProvider } from "./remoteBrowser.js";

/**
 * The M16 spike, as a command (docs/roadmap/browserbase-spike-2026-09-14.md):
 *
 *   npm run remote:probe -- [--wait <sec>] [--out <file>]
 *
 * Behind REMOTE_BROWSER_ENABLED (+ BROWSERBASE_API_KEY / PROJECT_ID, which
 * env.ts already demands). Creates ONE remote session, prints its live-view
 * URL, waits for you to sign in to JobRight there (Enter, or --wait
 * seconds), then attaches to the SAME session through the ordinary
 * session seam (CDP_ATTACH with the provider's connect URL — the policy in
 * src/auth/cdpPolicy.ts admits it because the flag is on), validates the
 * JobRight app shell the way every engine run does, reads the
 * storageState, and releases the session. The captured state is written
 * to private/cloud/spike/jobright.storage.json (gitignored) so you can
 * inspect it or validate it headless; it never touches your own
 * private/auth/. Every step is timed and reported as JSON — that report
 * is the spike's evidence.
 *
 * Nothing is submitted, drafted or stored in the cloud.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function waitForOperator(seconds: number | undefined): Promise<string> {
  if (seconds !== undefined) {
    await new Promise((r) => setTimeout(r, Math.max(1, seconds) * 1000));
    return `waited ${seconds}s`;
  }
  if (!process.stdin.isTTY) return "no TTY and no --wait: continuing immediately";
  process.stdout.write("Sign in to JobRight in the live view, then press Enter here... ");
  await new Promise<void>((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => resolve());
    process.stdin.resume();
  });
  process.stdin.pause();
  return "operator pressed Enter";
}

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.remoteBrowserEnabled) {
    throw new Error("REMOTE_BROWSER_ENABLED is false (fail-closed default). Set it (+ BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID) in .env to run the spike.");
  }
  const provider = resolveRemoteBrowserProvider(config);
  const waitSec = arg("--wait") !== undefined ? Number(arg("--wait")) : undefined;
  const out = arg("--out") ?? path.join(config.privateDir, "cloud", "spike", "jobright.storage.json");
  const report: Record<string, unknown> = { provider: provider.name, started_at: new Date().toISOString(), steps: [] as unknown[] };
  const steps = report["steps"] as Array<Record<string, unknown>>;
  const t0 = Date.now();
  const step = (name: string, extra: Record<string, unknown> = {}): void => {
    steps.push({ name, at_ms: Date.now() - t0, ...extra });
  };

  let sessionId: string | null = null;
  let session: PlaywrightServiceSession | null = null;
  try {
    const remote = await provider.createSession({ userId: "spike" });
    sessionId = remote.sessionId;
    step("session_created", { session_id: remote.sessionId, connect: redactConnectUrl(remote.connectUrl), expires_at: remote.expiresAt });
    console.error(`\nLIVE VIEW: ${remote.liveViewUrl}\n`);
    step("waited", { how: await waitForOperator(waitSec) });

    session = new PlaywrightServiceSession({ service: "jobright", mode: "CDP_ATTACH", cdpUrl: remote.connectUrl, skipAuthValidation: true });
    await session.open();
    step("attached");
    const validation = await session.validate();
    step("validated", { ok: validation.ok, status: validation.status, reason: validation.reason, url: validation.url });

    let premium = "unknown";
    try {
      const page = await session.newPage({ purpose: "premium probe" });
      await page.goto("https://jobright.ai/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      premium = assessPremiumText(await page.locator("body").innerText().catch(() => ""));
      await page.close().catch(() => undefined);
    } catch {
      premium = "unknown";
    }
    step("premium_probe", { premium });

    if (validation.ok) {
      const state = (await session.getContext().storageState()) as { cookies?: unknown[]; origins?: unknown[] };
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      step("captured", { out, cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0 });
    } else {
      step("not_captured", { why: "validation did not pass — sign-in did not complete in the remote browser (or the app shell did not render)" });
    }
    report["outcome"] = validation.ok ? "captured" : "not_signed_in";
  } catch (err) {
    report["outcome"] = "error";
    report["error"] = err instanceof Error ? err.message : String(err);
  } finally {
    if (session) await session.close().catch(() => undefined);
    if (sessionId) {
      await provider.endSession(sessionId).catch((e: unknown) => {
        step("release_failed", { error: e instanceof Error ? e.message : String(e) });
      });
      step("released");
    }
  }
  report["finished_at"] = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  if (report["outcome"] !== "captured") process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
