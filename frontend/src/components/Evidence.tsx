import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import { Icon } from "./Icon";
import { Skeleton } from "./Skeleton";
import { arrive, m } from "./Animated";

/**
 * Dispatch's product is evidence. Every run leaves a receipt screenshot,
 * a per-field fill report and a verification read-back on disk, and the
 * console used to render all of it as counts and file paths:
 * `fillable_count: 2`, `artifacts/ats-fill/generic-live/live-executed-
 * 1787262223338.json`. That asks the operator to take the software's
 * word for it and then go open a file to check.
 *
 * These components show the artifact itself. A path is what you print
 * when you have nothing real to show; here there is something real.
 */

export function artifactUrl(relpath: string): string {
  return `/api/artifacts?path=${encodeURIComponent(relpath)}`;
}

/** A short human label for an artifact, derived from its path. */
export function artifactLabel(relpath: string): string {
  const base = relpath.split(/[\\/]/).pop() ?? relpath;
  if (base.startsWith("receipt-") || base.startsWith("sandbox-receipt-"))
    return "Submission receipt";
  if (base.startsWith("live-executed-")) return "Fill report";
  if (base.startsWith("live-refused-")) return "Refused fill";
  if (base.startsWith("fill-trace-")) return "Fill trace";
  if (base.includes("snapshot")) return "Form snapshot";
  return base;
}

/**
 * The screenshot the browser actually took, at the moment it mattered.
 * Failure is a designed state: a receipt that is gone from disk is a real
 * fact about this application and says so, rather than rendering the
 * browser's broken-image icon.
 */
export function ScreenshotEvidence(props: {
  path: string;
  caption: string;
  when?: string | null;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <figure className="evidence evidence-missing">
        <div className="evidence-frame">
          <Icon name="alert" size={20} />
          <span>Screenshot no longer on disk</span>
        </div>
        <figcaption>
          {props.caption}
          <span className="mono faint"> · {props.path}</span>
        </figcaption>
      </figure>
    );
  }
  return (
    // Arrival of the real artifact — the moment the evidence exists.
    <m.figure className="evidence" {...arrive}>
      <a
        href={artifactUrl(props.path)}
        target="_blank"
        rel="noreferrer"
        className="evidence-frame"
        title="Open full size"
      >
        <img
          src={artifactUrl(props.path)}
          alt={props.caption}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </a>
      <figcaption>
        {props.caption}
        {props.when ? <span className="faint"> · {props.when}</span> : null}
      </figcaption>
    </m.figure>
  );
}

type FillReport = {
  ats?: string;
  url?: string;
  mode?: string;
  validation_level?: string;
  plan_fields?: Array<{
    field_id?: string;
    label?: string;
    action?: string;
    reason?: string;
    canonical_field?: string;
  }>;
  fill?: { filled?: string[]; skipped?: unknown[]; errors?: unknown[] };
  verify?: {
    passed?: boolean;
    fields?: Array<{
      canonical_field?: string;
      expected?: string;
      observed?: string;
      match?: boolean;
    }>;
    warnings?: string[];
  };
  schema_diff?: {
    declared_count?: number;
    dom_count?: number;
    matched?: number;
    api_only?: Array<{ label?: string; required?: boolean }>;
    dom_only?: string[];
    option_mismatches?: Array<{
      label?: string;
      dom_options?: number;
      api_options?: number;
    }>;
  };
  notes?: string[];
};

/**
 * The board publishes its own form schema; Dispatch reads the page. When
 * the two disagree, that disagreement is the earliest evidence there is —
 * a question the page hid on a later step, a control discovery missed, a
 * dropdown whose menu rendered incomplete. Shown as its own block so
 * "matched cleanly" and "half the schema never lined up" stop looking
 * identical.
 */
function SchemaCrossCheck(props: {
  diff: NonNullable<FillReport["schema_diff"]>;
}): JSX.Element {
  const { diff } = props;
  const apiOnly = diff.api_only ?? [];
  const domOnly = diff.dom_only ?? [];
  const mismatches = diff.option_mismatches ?? [];
  const clean = apiOnly.length === 0 && domOnly.length === 0 && mismatches.length === 0;
  return (
    <div className="evidence-schema">
      <p className={clean ? "faint" : undefined}>
        <Icon name={clean ? "check" : "alert"} size={13} /> Board schema
        cross-check: {diff.matched ?? 0} of {diff.declared_count ?? 0} declared
        questions matched the page's {diff.dom_count ?? 0} fields
        {clean ? " — no gaps." : "."}
      </p>
      {clean ? null : (
        <ul className="evidence-warnings">
          {apiOnly.map((q) => (
            <li key={`api-${q.label}`}>
              The board declares “{q.label}”
              {q.required ? " (required)" : ""} but Dispatch found no matching
              field on the page.
            </li>
          ))}
          {domOnly.map((label) => (
            <li key={`dom-${label}`}>
              The page shows “{label}”, which the board's schema does not
              declare.
            </li>
          ))}
          {mismatches.map((m) => (
            <li key={`opt-${m.label}`}>
              “{m.label}”: the page offered {m.dom_options ?? 0} options; the
              board declares {m.api_options ?? 0}.
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The fill report, read back field by field: what Dispatch put in each
 * box and what the page said afterwards. This is the whole claim the
 * product makes, and it was previously a link to a JSON file.
 *
 * Values shown here are the operator's own, already redacted by the
 * writer where the field is sensitive (`a***@example.com`) — this
 * renders what the artifact holds and never widens it.
 */
export function FillEvidence(props: { relpath: string }): JSX.Element {
  const [report, setReport] = useState<FillReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setReport(null);
    setError(null);
    apiGet<FillReport>(artifactUrl(props.relpath))
      .then((r) => {
        if (live) setReport(r);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [props.relpath]);

  if (error)
    return (
      <p className="faint">
        <Icon name="alert" size={13} /> Fill report unreadable — {error}
      </p>
    );
  if (!report)
    return (
      <div className="skeleton-lines">
        <Skeleton width="72%" />
        <Skeleton width="88%" />
        <Skeleton width="61%" />
      </div>
    );

  const verified = new Map(
    (report.verify?.fields ?? []).map((f) => [f.canonical_field ?? "", f]),
  );
  const planned = report.plan_fields ?? [];

  return (
    <m.div className="evidence-report" {...arrive}>
      <div className="evidence-report-head">
        <span className={`badge ${report.verify?.passed ? "ok" : "warn"}`}>
          <Icon name={report.verify?.passed ? "check" : "alert"} size={12} />
          {report.verify?.passed ? "read back and verified" : "not fully verified"}
        </span>
        <span className="faint mono">{report.validation_level ?? "UNVERIFIED"}</span>
        {report.url ? (
          <a href={report.url} target="_blank" rel="noreferrer" className="mono faint">
            {new URL(report.url).host}
          </a>
        ) : null}
      </div>

      {planned.length === 0 ? (
        <p className="faint">This run planned no fields.</p>
      ) : (
        <table className="evidence-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>What Dispatch entered</th>
              <th>What the page showed</th>
            </tr>
          </thead>
          <tbody>
            {planned.map((f) => {
              const v = verified.get(f.canonical_field ?? "");
              const skipped = f.action !== "FILL";
              return (
                <tr key={f.field_id ?? f.canonical_field}>
                  <td>{f.label ?? f.field_id ?? f.canonical_field}</td>
                  <td className={skipped ? "faint" : undefined}>
                    {skipped ? (
                      (f.reason ?? "skipped")
                    ) : (
                      <span className="mono">{v?.expected ?? "—"}</span>
                    )}
                  </td>
                  <td>
                    {v ? (
                      <span className={v.match ? "verified-yes" : "verified-no"}>
                        <Icon name={v.match ? "check" : "x"} size={12} />{" "}
                        <span className="mono">{v.observed || "(empty)"}</span>
                      </span>
                    ) : (
                      <span className="faint">not read back</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {(report.verify?.warnings ?? []).length > 0 ? (
        <ul className="evidence-warnings">
          {report.verify!.warnings!.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      {report.schema_diff ? <SchemaCrossCheck diff={report.schema_diff} /> : null}
    </m.div>
  );
}
