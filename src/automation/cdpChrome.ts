import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { getConfig } from "../config/index.js";
import {
  cdpUserDataDir,
  chromeCdpLaunchArgs,
  defaultCdpUrl,
  findChromeExecutable,
} from "../auth/loginFlow.js";
import { probeCdpEndpoint } from "../navigation/runNavigation.js";

/**
 * Ensure the operator's debug Chrome (the CDP endpoint the nav agent
 * attaches to) is running — launching it if the operator opted in with
 * CDP_AUTOLAUNCH_ENABLED. This exists because session 4a7c199b burned its
 * whole queue behind "CDP Chrome unreachable": the scheduled cycle fired
 * while the debug Chrome was closed, and nothing could start it.
 *
 * Same executable + same persistent profile as `npm run chrome:debug:jobright`
 * (src/auth/loginFlow.ts helpers), so the JobRight/Gmail logins the operator
 * performed once in that profile survive across launches. This launches the
 * operator's REAL Chrome as a detached OS process — it is not chromium.launch
 * and it is not a browser this process owns; the session seams still attach
 * to it via CDP like they always did.
 *
 * Fail-closed: without the flag this function only probes and reports.
 * Bounded: one spawn attempt, then a finite readiness poll.
 */
export type EnsureCdpReport = {
  reachable: boolean;
  launched: boolean;
  notes: string[];
};

export type EnsureCdpSeams = {
  probe?: (cdpUrl: string) => Promise<boolean>;
  /** Test seam: replaces the detached OS spawn. */
  spawner?: (command: string, args: string[]) => void;
  sleep?: (ms: number) => Promise<void>;
};

const READINESS_POLLS = 10;
const POLL_INTERVAL_MS = 1_500;

export async function ensureCdpChrome(
  seams: EnsureCdpSeams = {},
): Promise<EnsureCdpReport> {
  const cfg = getConfig();
  const probe = seams.probe ?? probeCdpEndpoint;
  const sleep =
    seams.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const report: EnsureCdpReport = { reachable: false, launched: false, notes: [] };

  if (await probe(cfg.agentCdpUrl)) {
    report.reachable = true;
    return report;
  }
  if (!cfg.cdpAutolaunchEnabled) {
    report.notes.push(
      "CDP Chrome unreachable and CDP_AUTOLAUNCH_ENABLED is off — not launching",
    );
    return report;
  }

  const chrome = findChromeExecutable();
  if (!chrome) {
    report.notes.push(
      "CDP autolaunch: Chrome executable not found (install Chrome or set CHROME_PATH)",
    );
    return report;
  }
  const userDataDir = cdpUserDataDir("jobright");
  assertDebugProfileDir(userDataDir);
  const port = new URL(defaultCdpUrl()).port || "9222";
  const args = chromeCdpLaunchArgs({ port, userDataDir, startUrl: "about:blank" });
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    if (seams.spawner) {
      seams.spawner(chrome, args);
    } else {
      const child = spawn(chrome, args, { detached: true, stdio: "ignore" });
      child.unref();
    }
    report.launched = true;
    report.notes.push(`CDP autolaunch: started debug Chrome on port ${port}`);
  } catch (err) {
    report.notes.push(
      `CDP autolaunch: spawn failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
    );
    return report;
  }

  for (let i = 0; i < READINESS_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    if (await probe(cfg.agentCdpUrl)) {
      report.reachable = true;
      return report;
    }
  }
  report.notes.push(
    `CDP autolaunch: endpoint still unreachable after ${READINESS_POLLS} polls — agent phase will be skipped`,
  );
  return report;
}

/**
 * Structural guard for every destructive/managing action in this module:
 * the target must be the DEDICATED debug profile (…/jobright-cdp), never
 * the operator's everyday Chrome. With the extension-first architecture
 * the operator may point AGENT_CDP_URL at an extension-bearing Chrome
 * they launched themselves — that Chrome is attach-only; autolaunch and
 * kill must refuse to manage it. An empty/mis-resolved dir would make
 * pkill -f dangerously broad, so that throws too.
 */
export function assertDebugProfileDir(userDataDir: string): void {
  const trimmed = (userDataDir ?? "").trim();
  const base = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "";
  if (trimmed.length < 8 || base !== "jobright-cdp") {
    throw new Error(
      `refusing to manage Chrome profile "${trimmed}" — only the dedicated jobright-cdp debug profile may be launched or killed by this process`,
    );
  }
}

/**
 * PIDs of every chrome.exe whose command line names the debug profile dir.
 * Windows: PowerShell CIM — `wmic` is REMOVED on Windows 11 24H2+ (live
 * 2026-08-30, build 26200: `where wmic` → not found), which made the old
 * kill a silent no-op. Non-Windows: pgrep -f. Empty on any tool failure.
 */
export function listDebugChromePids(userDataDir: string): number[] {
  assertDebugProfileDir(userDataDir);
  try {
    let out: string;
    if (process.platform === "win32") {
      const needle = userDataDir.replace(/'/g, "''");
      out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { $_.ProcessId }`,
        ],
        { timeout: 30_000, encoding: "utf8" },
      );
    } else {
      out = execFileSync("pgrep", ["-f", userDataDir], {
        timeout: 30_000,
        encoding: "utf8",
      });
    }
    return out
      .split(/\r?\n/)
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Kill ONLY the debug-profile Chrome: process match is on the debug
 * user-data-dir in the command line, so the operator's everyday Chrome
 * windows are never touched. Best-effort — "no process matched" is fine.
 *
 * Returns the PIDs it targeted so the caller can VERIFY they are gone: a
 * kill that does not terminate means the relaunch below is absorbed by the
 * still-running (wedged) instance via Chrome's single-instance handoff —
 * exactly how night18 reported "relaunched and reachable" three times
 * against the same dead process.
 */
function killDebugChrome(userDataDir: string): number[] {
  assertDebugProfileDir(userDataDir);
  const pids = listDebugChromePids(userDataDir);
  if (pids.length === 0) return pids;
  try {
    if (process.platform === "win32") {
      execFileSync(
        "taskkill",
        ["/F", ...pids.flatMap((p) => ["/PID", String(p)])],
        { timeout: 30_000 },
      );
    } else {
      execFileSync("kill", ["-9", ...pids.map(String)], { timeout: 30_000 });
    }
  } catch {
    // partial or failed kill — the post-kill liveness poll decides
  }
  return pids;
}

const KILL_VERIFY_POLLS = 10;
const KILL_VERIFY_INTERVAL_MS = 500;
const ATTACH_PROBE_TIMEOUT_MS = 15_000;

/**
 * The probe that actually matters: /json/version answering proves nothing
 * about a wedged Chrome (night18: the port answered for 45 minutes while
 * every attach timed out). Attach over CDP with a bounded timeout and
 * disconnect — never closes the operator's contexts (connectOverCDP
 * browser.close() only detaches).
 */
export async function probeCdpAttach(
  cdpUrl: string,
  timeoutMs = ATTACH_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
    await browser.close().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Session cc02e067: the debug Chrome degraded MID-SESSION — /json/version
 * still answered but Playwright's CDP attach failed, and 7 of 13 apps died
 * with "Close ALL Chrome windows, re-run" at 02:50 with nobody there. With
 * the operator's CDP_AUTOLAUNCH_ENABLED standing opt-in, the cycle repairs
 * this itself: kill the stale debug-profile Chrome, relaunch it, re-probe.
 * Fail-closed without the flag; the caller bounds attempts (once/session).
 */
export async function restartCdpChrome(
  seams: EnsureCdpSeams & {
    /** Returns the PIDs it targeted (empty = nothing to kill). */
    killer?: (userDataDir: string) => number[] | void;
    /** Post-kill liveness check; the restart refuses to relaunch over survivors. */
    survivors?: (userDataDir: string) => number[];
    /** Real CDP attach after relaunch — the HTTP probe alone lied (night18). */
    attachProbe?: (cdpUrl: string) => Promise<boolean>;
  } = {},
): Promise<EnsureCdpReport> {
  const cfg = getConfig();
  if (!cfg.cdpAutolaunchEnabled) {
    return {
      reachable: false,
      launched: false,
      notes: ["CDP restart refused: CDP_AUTOLAUNCH_ENABLED is off"],
    };
  }
  const sleep =
    seams.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const userDataDir = cdpUserDataDir("jobright");
  const targeted = (seams.killer ?? killDebugChrome)(userDataDir) ?? [];
  const survivors = seams.survivors ?? listDebugChromePids;

  // Verify the kill landed before relaunching: a survivor absorbs the new
  // spawn (single-instance handoff) and the "relaunch" is theatre.
  let alive = survivors(userDataDir);
  for (let i = 0; alive.length > 0 && i < KILL_VERIFY_POLLS; i++) {
    await sleep(KILL_VERIFY_INTERVAL_MS);
    alive = survivors(userDataDir);
  }
  if (alive.length > 0) {
    return {
      reachable: false,
      launched: false,
      notes: [
        `CDP restart: debug-profile Chrome did not terminate (pids ${alive.slice(0, 5).join(",")} still alive after kill) — relaunch would be absorbed by the wedged instance; not relaunching`,
      ],
    };
  }

  await sleep(2_000);
  const report = await ensureCdpChrome(seams);
  report.notes.unshift(
    targeted.length > 0
      ? `CDP restart: killed stale debug-profile Chrome (pids ${targeted.slice(0, 5).join(",")})`
      : "CDP restart: no debug-profile Chrome was running — relaunching",
  );
  if (report.reachable) {
    const attached = await (seams.attachProbe ?? probeCdpAttach)(cfg.agentCdpUrl);
    if (!attached) {
      report.reachable = false;
      report.notes.push(
        "CDP restart: port answers but a real CDP attach still fails after relaunch — not recovered",
      );
    } else {
      report.notes.push("CDP restart: attach probe passed (LIVE_READ_ONLY_CONFIRMED)");
    }
  }
  return report;
}
