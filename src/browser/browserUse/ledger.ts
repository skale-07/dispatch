import fs from "node:fs";
import path from "node:path";

/**
 * Append-only record of every Browser Use resource this engine created or
 * acted on (run created / cancelled / validated, browser created /
 * stopped), so spend can be reconciled against the provider's list even
 * when a process died mid-run. Lives under private/ (gitignored): task
 * text may carry candidate facts. Never a key, never a cdpUrl.
 */

export type LedgerInput = {
  kind: "run" | "browser";
  id: string;
  action: string;
  [k: string]: unknown;
};

export type LedgerEntry = LedgerInput & { at: string };

export type Ledger = {
  append(entry: LedgerInput): void;
};

export const LEDGER_RELPATH = path.join("browser-use", "ledger.jsonl");

export function fileLedger(privateDir: string, now: () => Date = () => new Date()): Ledger {
  const file = path.join(privateDir, LEDGER_RELPATH);
  return {
    append(entry) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`, "utf8");
    },
  };
}

/** Run ids this engine created (per the ledger) — the only runs a sweep may cancel. */
export function readLedgerRunIds(privateDir: string): Set<string> {
  const file = path.join(privateDir, LEDGER_RELPATH);
  const ids = new Set<string>();
  if (!fs.existsSync(file)) return ids;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<LedgerEntry>;
      if (e.kind === "run" && e.action === "created" && typeof e.id === "string") ids.add(e.id);
    } catch {
      // a torn last line from a crash is not evidence of anything
    }
  }
  return ids;
}

export function memoryLedger(now: () => Date = () => new Date()): Ledger & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    entries,
    append(entry) {
      const full: LedgerEntry = { ...entry, at: now().toISOString() };
      entries.push(full);
    },
  };
}

export const nullLedger: Ledger = { append() {} };
