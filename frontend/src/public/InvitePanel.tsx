import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import {
  listMyReferralInvites,
  shareText,
  type ReferralInvite,
  type ReferralInvites,
} from "./referral";

/**
 * "Invite a friend" — the referral surface on the dashboard and right
 * after onboarding. Renders one of two honest states:
 *
 *   personal invite codes available  → code + link + copy + share
 *   not available (today's contract) → share the story + waitlist link
 *
 * It never fabricates a code, never counts referrals it cannot see, and
 * says out loud when personal codes are not live yet. Copy uses the
 * async clipboard API and surfaces its real error (insecure context,
 * denied permission) instead of a fake "copied".
 */
export function InvitePanel({
  headline = "Invite a friend",
  lede,
}: {
  headline?: string;
  lede?: string;
}): JSX.Element {
  const [state, setState] = useState<ReferralInvites | null>(null);

  useEffect(() => {
    let alive = true;
    void listMyReferralInvites().then((r) => {
      if (alive) setState(r);
    });
    return () => {
      alive = false;
    };
  }, []);

  const unredeemed: ReferralInvite | null =
    state?.available === true
      ? (state.invites.find((i) => i.redeemed_at === null) ?? null)
      : null;
  const share = shareText({ invite: unredeemed });
  const canShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className="card" id="invite">
      <h2>{headline}</h2>
      <p className="muted flush-top">
        {lede ??
          "The people who most need this are the ones in your group chat complaining about Workday. Send them the story — and a code, once personal codes are live."}
      </p>

      {state === null ? (
        <p className="faint" role="status">
          checking for your invite codes…
        </p>
      ) : null}

      {state?.available === true && state.invites.length > 0 ? (
        <>
          <div className="share-code">
            <code>{unredeemed ? unredeemed.code : "all codes redeemed"}</code>
            {unredeemed ? (
              <span className="faint">
                covers {unredeemed.max_completed_applications} applications
              </span>
            ) : null}
          </div>
          <p className="faint">
            {state.invites.filter((i) => i.redeemed_at !== null).length} of{" "}
            {state.invites.length} redeemed
          </p>
        </>
      ) : null}

      {state?.available === true && state.invites.length === 0 ? (
        <p className="faint">
          No personal invite codes on your account yet — the share below
          still works.
        </p>
      ) : null}

      {state?.available === false ? (
        <p className="faint">
          Personal invite codes aren&apos;t live yet ({state.reason}). Until
          they are, the share below points friends at the waitlist.
        </p>
      ) : null}

      <blockquote className="share-text">
        {share.text}
        {"\n"}
        {share.url}
      </blockquote>

      <div className="toolbar stack-actions flush-bottom">
        <CopyButton
          label={unredeemed ? "copy invite link" : "copy link"}
          value={unredeemed ? unredeemed.url : share.url}
          primary
        />
        <CopyButton label="copy message" value={`${share.text}\n${share.url}`} />
        {canShare ? (
          <button
            onClick={() => {
              // navigator.share rejects on user cancel; that is not an
              // error worth a banner.
              void navigator.share(share).catch(() => undefined);
            }}
          >
            <Icon name="arrow-right" size={13} /> share…
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CopyButton({
  label,
  value,
  primary = false,
}: {
  label: string;
  value: string;
  primary?: boolean;
}): JSX.Element {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") return;
    const t = setTimeout(() => setStatus("idle"), 2500);
    return () => clearTimeout(t);
  }, [status]);

  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard) {
        throw new Error("clipboard unavailable (needs https)");
      }
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch (err) {
      setReason(err instanceof Error ? err.message : String(err));
      setStatus("failed");
    }
  };

  return (
    <button
      className={primary ? "primary" : undefined}
      onClick={() => void copy()}
      aria-live="polite"
    >
      <Icon name={status === "copied" ? "check" : "file"} size={13} />{" "}
      {status === "copied"
        ? "copied"
        : status === "failed"
          ? `couldn't copy — ${reason ?? "unknown"}`
          : label}
    </button>
  );
}
