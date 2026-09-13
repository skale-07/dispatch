import { cn } from "@/lib/utils";
import { SYNC_INTERVAL_MS, type EngineIndicator } from "../engineStatus";

/**
 * The engine indicator: a real heartbeat row (engine_status), classified
 * against the sync cadence — never inferred from application rows. Four
 * honest states plus "the read failed", each with its evidence.
 */
export function EngineLine({
  indicator,
  loading,
  paused,
}: {
  indicator: EngineIndicator | null;
  loading: boolean;
  /** user_engine_controls.paused — the user's own stop button. */
  paused: boolean | null;
}): JSX.Element {
  const minutes = Math.round(SYNC_INTERVAL_MS / 60000);
  let tone: "neutral" | "ok" | "warn" | "danger" = "neutral";
  let body: JSX.Element;
  if (indicator === null) {
    body = <>{loading ? "checking whether your engine is running…" : "engine status unknown"}</>;
  } else {
    switch (indicator.state) {
      case "not-connected":
        body = <>engine not connected — no heartbeat has been recorded for your account yet.</>;
        break;
      case "running":
        tone = "ok";
        body = (
          <>
            engine running · last sync{" "}
            <time dateTime={indicator.row.last_seen_at}>{relativeTime(indicator.row.last_seen_at)}</time>
            {indicator.row.engine_version ? (
              <>
                {" "}
                · <span className="font-mono">{indicator.row.engine_version}</span>
              </>
            ) : null}
          </>
        );
        break;
      case "running-push-failed":
        tone = "warn";
        body = (
          <>
            engine running, last push failed{" "}
            <time dateTime={indicator.row.last_seen_at}>{relativeTime(indicator.row.last_seen_at)}</time>:{" "}
            <span className="font-mono">{indicator.row.last_error}</span>. Rows may lag until the next sync
            succeeds.
          </>
        );
        break;
      case "offline":
        tone = "danger";
        body = (
          <>
            engine offline since{" "}
            <time dateTime={indicator.row.last_seen_at}>{relativeTime(indicator.row.last_seen_at)}</time> (no
            heartbeat in {2 * minutes} min). Nothing is being applied for you right now.
          </>
        );
        break;
      case "unknown":
        body = <>engine status could not be read ({indicator.reason})</>;
        break;
    }
  }
  return (
    <p id="engine-line" role="status" className="m-0 flex items-start gap-2 font-mono text-xs text-text-dim">
      <span
        aria-hidden
        className={cn(
          "mt-1 inline-block size-2 shrink-0 rounded-full",
          tone === "ok" && "bg-ok",
          tone === "warn" && "bg-warn",
          tone === "danger" && "bg-danger",
          tone === "neutral" && "bg-border-strong",
        )}
      />
      <span>
        {body}
        {paused === true ? <> · <span className="font-heavy text-warn">paused by you</span> — nothing new is queued</> : null}
      </span>
    </p>
  );
}

/** "3 hours ago" from an ISO timestamp the server wrote. */
export function relativeTime(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}
