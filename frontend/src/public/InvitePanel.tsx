import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { MINT_ERRORS, type ReferralBonusRow, type ReferralSettings } from "./contract";
import {
  getReferralSettings,
  listMyReferralBonuses,
  listMyReferralInvites,
  mintReferralInvite,
  shareText,
  type ReferralInvite,
  type ReferralInvites,
} from "./referral";

/**
 * "Invite a friend" — the referral surface on the dashboard and right
 * after onboarding, on the launcher's shipped contract (cloud-deploy §9).
 *
 * What it shows, and only from server rows:
 *   - the loop's numbers (codes you may hold, quota per code, the
 *     activation threshold, the bonus and its cap) from referral_settings()
 *   - your own issued codes with redeemed / unredeemed state
 *   - a "mint a code" action that is disabled WITH THE REASON when you are
 *     not a member yet or the cap is reached (server strings, verbatim)
 *   - friends who activated, from the bonus ledger
 *   - copy / share for the first unredeemed code, or the free-signup link
 *     when there is none
 *
 * It never fabricates a code, never counts what it cannot read, and a
 * failed read is an honest empty state with a retry — not a raw error
 * string in running prose (QA 2026-09-02, D-23).
 */
export function InvitePanel({
  headline = "Invite a friend",
  lede,
  member = null,
  bonuses: bonusesProp,
}: {
  headline?: string;
  lede?: string;
  /** Whether the account has redeemed an invite (mint is member-only); null = unknown. */
  member?: boolean | null;
  /** The bonus ledger when the host page already read it (skips a duplicate read). */
  bonuses?: ReferralBonusRow[] | null;
}): JSX.Element {
  const [settings, setSettings] = useState<ReferralSettings | null>(null);
  const [invites, setInvites] = useState<ReferralInvites | null>(null);
  const [ownBonuses, setOwnBonuses] = useState<ReferralBonusRow[] | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [justMinted, setJustMinted] = useState<string | null>(null);
  const hostReadsBonuses = bonusesProp !== undefined;
  // ownBonuses stays null when the host reads, so ?? is exact here.
  const bonuses: ReferralBonusRow[] | null = bonusesProp ?? ownBonuses;

  const load = useCallback((): void => {
    setInvites(null);
    void listMyReferralInvites().then(setInvites);
    void getReferralSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
    if (!hostReadsBonuses) {
      void listMyReferralBonuses()
        .then(setOwnBonuses)
        .catch(() => setOwnBonuses(null));
    }
  }, [hostReadsBonuses]);

  useEffect(load, [load]);

  const codes: ReferralInvite[] = invites?.available === true ? invites.invites : [];
  const unredeemed = codes.filter((i) => i.redeemed_at === null);
  const redeemed = codes.filter((i) => i.redeemed_at !== null);
  const first: ReferralInvite | null = unredeemed[0] ?? null;
  const share = shareText({ invite: first });
  const canShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  const capReached =
    settings !== null && unredeemed.length >= settings.max_active_referral_codes;
  const mintBlockedReason: string | null =
    member === false
      ? `${MINT_ERRORS.notMember} — redeem an invite first`
      : mintError === MINT_ERRORS.notMember
        ? `${MINT_ERRORS.notMember} — redeem an invite first`
        : capReached || mintError === MINT_ERRORS.capReached
          ? settings
            ? `${MINT_ERRORS.capReached} — ${unredeemed.length} of ${settings.max_active_referral_codes} codes still out`
            : MINT_ERRORS.capReached
          : null;

  const mint = async (): Promise<void> => {
    setMinting(true);
    setMintError(null);
    setJustMinted(null);
    const r = await mintReferralInvite();
    setMinting(false);
    if (!r.ok) {
      setMintError(r.reason);
      return;
    }
    setJustMinted(r.invite.code);
    setInvites((prev) =>
      prev?.available === true
        ? { available: true, invites: [r.invite, ...prev.invites] }
        : { available: true, invites: [r.invite] },
    );
  };

  const earned = bonuses?.reduce((sum, b) => sum + b.bonus, 0) ?? 0;

  return (
    <div className="card" id="invite">
      <h2>{headline}</h2>
      <p className="muted flush-top">
        {lede ??
          "The people who most need this are the ones in your group chat complaining about Workday. Send them a code."}
      </p>
      {settings ? (
        <p className="faint">
          Each code covers {settings.referral_code_quota} applications; you can
          hold {settings.max_active_referral_codes} unredeemed codes at a time.
          When a friend you invited completes{" "}
          {settings.activation_completed_applications} applications, your own
          quota grows by {settings.inviter_bonus_per_activation} — once per
          friend, up to +{settings.inviter_bonus_cap} in total.
        </p>
      ) : null}

      {invites === null ? (
        <p className="faint" role="status">
          checking for your invite codes…
        </p>
      ) : null}

      {invites?.available === false ? (
        <EmptyState
          icon="alert"
          title="Couldn't load your invite codes"
          body={`The account service answered: ${invites.reason}. Nothing about your codes is guessed from here — try again in a moment.`}
          action={
            <button className="btn" onClick={load}>
              try again
            </button>
          }
        />
      ) : null}

      {invites?.available === true && codes.length === 0 ? (
        <EmptyState
          icon="mail"
          title="No invite codes yet"
          body={
            member === false
              ? "Codes are minted by members — once your own invite is redeemed, you can mint codes for friends here."
              : settings
                ? `Mint one and send it to a friend. It covers ${settings.referral_code_quota} applications for them, and when they complete ${settings.activation_completed_applications} you get +${settings.inviter_bonus_per_activation}.`
                : "Mint one and send it to a friend."
          }
          action={
            <MintButton
              primary
              minting={minting}
              blockedReason={mintBlockedReason}
              onMint={() => void mint()}
            />
          }
        />
      ) : null}

      {codes.length > 0 ? (
        <ul className="code-list" aria-label="your invite codes">
          {codes.map((c) => (
            <li key={c.code} className={c.redeemed_at ? "redeemed" : undefined}>
              <code>{c.code}</code>
              <span className="faint">covers {c.max_completed_applications} applications</span>
              {c.redeemed_at ? (
                <span className="badge neutral">
                  redeemed {new Date(c.redeemed_at).toLocaleDateString()}
                </span>
              ) : c.code === justMinted ? (
                <span className="badge ok">
                  <Icon name="check" size={11} /> just minted
                </span>
              ) : (
                <span className="badge accent">unredeemed</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {codes.length > 0 ? (
        <p className="faint">
          {redeemed.length} of {codes.length} redeemed
          {settings
            ? ` · ${unredeemed.length} of ${settings.max_active_referral_codes} unredeemed codes out`
            : ""}
        </p>
      ) : null}

      {mintError && mintError !== MINT_ERRORS.notMember && mintError !== MINT_ERRORS.capReached ? (
        <div className="banner danger" role="alert">
          Couldn&apos;t mint a code: {mintError}
        </div>
      ) : null}

      {bonuses !== null && settings ? (
        <p className="faint referral-bonus-line">
          <Icon name="sparkle" size={12} />{" "}
          {bonuses.length === 0
            ? `No friend has activated yet — that happens when someone you invited completes ${settings.activation_completed_applications} applications.`
            : `${bonuses.length} friend${bonuses.length === 1 ? "" : "s"} activated — +${earned} applications earned on your quota${earned >= settings.inviter_bonus_cap ? " (at the cap)" : ""}.`}
        </p>
      ) : null}

      <blockquote className="share-text">
        {share.text}
        {"\n"}
        {share.url}
      </blockquote>

      <div className="toolbar stack-actions flush-bottom">
        <CopyButton
          label={first ? "copy invite link" : "copy link"}
          value={first ? first.url : share.url}
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
        {codes.length > 0 ? (
          <MintButton
            minting={minting}
            blockedReason={mintBlockedReason}
            onMint={() => void mint()}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Mint control. When blocked it stays visible and disabled with the
 * server's own reason beside it, so "why can't I" never needs a click.
 */
function MintButton({
  minting,
  blockedReason,
  onMint,
  primary = false,
}: {
  minting: boolean;
  blockedReason: string | null;
  onMint: () => void;
  primary?: boolean;
}): JSX.Element {
  return (
    <span className="mint-control">
      <button
        className={primary ? "primary" : undefined}
        onClick={onMint}
        disabled={minting || blockedReason !== null}
        aria-describedby={blockedReason ? "mint-blocked-reason" : undefined}
      >
        <Icon name="sparkle" size={13} /> {minting ? "minting…" : "mint a code"}
      </button>
      {blockedReason ? (
        <span className="faint" id="mint-blocked-reason">
          {blockedReason}
        </span>
      ) : null}
    </span>
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
