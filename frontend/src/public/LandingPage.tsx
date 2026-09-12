import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Reveal, RevealItem } from "../components/Animated";
import { Icon } from "../components/Icon";
import { Atmosphere } from "../components/public/Atmosphere";
import { Display, Heavy } from "../components/public/Display";
import { Eyebrow } from "../components/public/Eyebrow";
import { StatTile } from "../components/public/StatTile";
import { LOOP_STATIONS, RITUAL_CLOSE, RITUAL_ITEMS } from "../components/story/StoryCards";
import {
  SUPABASE_CONFIGURED,
  SUPABASE_UNCONFIGURED_REASON,
} from "../lib/appConfig";
import { getReferralSettings } from "./referral";
import { usePageTitle } from "./usePageTitle";

/**
 * The public landing page — the story a student reads before they hand
 * an agent their name. Five movements: the hero (one reveal, Fraunces
 * light with one heavy phrase, atmosphere behind it), the ritual they
 * already know, the loop Dispatch runs, the receipts that make it
 * trustworthy, and the free-quota offer. Copy is shared with the console
 * splash through components/story (one story, one file).
 *
 * Honesty rules: no invented numbers anywhere — the free allowance is
 * read from referral_settings() and the copy says "free" without a
 * number until it loads; the only stat quoted is a real run with
 * receipts on file. Fail-closed: a build without Supabase config renders
 * everything, but the sign-up button is disabled with the real reason —
 * never a dead button, never a fake form.
 */
export function LandingPage(): JSX.Element {
  usePageTitle(null);
  const navigate = useNavigate();
  const { free, error } = useFreeSignupQuota();

  return (
    <div className="flex flex-col gap-10 sm:gap-14">
      {/* ── hero: the one orchestrated reveal ─────────────────────── */}
      <Atmosphere grid className="rounded-lg border border-border">
        <Reveal as="section" className="flex flex-col gap-6 px-5 py-10 sm:px-10 sm:py-16">
          <RevealItem>
            <Eyebrow>an agent for the forms</Eyebrow>
          </RevealItem>
          <RevealItem>
            <Display as="h1">
              Applying to jobs is a <Heavy>part-time job.</Heavy>
            </Display>
          </RevealItem>
          <RevealItem as="p" className="m-0 max-w-2xl text-base leading-relaxed text-text-dim sm:text-lg">
            You didn&apos;t sign up for that one. Dispatch works the worst part of
            the hunt — the forms — while you&apos;re in class, at practice, or
            asleep. It applies on real employer sites from a profile you write
            once, drafts intro emails to real people inside the companies, and
            keeps a screenshot receipt for everything it does in your name.
          </RevealItem>
          <RevealItem className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
            <Button
              size="lg"
              onClick={() => navigate("/signup")}
              disabled={!SUPABASE_CONFIGURED}
              className="bg-accent-brand text-primary-foreground hover:bg-accent-brand/90"
            >
              <Icon name="play" size={14} />
              {free !== null ? `Start free — ${free} applications` : "Start free"}
            </Button>
            <Link
              to="/signup"
              className="inline-flex items-center gap-1 text-sm font-heavy text-accent-brand"
            >
              already have an account — sign in
              <Icon name="arrow-right" size={13} />
            </Link>
          </RevealItem>
          <RevealItem as="p" className="m-0 text-xs text-text-dim">
            {SUPABASE_CONFIGURED
              ? "No invite needed. Have a code from a friend? Add it at sign-up — it adds to the free allowance."
              : SUPABASE_UNCONFIGURED_REASON}
          </RevealItem>
        </Reveal>
      </Atmosphere>

      {/* ── the ritual ────────────────────────────────────────────── */}
      <section className="flex flex-col gap-5">
        <Eyebrow as="h2">you know the ritual</Eyebrow>
        <ul className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2">
          {RITUAL_ITEMS.map((item) => (
            <li key={item.text} className="flex gap-3 text-base leading-relaxed text-text">
              <Icon name={item.icon} size={16} className="mt-1 shrink-0 text-text-faint" />
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
        <p className="m-0 max-w-2xl text-base leading-relaxed text-text-dim">{RITUAL_CLOSE}</p>
      </section>

      {/* ── the loop: four stations ───────────────────────────────── */}
      <section className="flex flex-col gap-5">
        <Eyebrow as="h2">what Dispatch does while you live</Eyebrow>
        <ol className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
          {LOOP_STATIONS.map((s, i) => (
            <li key={s.title}>
              <Card className="h-full gap-3 py-5">
                <CardContent className="flex flex-col gap-3 px-5">
                  <p className="m-0 font-mono text-xs font-heavy text-accent-brand">
                    {String(i + 1).padStart(2, "0")}
                  </p>
                  <p className="m-0 text-base font-heavy leading-snug text-text">{s.title}</p>
                  <p className="m-0 text-sm leading-relaxed text-text-dim">{s.text}</p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      {/* ── receipts, not promises ────────────────────────────────── */}
      <section className="flex flex-col gap-5">
        <Eyebrow as="h2">receipts, not promises</Eyebrow>
        <div className="grid gap-4 sm:grid-cols-2">
          <StatTile
            label="one real day"
            value="7"
            hint="applications across 5 job boards — the September 1 run, screenshot receipts on file"
          />
          <StatTile
            label="what each one costs by hand"
            value="20–40 min"
            hint="a serious search is hundreds of them; your dashboard keeps the honest count of what Dispatch handed back"
          />
        </div>
        <p className="m-0 max-w-2xl text-base leading-relaxed text-text-dim">
          Every submission stores a screenshot and the confirmation text, and
          your dashboard shows them. You never have to wonder whether it
          &quot;really applied&quot; — you can look. No number on this site is
          invented: no user counts, no testimonials. If there&apos;s nothing
          yet, it says so.
        </p>
      </section>

      {/* ── what it never does ────────────────────────────────────── */}
      <section className="flex flex-col gap-5">
        <Eyebrow as="h2">what it will never do</Eyebrow>
        <ul className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2">
          {NEVER.map((n) => (
            <li key={n.title} className="flex gap-3">
              <Icon name={n.icon} size={16} className="mt-1 shrink-0 text-accent-brand" />
              <p className="m-0 text-base leading-relaxed text-text">
                <span className="font-heavy">{n.title}</span> {n.text}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* ── the offer ─────────────────────────────────────────────── */}
      <section id="start-free">
        <Card className="gap-4 py-8">
          <CardContent className="flex flex-col gap-4 px-6 sm:px-8">
            <Eyebrow>the offer</Eyebrow>
            <Display as="h2" size="section">
              Start with{" "}
              <Heavy>{free !== null ? `${free} free` : "free"}</Heavy> applications
            </Display>
            <p className="m-0 max-w-2xl text-base leading-relaxed text-text-dim">
              Sign up in a minute, write your profile once, and
              Dispatch applies from it — real employer sites, screenshot receipt
              for every submission. An invite code from a friend adds that
              code&apos;s applications on top; friends you invite earn you more
              when they activate.
            </p>
            {error ? (
              <p className="m-0 text-xs text-text-dim">
                Could not load the current offer ({error}) — the sign-up page
                shows it once you are in.
              </p>
            ) : null}
            <div>
              <Button
                asChild
                size="lg"
                className="bg-accent-brand text-primary-foreground hover:bg-accent-brand/90"
              >
                <Link to="/signup">
                  <Icon name="play" size={14} />
                  start free
                </Link>
              </Button>
            </div>
            {!SUPABASE_CONFIGURED ? (
              <p className="m-0 text-xs text-text-dim">{SUPABASE_UNCONFIGURED_REASON}</p>
            ) : null}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

/** The trust story, as things Dispatch will not do — every line is a built-in, not a setting. */
const NEVER = [
  {
    icon: "mail",
    title: "Never sends mail in your name.",
    text: "Outreach to people inside a company is drafted for you to review and send yourself. Dispatch cannot send mail as you — that is built in, not a setting.",
  },
  {
    icon: "file",
    title: "Never guesses an answer.",
    text: "Forms are answered only from the profile you write in onboarding. Nothing about you is scraped, inferred, or invented — a question your profile doesn’t answer becomes a to-do, not a guess.",
  },
  {
    icon: "check",
    title: "Never applies without a receipt.",
    text: "Every submission is read back and stored with a screenshot and the confirmation text before it counts.",
  },
  {
    icon: "bolt",
    title: "Never hides the count.",
    text: "Your quota is on the dashboard, counting down in plain sight. No surprise caps, no weekly-billed-as-monthly anything.",
  },
] as const;

/**
 * The free allowance from referral_settings() (open signup, migration
 * 20260911000100). null until loaded or when the read fails — the copy
 * then says "free" without a number rather than inventing one.
 */
function useFreeSignupQuota(): { free: number | null; error: string | null } {
  const [free, setFree] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!SUPABASE_CONFIGURED) return;
    let alive = true;
    void getReferralSettings()
      .then((s) => {
        // A project without the open-signup migration answers without the
        // field — show "free" with no number rather than "undefined".
        if (alive) setFree(typeof s.free_signup_quota === "number" ? s.free_signup_quota : null);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);
  return { free, error };
}
