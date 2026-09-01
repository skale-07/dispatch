import { Icon } from "../Icon";

/**
 * The narrative both surfaces share — the grind students know and what
 * Dispatch does about it. Extracted so the public landing page and the
 * operator console's splash tell one story from one file, and copy edits
 * can never drift between them. Surface-specific cards (trust story,
 * CTAs, setup) stay on their own pages: the console's truths ("runs on
 * localhost") are not the hosted app's truths, so those are NOT shared.
 *
 * Honesty rule carried over from the original splash: everything factual
 * here is real — no invented user counts, no testimonials, and the one
 * stat ("7 applications across 5 job boards in one day") is an actual
 * 2026-09-01 run with receipts on file.
 */

export function RitualCard(): JSX.Element {
  return (
    <div className="card">
      <h2>You know the ritual</h2>
      <ul className="setup-list">
        <li>
          <Icon name="file" size={14} /> <span>
            Fifty tabs and a spreadsheet you stopped updating in week two.
          </span>
        </li>
        <li>
          <Icon name="clock" size={14} /> <span>
            Retyping the same three internships into the fortieth
            slightly-different form — months as MM/YYYY this time, no
            wait, a dropdown.
          </span>
        </li>
        <li>
          <Icon name="x" size={14} /> <span>
            &quot;Autofill from resume&quot; fills six of thirty fields,
            wrong, and clears the page when you fix them.
          </span>
        </li>
        <li>
          <Icon name="alert" size={14} /> <span>
            Forty-five minutes on one application. Rejected by a script
            before your next lecture — or never answered at all.
          </span>
        </li>
      </ul>
      <p className="muted flush-bottom">
        A manual application runs about 20–40 minutes, and a serious
        search is hundreds of them. That math is your semester. The
        monotony isn&apos;t building character — it&apos;s just eating
        the hours you&apos;d spend on the things that actually get you
        hired: projects, people, sleep.
      </p>
    </div>
  );
}

export function WhatItDoesCard(): JSX.Element {
  return (
    <div className="card">
      <h2>What Dispatch does while you live</h2>
      <ul className="setup-list">
        <li>
          <Icon name="search" size={14} /> <span>
            <strong>Finds the real form</strong> — follows each posting to
            the employer&apos;s actual application page (not a repost of a
            repost), and queues it.
          </span>
        </li>
        <li>
          <Icon name="bolt" size={14} /> <span>
            <strong>Applies while you&apos;re elsewhere</strong> — fills
            every field from the profile and answers you wrote, reads
            each one back to verify, then submits. One day this
            September it put through 7 applications across 5 different
            job boards — a real run, receipts on file.
          </span>
        </li>
        <li>
          <Icon name="mail" size={14} /> <span>
            <strong>Gets you past the pile</strong> — finds real people
            inside the company and drafts them a short, specific email
            for you to review and send yourself. Dispatch never sends
            mail in your name.
          </span>
        </li>
        <li>
          <Icon name="alert" size={14} /> <span>
            <strong>Taps you in when it should</strong> — an essay, a
            CAPTCHA, a login it doesn&apos;t have: that application is
            parked as a short to-do for you, and the rest of the queue
            keeps moving.
          </span>
        </li>
      </ul>
    </div>
  );
}
