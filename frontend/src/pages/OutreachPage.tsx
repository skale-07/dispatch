import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import type { FlagsView } from "../api/types";
import { usePoll } from "../hooks/usePoll";
import { Icon } from "../components/Icon";

const REQUIRED_FLAGS = [
  "LINKEDIN_ENRICHMENT_ENABLED",
  "EMAIL_GENERATION_ENABLED",
  "GMAIL_DRAFTS_ENABLED",
] as const;

/**
 * Apply-yourself outreach: paste a JobRight link, one click finds insider
 * emails, writes the template, and saves Gmail drafts. Nothing sends.
 * Progress lives on the run log — this page does not fill or submit.
 */
export function OutreachPage(): JSX.Element {
  const navigate = useNavigate();
  const flags = usePoll<FlagsView>(() => apiGet<FlagsView>("/api/flags"), 30000);
  const [refsText, setRefsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refs = refsText
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && !r.startsWith("#"));
  const ceiling = flags.data?.ceiling ?? {};
  const flagsReady = Boolean(flags.data);
  const missing = flagsReady
    ? REQUIRED_FLAGS.filter((k) => ceiling[k] !== true)
    : [];
  const blocked = missing.length > 0;

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ run_id: string }>("/api/runs", {
        kind: "outreach",
        params: { refs, headed: true },
        flags: {
          LINKEDIN_ENRICHMENT_ENABLED: true,
          EMAIL_GENERATION_ENABLED: true,
          GMAIL_DRAFTS_ENABLED: true,
        },
        live_mode: false,
      });
      navigate(`/runs/${res.run_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Outreach</h1>
        <div className="sub">you apply — Dispatch drafts the emails</div>
      </div>

      {error ? <div className="banner danger">{error}</div> : null}
      {blocked ? (
        <div className="banner warn">
          Enable in .env: {missing.join(", ")}
        </div>
      ) : null}

      <div className="card">
        <h2>JobRight posting</h2>
        <p className="faint flush-top">
          Paste a JobRight job link (or hex id). Dispatch finds alumni and
          engineers, writes the outreach email, and saves a Gmail draft.
          Nothing ever sends — review and send from Gmail. These jobs stay
          out of auto-apply.
        </p>
        <label className="field">
          JobRight links
          <textarea
            rows={6}
            value={refsText}
            onChange={(e) => setRefsText(e.target.value)}
            placeholder={"https://jobright.ai/jobs/info/…"}
          />
        </label>
        <div className="toolbar stack flush-bottom">
          <button
            className="primary"
            onClick={() => void run()}
            disabled={busy || blocked || refs.length === 0 || !flagsReady}
            title={
              blocked
                ? `Needs ${missing.join(", ")}`
                : refs.length === 0
                  ? "Paste a JobRight link"
                  : undefined
            }
          >
            <Icon name="mail" size={14} />
            {busy ? "Starting…" : "Run outreach"}
          </button>
        </div>
      </div>
    </>
  );
}
