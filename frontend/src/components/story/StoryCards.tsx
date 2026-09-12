import { Icon, type IconName } from "../Icon";

/**
 * The narrative both surfaces share — the grind students know and what
 * Dispatch does about it. The COPY lives in the two arrays below so the
 * public landing page (composed from tokens + composites) and the
 * operator console's splash (the card renderers here) tell one story
 * from one file, and copy edits can never drift between them.
 * Surface-specific cards (trust story, CTAs, setup) stay on their own
 * pages: the console's truths ("runs on localhost") are not the hosted
 * app's truths, so those are NOT shared.
 *
 * Honesty rule carried over from the original splash: everything factual
 * here is real — no invented user counts, no testimonials, and the one
 * stat ("7 applications across 5 job boards in one day") is an actual
 * 2026-09-01 run with receipts on file.
 */

export type StoryItem = { icon: IconName; text: string };
export type StoryStation = { icon: IconName; title: string; text: string };

export const RITUAL_ITEMS: readonly StoryItem[] = [
  { icon: "file", text: "Fifty tabs and a spreadsheet you stopped updating in week two." },
  {
    icon: "clock",
    text:
      "Retyping the same three internships into the fortieth slightly-different form — months as MM/YYYY this time, no wait, a dropdown.",
  },
  {
    icon: "x",
    text: "“Autofill from resume” fills six of thirty fields, wrong, and clears the page when you fix them.",
  },
  {
    icon: "alert",
    text: "Forty-five minutes on one application. Rejected by a script before your next lecture — or never answered at all.",
  },
];

export const RITUAL_CLOSE =
  "A manual application runs about 20–40 minutes, and a serious search is hundreds of them. That math is your semester. The monotony isn’t building character — it’s just eating the hours you’d spend on the things that actually get you hired: projects, people, sleep.";

export const LOOP_STATIONS: readonly StoryStation[] = [
  {
    icon: "search",
    title: "Finds the real form",
    text: "Follows each posting to the employer’s actual application page (not a repost of a repost), and queues it.",
  },
  {
    icon: "bolt",
    title: "Applies while you’re elsewhere",
    text:
      "Fills every field from the profile and answers you wrote, reads each one back to verify, then submits. One day this September it put through 7 applications across 5 different job boards — a real run, receipts on file.",
  },
  {
    icon: "mail",
    title: "Gets you past the pile",
    text:
      "Finds real people inside the company and drafts them a short, specific email for you to review and send yourself. Dispatch never sends mail in your name.",
  },
  {
    icon: "alert",
    title: "Taps you in when it should",
    text:
      "An essay, a CAPTCHA, a login it doesn’t have: that application is parked as a short to-do for you, and the rest of the queue keeps moving.",
  },
];

export function RitualCard(): JSX.Element {
  return (
    <div className="card">
      <h2>You know the ritual</h2>
      <ul className="setup-list">
        {RITUAL_ITEMS.map((item) => (
          <li key={item.text}>
            <Icon name={item.icon} size={14} /> <span>{item.text}</span>
          </li>
        ))}
      </ul>
      <p className="muted flush-bottom">{RITUAL_CLOSE}</p>
    </div>
  );
}

export function WhatItDoesCard(): JSX.Element {
  return (
    <div className="card">
      <h2>What Dispatch does while you live</h2>
      <ul className="setup-list">
        {LOOP_STATIONS.map((s) => (
          <li key={s.title}>
            <Icon name={s.icon} size={14} /> <span>
              <strong>{s.title}</strong> — {s.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
