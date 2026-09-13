import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Icon } from "../components/Icon";
import { CopyButton } from "../components/public/CopyButton";
import { Eyebrow } from "../components/public/Eyebrow";
import { FieldHint } from "../components/public/FieldHint";
import { PanelState } from "../components/public/PanelState";
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
 * string in running prose (QA 2026-09-02, D-23). Restyled onto the
 * composites in plan M11; the logic is unchanged.
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
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const capReached = settings !== null && unredeemed.length >= settings.max_active_referral_codes;
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
    <section id="invite" aria-labelledby="invite-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Eyebrow as="h2">
          <span id="invite-heading">{headline}</span>
        </Eyebrow>
        <p className="m-0 text-sm text-text-dim">
          {lede ??
            "The people who most need this are the ones in your group chat complaining about Workday. Send them a code."}
        </p>
        {settings ? (
          <FieldHint>
            Each code covers {settings.referral_code_quota} applications; you can hold{" "}
            {settings.max_active_referral_codes} unredeemed codes at a time. When a friend you invited
            completes {settings.activation_completed_applications} applications, your own quota grows by{" "}
            {settings.inviter_bonus_per_activation} — once per friend, up to +{settings.inviter_bonus_cap} in
            total.
          </FieldHint>
        ) : null}
      </div>

      <Card className="py-5">
        <CardContent className="flex flex-col gap-4 px-5">
          {invites === null ? <PanelState kind="loading" /> : null}

          {invites?.available === false ? (
            <PanelState
              kind="error"
              title="Couldn't load your invite codes"
              body={`The account service answered: ${invites.reason}. Nothing about your codes is guessed from here — try again in a moment.`}
              action={
                <Button type="button" variant="outline" onClick={load}>
                  <Icon name="refresh" size={14} />
                  try again
                </Button>
              }
            />
          ) : null}

          {invites?.available === true && codes.length === 0 ? (
            <PanelState
              kind="empty"
              icon="mail"
              title="No invite codes yet"
              body={
                member === false
                  ? "Codes are minted by members — once your own invite is redeemed, you can mint codes for friends here."
                  : settings
                    ? `Mint one and send it to a friend. It covers ${settings.referral_code_quota} applications for them, and when they complete ${settings.activation_completed_applications} you get +${settings.inviter_bonus_per_activation}.`
                    : "Mint one and send it to a friend."
              }
              action={<MintButton minting={minting} blockedReason={mintBlockedReason} onMint={() => void mint()} />}
            />
          ) : null}

          {codes.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="your invite codes">
              {codes.map((c) => (
                <li
                  key={c.code}
                  className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <code className="font-mono text-sm text-text">{c.code}</code>
                    <span className="text-xs text-text-dim">covers {c.max_completed_applications} applications</span>
                  </div>
                  {c.redeemed_at ? (
                    <Badge variant="outline">redeemed {new Date(c.redeemed_at).toLocaleDateString()}</Badge>
                  ) : c.code === justMinted ? (
                    <Badge variant="secondary">
                      <Icon name="check" size={11} />
                      just minted
                    </Badge>
                  ) : (
                    <Badge>unredeemed</Badge>
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          {codes.length > 0 ? (
            <p className="m-0 font-mono text-xs text-text-dim">
              {redeemed.length} of {codes.length} redeemed
              {settings ? ` · ${unredeemed.length} of ${settings.max_active_referral_codes} unredeemed codes out` : ""}
            </p>
          ) : null}

          {mintError && mintError !== MINT_ERRORS.notMember && mintError !== MINT_ERRORS.capReached ? (
            <FieldHint tone="danger">Couldn&apos;t mint a code: {mintError}</FieldHint>
          ) : null}

          {bonuses !== null && settings ? (
            <p className="m-0 flex items-start gap-2 text-xs text-text-dim">
              <Icon name="sparkle" size={12} className="mt-0.5 shrink-0" />
              <span>
                {bonuses.length === 0
                  ? `No friend has activated yet — that happens when someone you invited completes ${settings.activation_completed_applications} applications.`
                  : `${bonuses.length} friend${bonuses.length === 1 ? "" : "s"} activated — +${earned} applications earned on your quota${earned >= settings.inviter_bonus_cap ? " (at the cap)" : ""}.`}
              </span>
            </p>
          ) : null}

          <blockquote className="m-0 whitespace-pre-wrap rounded-md border border-border bg-bg-inset p-3 font-mono text-xs text-text-dim">
            {share.text}
            {"\n"}
            {share.url}
          </blockquote>

          <div className="flex flex-wrap gap-2">
            <CopyButton label={first ? "copy invite link" : "copy link"} value={first ? first.url : share.url} />
            <CopyButton label="copy message" value={`${share.text}\n${share.url}`} />
            {canShare ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  // navigator.share rejects on user cancel; that is not an
                  // error worth a banner.
                  void navigator.share(share).catch(() => undefined);
                }}
              >
                <Icon name="arrow-right" size={13} />
                share…
              </Button>
            ) : null}
            {codes.length > 0 ? (
              <MintButton minting={minting} blockedReason={mintBlockedReason} onMint={() => void mint()} />
            ) : null}
          </div>
        </CardContent>
      </Card>
    </section>
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
}: {
  minting: boolean;
  blockedReason: string | null;
  onMint: () => void;
}): JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        onClick={onMint}
        disabled={minting || blockedReason !== null}
        aria-describedby={blockedReason ? "mint-blocked-reason" : undefined}
      >
        <Icon name="sparkle" size={13} />
        {minting ? "minting…" : "mint a code"}
      </Button>
      {blockedReason ? (
        <span className="font-mono text-xs text-text-dim" id="mint-blocked-reason">
          {blockedReason}
        </span>
      ) : null}
    </span>
  );
}
