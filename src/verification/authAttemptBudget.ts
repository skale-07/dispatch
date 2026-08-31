import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";

/**
 * #93 (operator directive 2026-08-31): per-HOST auth attempt budget,
 * persistent across runs. Night20-21: three mechanical bugs made TIAA
 * sign-ins look "silent", the pipeline re-attempted ~35 times across
 * two nights, and the tenant bot-flagged the account — converting a
 * fixable bug into an operator-scope outage. Silent/failed auth on a
 * host now burns budget; when it is exhausted, portalAuth refuses FAST
 * with the cool-down named instead of hammering. A successful sign-in
 * clears the host's ledger.
 *
 * Storage: private/auth-attempts.json (0600, gitignored like the vault).
 * Timestamps only — never credentials, never page content.
 */
const MAX_FAILURES = 3;
const WINDOW_MS = 6 * 60 * 60 * 1000; // 6h

type Ledger = Record<string, number[]>;

function ledgerPath(): string {
  return path.join(getConfig().privateDir, "auth-attempts.json");
}

function readLedger(): Ledger {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(), "utf8"));
    return typeof raw === "object" && raw !== null ? (raw as Ledger) : {};
  } catch {
    return {};
  }
}

function writeLedger(l: Ledger): void {
  fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
  fs.writeFileSync(ledgerPath(), JSON.stringify(l, null, 2), { mode: 0o600 });
}

function recentFailures(l: Ledger, host: string, now: number): number[] {
  return (l[host.toLowerCase()] ?? []).filter((t) => now - t < WINDOW_MS);
}

/**
 * null ⇒ budget available. A string ⇒ refuse auth NOW; the string names
 * the failure count and when the window reopens.
 */
export function authBudgetExhausted(host: string, now = Date.now()): string | null {
  const recent = recentFailures(readLedger(), host, now);
  if (recent.length < MAX_FAILURES) return null;
  const reopensAt = new Date(Math.min(...recent) + WINDOW_MS);
  return (
    `auth attempt budget exhausted for ${host} (${recent.length} failed/silent ` +
    `attempts in the last 6h) — cooling down until ${reopensAt.toISOString()} ` +
    `or one manual operator sign-in (which resets the ledger on the next success)`
  );
}

/** A failed or SILENT auth outcome burns one unit of the host's budget. */
export function recordAuthFailure(host: string, now = Date.now()): void {
  const l = readLedger();
  const key = host.toLowerCase();
  l[key] = [...recentFailures(l, key, now), now];
  writeLedger(l);
}

/** A confirmed sign-in / verified account creation clears the host. */
export function clearAuthFailures(host: string): void {
  const l = readLedger();
  delete l[host.toLowerCase()];
  writeLedger(l);
}
