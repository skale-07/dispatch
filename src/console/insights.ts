import fs from "node:fs";
import path from "node:path";
import type { Db } from "../storage/db/client.js";

/**
 * U3: the Insights read model — the numbers Dispatch already accumulates,
 * shaped for charts instead of tables. Read-only over SQLite plus a
 * BOUNDED scan of the newest fill-report artifacts for the classed
 * CAPTCHA incidents (C2 telemetry lives on the reports, not in the DB).
 * Everything here is aggregate: labels are hosts, states and providers —
 * never candidate data, never answer values.
 */

export type InsightsView = {
  fill_runs_daily: Array<{
    date: string;
    attempted: number;
    verified: number;
    failed: number;
  }>;
  /**
   * True submissions per day, straight from the state machine's
   * SUBMITTED transitions (application_events) — the series the
   * frontend's TimeSaved chart pairs with its "applications submitted"
   * tile. DISTINCT application_id so a re-walked transition can never
   * double-count an application.
   */
  submissions_daily: Array<{ date: string; submitted: number }>;
  pipeline_states: Array<{ state: string; count: number }>;
  discovery_sources: Array<{
    source: string;
    jobs: number;
    applications: number;
    completed: number;
  }>;
  captcha_incidents: Array<{
    host: string;
    provider: string;
    count: number;
    cleared: number;
  }>;
  captcha_files_scanned: number;
  notes: string[];
};

/** A pathological artifacts dir must not stall the console. */
const MAX_CAPTCHA_FILES = 400;

export function buildInsightsView(db: Db, artifactsDir: string): InsightsView {
  const notes: string[] = [];

  const fillDaily = (
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS date,
                COUNT(*) AS attempted,
                SUM(CASE WHEN verify_passed = 1 THEN 1 ELSE 0 END) AS verified
         FROM fill_runs
         GROUP BY substr(created_at, 1, 10)
         ORDER BY date DESC
         LIMIT 30`,
      )
      .all() as Array<{ date: string; attempted: number; verified: number | null }>
  )
    .reverse()
    .map((r) => ({
      date: r.date,
      attempted: r.attempted,
      verified: r.verified ?? 0,
      failed: r.attempted - (r.verified ?? 0),
    }));

  const submissionsDaily = (
    db
      .prepare(
        `SELECT substr(timestamp, 1, 10) AS date,
                COUNT(DISTINCT application_id) AS submitted
         FROM application_events
         WHERE next_state = 'SUBMITTED'
         GROUP BY substr(timestamp, 1, 10)
         ORDER BY date DESC
         LIMIT 30`,
      )
      .all() as Array<{ date: string; submitted: number }>
  ).reverse();

  const pipelineStates = db
    .prepare(
      `SELECT state, COUNT(*) AS count FROM applications
       GROUP BY state ORDER BY count DESC`,
    )
    .all() as Array<{ state: string; count: number }>;

  const discoverySources = db
    .prepare(
      `SELECT COALESCE(j.source_ats, 'unknown') AS source,
              COUNT(DISTINCT j.id) AS jobs,
              COUNT(a.id) AS applications,
              SUM(CASE WHEN a.state = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
       FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
       GROUP BY COALESCE(j.source_ats, 'unknown')
       ORDER BY jobs DESC`,
    )
    .all() as Array<{
    source: string;
    jobs: number;
    applications: number;
    completed: number | null;
  }>;

  const captcha = scanCaptchaIncidents(artifactsDir, notes);

  return {
    fill_runs_daily: fillDaily,
    submissions_daily: submissionsDaily,
    pipeline_states: pipelineStates,
    discovery_sources: discoverySources.map((d) => ({
      ...d,
      completed: d.completed ?? 0,
    })),
    captcha_incidents: captcha.incidents,
    captcha_files_scanned: captcha.scanned,
    notes,
  };
}

function scanCaptchaIncidents(
  artifactsDir: string,
  notes: string[],
): {
  incidents: InsightsView["captcha_incidents"];
  scanned: number;
} {
  const byKey = new Map<
    string,
    { host: string; provider: string; count: number; cleared: number }
  >();
  let scanned = 0;
  try {
    const files: Array<{ full: string; mtime: number }> = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.name.endsWith(".json")) {
          try {
            files.push({ full, mtime: fs.statSync(full).mtimeMs });
          } catch {
            /* raced deletion — skip */
          }
        }
      }
    };
    const base = path.join(artifactsDir, "ats-fill");
    if (fs.existsSync(base)) walk(base, 0);
    files.sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(0, MAX_CAPTCHA_FILES)) {
      scanned += 1;
      try {
        const report = JSON.parse(fs.readFileSync(f.full, "utf8")) as {
          captcha_incident?: {
            host?: string;
            provider?: string;
            cleared?: boolean | null;
          };
        };
        const inc = report.captcha_incident;
        if (!inc || typeof inc.host !== "string") continue;
        const provider = typeof inc.provider === "string" ? inc.provider : "unknown";
        const key = `${inc.host}|${provider}`;
        const row = byKey.get(key) ?? {
          host: inc.host,
          provider,
          count: 0,
          cleared: 0,
        };
        row.count += 1;
        if (inc.cleared === true) row.cleared += 1;
        byKey.set(key, row);
      } catch {
        /* not a report / unreadable — skip, never fail the view */
      }
    }
    if (files.length > MAX_CAPTCHA_FILES) {
      notes.push(
        `captcha scan capped at newest ${MAX_CAPTCHA_FILES} of ${files.length} reports`,
      );
    }
  } catch (err) {
    notes.push(
      `captcha scan failed open: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
    );
  }
  return {
    incidents: [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    scanned,
  };
}
