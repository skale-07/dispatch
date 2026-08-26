import { apiGet } from "../api/client";
import { usePoll } from "../hooks/usePoll";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { AreaChart } from "../components/charts/area-chart";
import { Area } from "../components/charts/area";
import { BarChart } from "../components/charts/bar-chart";
import { Bar } from "../components/charts/bar";
import { RingChart } from "../components/charts/ring-chart";
import { Ring } from "../components/charts/ring";
import { Grid } from "../components/charts/grid";

/**
 * U3: the numbers Dispatch already keeps, drawn instead of tabulated.
 * Everything is aggregate — states, hosts, providers, counts — never a
 * candidate's answers. Charts are Bklit registry components recolored
 * entirely through the token bridge (see styles/tailwind.css), so they
 * follow light/dark like every other surface.
 */

type Insights = {
  fill_runs_daily: Array<{
    date: string;
    attempted: number;
    verified: number;
    failed: number;
  }>;
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

export function InsightsPage(): JSX.Element {
  const { data, error, loading } = usePoll<Insights>(
    () => apiGet<Insights>("/api/insights"),
    30000,
  );

  return (
    <>
      <div className="page-head">
        <h1>Insights</h1>
        <div className="sub">
          What the run history adds up to — fills, pipeline, sources, walls
        </div>
      </div>

      {error ? <div className="banner danger">{error}</div> : null}
      {loading && !data ? (
        <div className="skeleton-lines">
          <Skeleton width="60%" />
          <Skeleton width="80%" />
        </div>
      ) : null}

      {data ? (
        <>
          <div className="card">
            <h2>Fill runs per day</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Verified read-backs vs. runs that fell short, last 30 active days.
            </p>
            {data.fill_runs_daily.length === 0 ? (
              <EmptyState
                icon="file"
                title="No fill runs recorded yet"
                body="Run a fill (or a pipeline cycle) and this chart starts filling in."
              />
            ) : (
              <AreaChart
                data={data.fill_runs_daily}
                xDataKey="date"
                aspectRatio="3 / 1"
                animationDuration={600}
              >
                <Grid horizontal />
                <Area dataKey="verified" fill="var(--ok)" />
                <Area dataKey="failed" fill="var(--danger)" />
              </AreaChart>
            )}
          </div>

          <div className="card">
            <h2>Where every application stands</h2>
            {data.pipeline_states.length === 0 ? (
              <EmptyState
                icon="file"
                title="No applications yet"
                body="Enqueue a job and the pipeline shows up here."
              />
            ) : (
              <BarChart
                data={data.pipeline_states.map((s) => ({
                  name: s.state.toLowerCase().replace(/_/g, " "),
                  count: s.count,
                }))}
                xDataKey="name"
                aspectRatio="3 / 1"
                animationDuration={600}
              >
                <Bar dataKey="count" fill="var(--accent)" />
              </BarChart>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div className="card">
              <h2>Jobs by source</h2>
              <p className="muted" style={{ marginTop: 0 }}>
                Each ring is a source: full circle = every application from it
                completed.
              </p>
              {data.discovery_sources.length === 0 ? (
                <EmptyState icon="file" title="No jobs yet" />
              ) : (
                <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
                  <RingChart
                    size={200}
                    data={data.discovery_sources.slice(0, 4).map((s) => ({
                      label: s.source,
                      value: s.completed,
                      maxValue: Math.max(1, s.applications),
                    }))}
                  >
                    {data.discovery_sources.slice(0, 4).map((s, i) => (
                      <Ring
                        key={s.source}
                        index={i}
                        color={`var(--chart-${i + 1})`}
                      />
                    ))}
                  </RingChart>
                  <ul className="faint" style={{ fontSize: "12.5px", margin: 0 }}>
                    {data.discovery_sources.map((s) => (
                      <li key={s.source}>
                        <span className="mono">{s.source}</span>: {s.jobs} jobs ·{" "}
                        {s.applications} applications · {s.completed} completed
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="card">
              <h2>CAPTCHA walls</h2>
              <p className="muted" style={{ marginTop: 0 }}>
                Classed incidents from the newest {data.captcha_files_scanned}{" "}
                fill reports — site and challenge type only.
              </p>
              {data.captcha_incidents.length === 0 ? (
                <EmptyState
                  icon="check"
                  title="No blocking CAPTCHAs recorded"
                  tone="good"
                  body="When a run hits one, it lands here with the host and provider."
                />
              ) : (
                <BarChart
                  data={data.captcha_incidents.map((c) => ({
                    name: `${c.host} · ${c.provider}`,
                    count: c.count,
                  }))}
                  xDataKey="name"
                  aspectRatio="2 / 1"
                  animationDuration={600}
                >
                  <Bar dataKey="count" fill="var(--warn)" />
                </BarChart>
              )}
            </div>
          </div>

          {data.notes.length > 0 ? (
            <p className="faint" style={{ fontSize: "11.5px" }}>
              {data.notes.join(" · ")}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
