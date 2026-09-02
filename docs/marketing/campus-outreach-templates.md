# Campus outreach templates (Sept 2026)

Copy-paste templates for the three campus channels in
`college-launch.md` §1: club presidents (DM + email), career-center /
student newsletters, and subreddit posts. Every template references an
invite link in the contract's shape, `https://<origin>/redeem?code=JRA-XXXX-XXXX`,
or the waitlist, `https://<origin>/#waitlist`. Replace `<origin>` with the
deployed origin (the same value as `VITE_PUBLIC_URL`).

Non-negotiables baked into every template:

- **No invented numbers.** No user counts, no campus counts, no
  testimonials. The only stat is the real Sep 1 run — 7 applications
  across 5 job boards in one day, receipts on file — and it is always
  attributed to a real run.
- **The truth about the product, stated the same way every time:** it
  applies on real employer sites from a profile you write once; every
  submission stores a screenshot receipt you can open; it never sends
  email as you (drafts only); your invite states how many applications
  it covers before you sign up.
- **Invite-only means the CTA is a code or the waitlist.** Never
  "sign up free today".
- **One code per recipient group.** A club gets its own code batch so
  redemptions attribute cleanly; a newsletter gets one code (or the
  waitlist link plus UTM) — see "Attribution" at the end.
- **Founder voice, first person.** Reddit and club presidents smell
  marketing copy from a mile off; the Reddit rules in particular ban
  tool promotion outright on r/cscareerquestions
  (https://www.soar.sh/blog/self-promotion-rules-by-subreddit-database).

Placeholders: `{{first_name}}`, `{{club}}`, `{{school}}`, `{{code}}`,
`{{n_apps}}` (the number of completed applications the code covers — read
it from the invite, don't guess), `{{fair_date}}`, `{{founder}}`.

---

## 1. Club presidents (CS / business / consulting / engineering clubs)

Why clubs: the Pitt CSC × Simplify precedent — a club-maintained
internship list is the distribution channel for a commercial tool,
~47k stars (https://github.com/SimplifyJobs/Summer2027-Internships;
`college-launch.md` §1.1). The offer to a club is a **free, no-strings
thing their members want**, plus a code batch, not sponsorship money.

### 1a. Cold DM (Discord / Instagram / LinkedIn) — under 500 characters

> Hey {{first_name}} — I run Dispatch, an agent that fills out job
> applications on real employer sites from a profile you write once, and
> keeps a screenshot receipt of every submission so you can check its
> work. It's invite-only right now. I'd like to give {{club}} a batch of
> invite codes for the members who are applying for Summer 2027 this
> month — no sponsorship ask, no pitch at your meeting, just codes and a
> way to reach me when something breaks. Worth 10 minutes this week?

If they reply, the second message carries the proof, not more pitch:

> Here's what it actually looks like: one real application, one real
> timer, no keystrokes from me — [link to the Script 2 video]. And a
> receipt it stored: [redacted receipt PNG]. Codes look like
> `https://<origin>/redeem?code=JRA-XXXX-XXXX` and each one says on the
> page how many applications it covers before anyone signs up.

### 1b. Email to a club president / officer board

Subject: `invite codes for {{club}} members applying this month`

> Hi {{first_name}},
>
> I'm {{founder}}. I built Dispatch, an agent that does the worst part of
> the internship hunt — the forms. You write your profile once; it
> applies on real employer sites (Greenhouse, Lever, Ashby, Workday and
> the rest), and for every submission it stores a screenshot receipt
> that you can open from your dashboard. It answers only from what you
> wrote — a question your profile doesn't cover becomes a to-do for
> you, not a guess. It drafts outreach emails to people inside the
> company, but it cannot send email as you; that is built in, not a
> setting.
>
> It's invite-only while the queue is small, and I'd like {{club}} to
> have a block of codes for members who are applying for Summer 2027
> roles this September. Rolling hiring is real: the postings open
> July–October and the first few weeks matter most
> (https://www.extern.com/post/when-to-apply-for-internships-guide).
>
> What I'm offering:
> - {{n_codes}} invite codes for {{club}} members; each code states the
>   number of applications it covers before sign-up (currently
>   {{n_apps}}).
> - A direct line to me for anything that breaks — I read every
>   report.
> - Optionally, a free artifact under {{club}}'s name: a maintained list
>   of which internship postings need an account, which ATS they're
>   really on, and how long the form is. Our pipeline produces this as
>   a byproduct; your name goes on it, no strings.
>
> What I'm not asking for: money, a slot at your meeting, or a
> social post. If members like it, they'll say so; if they don't,
> I'd rather hear that.
>
> The honest disclosures: it's a new product from one person; it
> submits real applications in your name, so the receipts exist
> precisely so you can check it; the only number I'll quote is a real
> run from September 1 — 7 applications across 5 job boards in a day,
> receipts on file. No user counts, because I won't invent them.
>
> Here's a 30-second recording of one real application, timer running,
> no keystrokes from me: [link].
>
> If that's interesting, reply and I'll send the codes today.
>
> {{founder}}
> Dispatch · https://<origin>

### 1c. The message the president forwards to members (write it for them)

> Dispatch is an agent that fills out job applications on real employer
> sites from a profile you write once and keeps a screenshot receipt of
> every submission. It's invite-only; {{club}} got a batch of codes.
> Yours: `https://<origin>/redeem?code={{code}}` — it covers {{n_apps}}
> applications, and it says so on the page before you sign up. Made by
> {{founder}}; report anything broken to {{contact}}. It can't send
> email as you and never fills in anything you didn't write.

---

## 2. Career-center and student newsletters

Two different audiences. A **career center** is an institution with a
vetting process (Handshake employer registration, licensed tools —
`college-launch.md` §1.4); the pitch is compliance and receipts. A
**student-run newsletter** sells placements ($75–$500 for a 3–10k list,
https://www.paved.com/blog/newsletter-sponsorship-rates/) and wants copy
that reads like their own voice.

### 2a. Email to a career-center staff member

Subject: `a job-application agent with receipts — for review, not promotion`

> Dear {{name}},
>
> I'm {{founder}}, the developer of Dispatch, a tool that submits job
> applications on students' behalf on real employer sites, from a
> profile the student writes once. I'm writing to ask for your review
> before any {{school}} student hears about it from me, because a tool
> that submits in a student's name should be looked at by the people who
> advise them.
>
> The properties I'd want you to check:
> - Every submission stores a screenshot receipt and the confirmation
>   text; the student can open it from their dashboard.
> - Fields are filled only from the student's own written profile.
>   Nothing is scraped or inferred; an unanswered question stops the
>   application and becomes a to-do.
> - Self-identification (EEO) questions are answered only from a
>   separate, encrypted profile the student fills in themselves, or
>   skipped entirely.
> - It drafts intro emails to people at the company for the student to
>   review; it cannot send email as the student.
> - Access is by invite; every invite states the number of applications
>   it covers up front. No weekly billing, no auto-upgrade.
>
> It is new, built by one person, and I do not have user numbers to
> quote; the only figure I'll cite is a real run on September 1 (7
> applications across 5 job boards in a day, receipts retained). I'd
> welcome the chance to walk through a live application with you, or to
> provide invite codes for a small group of students you choose, with
> whatever reporting you'd like back.
>
> Sincerely,
> {{founder}}
> https://<origin>

### 2b. Newsletter blurb, 80 words (student-run newsletter, paid or free)

> **An agent that applies while you're in class — and shows you the
> screenshot.** Dispatch fills out job applications on real employer
> sites from a profile you write once, and stores a screenshot receipt
> for every submission so you can check its work. It answers only from
> what you wrote, and it can't send email as you. Invite-only right now:
> `https://<origin>/redeem?code={{code}}` covers {{n_apps}} applications
> for {{newsletter}} readers, first come. No code? Waitlist:
> `https://<origin>/#waitlist`.

### 2c. Newsletter blurb, 35 words (one-liner slot)

> Dispatch: an agent that fills job applications on real employer sites
> from your own profile and keeps a screenshot receipt of every one.
> Invite-only — `https://<origin>/redeem?code={{code}}` covers {{n_apps}}
> applications.

### 2d. Career-center newsletter listing (their format, third person, no code)

> **Dispatch** (invite-only, free tier) — submits applications on
> employer sites from a student-written profile, with a screenshot
> receipt stored per submission. Drafts but does not send email.
> Waitlist: `https://<origin>/#waitlist`. Reviewed by {{office}} on
> {{date}}.

Only use 2d after the center has actually reviewed it; the "Reviewed
by" line is the whole point and must be true.

---

## 3. Subreddit posts

Read the sidebar first, every time. r/cscareerquestions is recorded as
banning tool promotion outright with account-age and karma gates
(https://www.soar.sh/blog/self-promotion-rules-by-subreddit-database);
r/csMajors' rules could not be fetched programmatically
(`college-launch.md` §7) — a human reads them before posting. If a sub
bans promotion, **do not post the template; post nothing.** The
precedent for what works is HiringCafe's founder post
(https://hiringcafe.com/about); the precedent for what happens otherwise
is LazyApply's thread graveyard
(https://www.trustpilot.com/review/lazyapply.com).

The template is a build-in-public founder post. It contains one link at
most, no code in the body (Reddit treats codes as coupons — the code
goes in a reply only when someone asks), and answers the hard questions
before they're asked.

### 3a. Founder post (r/csMajors or a school subreddit, where allowed)

Title: `I built an agent that fills out my internship applications and keeps a screenshot of every submission — here's a real day of runs`

> Background: I'm a {{year}} at {{school}} and I got tired of typing the
> same work history into Greenhouse for the 30th time. So over the
> summer I built an agent that does it. Posting because the "AI
> auto-apply" space has a well-earned bad reputation and I want to show
> what a version with receipts looks like, not sell anything — it's
> invite-only and I don't have user numbers to brag about.
>
> What it does: you write a profile once (school, history, work auth,
> the "why us" paragraph, etc.). It opens the real employer's apply page
> — not an aggregator repost — fills the form from that profile,
> submits, and stores a screenshot + confirmation text for every
> submission. That's the part I care about: I can open the receipt and
> see exactly what it did in my name.
>
> What it refuses to do, on purpose:
> - Guess. If the form asks something my profile doesn't cover, it stops
>   and gives me a to-do instead of inventing an answer. The
>   work-authorization horror stories from other tools are the reason.
> - Touch EEO / self-ID questions with anything except what I put in a
>   separate encrypted profile — or skip them.
> - Send email. It drafts intros to people at the company; I send them.
>   There is no send function in the code.
>
> A real day (Sep 1): 7 applications across 5 different job boards.
> Here's one unedited recording, timer running, no keystrokes from me:
> [link]. Receipt from the same run, redacted: [image].
>
> Where it breaks: Workday sign-in flows are fragile; long custom
> question sets sometimes produce more to-dos than fills; it's one
> person maintaining it. If you try it and it does something wrong in
> your name, the receipt will show it and I want to know.
>
> Invite-only right now. If a mod is OK with it I'll put the waitlist
> link in a comment; otherwise DM me.

### 3b. Comment reply when someone asks for access (only after the post is up and allowed)

> Waitlist is `https://<origin>/#waitlist` — one email field, nothing
> else stored. If you're at {{school}}, {{club}} has a batch of codes; a
> code looks like `https://<origin>/redeem?code=JRA-XXXX-XXXX` and tells
> you how many applications it covers before you sign up.

### 3c. Reply to "this is just LazyApply / JobRight again"

> Fair default assumption. Two differences you can check rather than
> take my word for: (1) every submission has a screenshot receipt you
> open from the dashboard, so if it did something wrong you'll see it;
> (2) it never fills a field from anything but the profile you wrote —
> an unknown becomes a to-do. Also the invite says the application count
> up front and there's no weekly billing. Here's the unedited recording
> again: [link].

### 3d. School subreddit (r/{{school}}) — shorter, local

Title: `{{school}} students: invite codes for a job-application agent I built (real receipts, no numbers to brag about)`

> I'm a {{year}} here. Built an agent over the summer that fills out
> internship applications on employer sites from a profile you write
> once and keeps a screenshot receipt for every submission. Invite-only;
> {{club}} has a block of codes for {{school}} students this month —
> each code states how many applications it covers. It can't send email
> as you and never invents an answer. If a mod prefers no link, DM me
> for a code. Real recording of one application, no keystrokes: [link].

---

## Attribution

Every code batch is a row in the launcher's `invites` table, so
redemptions per batch are countable today. What is not countable yet:

- Per-student referral codes (the "invite a friend" panel on the
  dashboard is stubbed behind `my_referral_invites` — storefront report
  ask).
- Waitlist attribution: the `waitlist` table stores only the email;
  UTM on the bio/newsletter link is the best available signal.

Until both exist, label codes by channel when minting (one batch per
club, per newsletter, per subreddit thread) and read redemption counts
per batch as the channel metric. The activation metric from
`college-launch.md` §5 (5 completed applications per invitee) needs a
per-invite completed-count read the app does not have yet — same ask.

## Sources

Channel norms, rates, and precedents are those already cited in
`docs/marketing/college-launch.md` §1 and §4 (Pitt CSC × Simplify
repo; Discord and newsletter rate benchmarks; the subreddit-rules
database; HiringCafe and LazyApply precedents; internship timing via
https://www.extern.com/post/when-to-apply-for-internships-guide).
No new web research was done for this file. Product claims come from
the product's house rules and the invite contract; the single stat is
the operator's Sep 1 run.
