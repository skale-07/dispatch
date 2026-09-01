import { apiGet } from "../api/client";
import type { Summary } from "../api/types";
import { usePoll } from "../hooks/usePoll";
import { deriveStatus } from "../lib/appStatus";
import { BarChart } from "./charts/bar-chart";
import { Bar } from "./charts/bar";
import { Grid } from "./charts/grid";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

/**
 * The time-given-back story, told only with real numbers.
 *
 * Submitted count comes from /api/summary (the same states the rest of
 * the console calls "submitted"); the per-day series is /api/insights'
 * verified fill runs. Hours are DERIVED, and say so on the tile: a manual
 * application runs about 20-40 minutes, so the range is submitted x 20min
 * to submitted x 40min — a range, not a made-up precision. Two measures,
 * one unit family, so no dual axis: the chart draws the count and the
 * stat tiles carry the derived headline (dataviz form rule).
 *
 * Fail-closed honesty: console unreachable or zero data renders an empty
 * state that says which, never a fabricated chart.
 */

type InsightsSlice = {
  fill_runs_daily: Array<{
    date: string;
    attempted: number;
    verified: number;
    failed: number;
  }>;
};

const MANUAL_MINUTES_LOW = 20;
const MANUAL_MINUTES_HIGH = 40;

function hours(count: number, minutesPer: number): string {
  const h = (count * minutesPer) / 60;
  return h >= 10 ? String(Math.round(h)) : (Math.round(h * 10) / 10).toString();
}

export function TimeSaved(): JSX.Element {
  const summary = usePoll<Summary>(() => apiGet<Summary>("/api/summary"), 30000);
  const insights = usePoll<InsightsSlice>(
    () => apiGet<InsightsSlice>("/api/insights"),
    60000,
  );

  if (summary.loading && !summary.data) {
    return (
      <div className="skeleton-lines">
        <Skeleton width="60%" />
        <Skeleton width="40%" />
      </div>
    );
  }

  if (!summary.data) {
    return (
      <EmptyState
        icon="alert"
        title="The console isn't running, so there's nothing to count"
        body="This section only ever shows real numbers from your own database — no console, no chart. Start it and this fills in."
      />
    );
  }

  const submitted = summary.data.applications_by_state
    .filter((s) => deriveStatus(s.state, false) === "submitted")
    .reduce((n, s) => n + s.n, 0);

  if (submitted === 0) {
    return (
      <EmptyState
        icon="clock"
        title="No applications submitted yet"
        body="Once Dispatch submits for you, this shows the count — and the hours of form-filling you didn't do."
      />
    );
  }

  const daily = insights.data?.fill_runs_daily ?? [];
  const chartData = daily.map((d) => ({
    name: d.date.slice(5),
    verified: d.verified,
  }));

  return (
    <>
      <div className="stat-row" style={{ marginTop: "0.25rem" }}>
        <div className="stat">
          <div className="label">applications submitted</div>
          <div className="value">{submitted}</div>
          <div className="hint">with a screenshot receipt for each</div>
        </div>
        <div className="stat">
          <div className="label">hours you didn&apos;t spend on forms</div>
          <div className="value">
            {hours(submitted, MANUAL_MINUTES_LOW)}–{hours(submitted, MANUAL_MINUTES_HIGH)}
          </div>
          <div className="hint">
            at 20–40 min per manual application — a range, not a guess
          </div>
        </div>
      </div>
      {chartData.length > 0 ? (
        <>
          <BarChart
            data={chartData}
            xDataKey="name"
            aspectRatio="3 / 1"
            animationDuration={600}
          >
            <Grid horizontal />
            <Bar dataKey="verified" fill="var(--accent)" />
          </BarChart>
          <p className="faint" style={{ margin: "0.5rem 0 0" }}>
            forms filled and read back verified, per day — from your own run
            history
          </p>
        </>
      ) : (
        <p className="faint" style={{ margin: "0.5rem 0 0" }}>
          {insights.error
            ? "per-day history unavailable right now — the totals above are still real"
            : "per-day history appears after the first recorded fill run"}
        </p>
      )}
    </>
  );
}
