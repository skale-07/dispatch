# College launch plan — September 2026

How Dispatch reaches US college students during fall recruiting season. Every factual
claim carries its source URL inline; claims we could not verify are flagged in §7
rather than silently dropped. Sourcing caveat: much competitor-review content on the
open web is SEO material published by competing tools (Loopcv, Scale.jobs, Resumly,
etc.) — directionally useful, biased. Primary sources (Trustpilot, Chrome Web Store,
GitHub, official pricing/help pages, university career pages) were preferred.

Marketing invariant, inherited from the product's house rules: **we never fabricate
user counts, testimonials, or outcomes.** Dispatch's whole differentiation is
receipts; marketing that can't show a receipt doesn't ship.

---

## 0. Positioning — why this product can win this market

Reviews of every competitor converge on four complaint clusters
(sources per tool in §2):

| Universal complaint | Dispatch's built-in answer |
|---|---|
| Broken/wrong fills — incl. work-authorization errors | Fills only from the student's own written profile; every field read back and verified; demographic answers never inferred |
| Spam-quality applications, near-zero callbacks | Real employer ATS pages (not aggregator reposts), one confirmed submit each, plus drafted insider outreach per application |
| Subscription traps — weekly-billed-as-monthly, hard cancellation, no refunds | Transparent quota pricing (§3); local-first, no account required to run |
| Opaque pricing | Public quota numbers; the invite tier states its application count up front |

The one-line pitch that follows: *"It applies while you're in class — and shows you
the screenshot."* The tools that win with this audience "are the ones that help you
be precise, not prolific"
(https://aiapplyd.com/blog/job-search-tools-reddit-recommends-2026).

---

## 1. Channels

### 1.1 A free GitHub artifact + campus CS/business clubs (the proven wedge)

The most instructive precedent in this exact market is **Pitt CSC × Simplify**: a
student club's GitHub internship list, co-maintained with a commercial product,
became that product's default distribution channel. The Summer 2027 internships repo
sits at ~47.0k stars and is "updated daily by Simplify and Pitt CSC"
(https://github.com/SimplifyJobs/Summer2027-Internships); their New-Grad list is at
~17.8k stars (https://github.com/SimplifyJobs/New-Grad-Positions). The playbook is
recognized enough to have copycats
(https://github.com/speedyapply/2027-SWE-College-Jobs).

Implication for Dispatch: partner with one club to co-brand a **free, no-strings
artifact** (e.g., a maintained "which ATS is this posting really on / does it need an
account / how long is the form" dataset, which Dispatch's inspect pipeline already
produces as a byproduct). The club gets a resume line and a real tool; Dispatch gets
the distribution.

Club/hackathon sponsorship is the standard secondary route: Capital One sponsored 40
student hackathons in a single year
(https://medium.com/capital-one-tech/student-hackathons-are-magic-2b1c687099b), and
tool vendors sponsor with credits plus "best use of our tool" prizes
(https://guptadeepak.com/hackathon-sponsorship-guide/). Sponsors get in via warm
intros and products students already use (https://alexeymk.com/hosting-hackathons/,
https://github.com/asong4211/Hackathon_Sponsorship).

### 1.2 University and career Discord servers

Discord skews 18–24 (~38% of web users), and official Student Hubs are
school-email-gated campus directories
(https://www.dailytoreador.com/news/discord-servers-connects-students-student-organizations/article_00ea1270-1972-11ec-8a03-87104ecbdf58.html,
https://info.mssmedia.com/blog/advertise-to-students-with-emerging-media-discord).
Named targets: CS Career Hub ~38.5k members
(https://discord.com/servers/cs-career-hub-334891772696330241), cscareers.dev
(https://discord.com/invite/cscareers), CS Majors ~31.6k
(https://discord.com/invite/csmajors).

Entry norm: **negotiate with the server owner** — sponsored announcement, pinned
message, dedicated channel, or founder AMA. Benchmarks: $200–$500 per announcement in
an engaged ~10k-member niche server, $500–$5,000 for larger campaigns
(https://blog.communityone.io/discord-monetization-guide-2026/,
https://www.discords.ai/blog/how-discord-server-owners-make-money-2026,
https://digiday.com/media/brands-turn-to-discord-servers-as-a-means-to-reach-niche-influencer-channels-in-their-own-communities/).
Cold-posting without mod blessing reads as spam and burns the server permanently
(https://orbithq.eu/blog/how-to-actually-make-money-from-your-discord-server).

### 1.3 Reddit (r/csMajors, r/cscareerquestions) — founder story or nothing

Scale: r/csMajors ~459k members, +18.8% in the past year
(https://gummysearch.com/r/csMajors/); r/cscareerquestions ~2.4M
(https://thehiveindex.com/communities/r-cscareerquestions/,
https://gummysearch.com/r/cscareerquestions/).

Norms: a third-party rules database records r/cscareerquestions as **"Banned for
course/tool promotion"** with a 60+ day account age gate and karma threshold, and no
approved self-promo lane
(https://www.soar.sh/blog/self-promotion-rules-by-subreddit-database). r/csMajors'
explicit rules could not be fetched (see §7) — read the sidebar before posting.

What succeeds there: free, no-strings, founder-transparent tools. The canonical win
is HiringCafe — the founder's "I scraped 1.6 million jobs" post went viral and the
free product now claims 83,000+ Reddit fans (https://hiringcafe.com/about,
https://scoutify.com/blog/hiringcafe-review/,
https://therevive.substack.com/p/hiringcafe-is-ready-for-this-moment). The cautionary
tale is LazyApply, whose Reddit presence is dominated by "do not use this" warnings
(https://blog.loopcv.pro/lazyapply-review/,
https://www.trustpilot.com/review/lazyapply.com).

Dispatch's Reddit play is therefore a **build-in-public founder story with
receipts** — "I built a local agent that fills the form, shows me a screenshot of
every submission, and can't send email as me; here's a real day of runs" — never an
ad, never a coupon post.

### 1.4 Career centers and newsletters

Two institutional paths, both slower B2B motions worth starting in September but not
counting on for launch volume:

- **Handshake employer route**: register an employer profile, connect to schools,
  submit events; appears in career-center email streams; expect vetting
  (https://www.american.edu/careercenter/employers/handshake.cfm,
  https://careerservices.syr.edu/resources/handshake-2/,
  https://www.nyu.edu/students/student-information-and-resources/career-development-and-jobs/find-a-job-or-internship/handshake-info.html).
- **Licensed-tool route**: career centers license and promote tools per-school —
  VMock is in 200+ institutions
  (https://www.insidehighered.com/news/2019/12/17/résumé-scanners-gain-ground-college-career-centers,
  https://career.gsu.edu/vmock/, https://career.ucf.edu/vmock/,
  https://careers.bu.edu/channels/career-tools-platforms/).

Faster: **student-run newsletter placements** — CPM $10–$75 (niche ≈ $23); a 3–10k
list runs roughly $75–$500 per placement
(https://www.paved.com/blog/newsletter-sponsorship-rates/,
https://www.beehiiv.com/blog/newsletter-sponsorship-cost).

### 1.5 TikTok / Instagram Reels — receipts are native content

Demand evidence: Zety's 2025 Gen Z report found 46% of Gen Z secured a job or
internship via TikTok and ~20% landed interviews through it
(https://blog.theinterviewguys.com/1-in-5-gen-zers-get-interviews-thanks-to-tiktok/,
https://www.fastcompany.com/91223860/gen-zers-are-landing-job-interviews-through-tiktok);
NACE is more conservative — under 1 in 3 students use AI job-hunt tools at all
(https://www.insidehighered.com/news/student-success/life-after-college/2025/10/16/students-weigh-ai-assisted-job-searches),
which reads as headroom, not absence of demand.

Formats that demonstrably perform in this niche: "day in the life";
struggle-and-receipts content (a real viral example: Wonsulting's "4,000
applications, 60 interviews, 1 offer" —
https://www.tiktok.com/@jerryjhlee/video/7499616797478374698); stitch-based video
applications; hook in the first 3 seconds
(https://www.theleap.co/blog/careertok-tiktok-trend/,
https://www.worklife.news/talent/tik-tok-job-application/,
https://www.vice.com/en/article/gen-z-started-using-tiktok-to-find-jobs-out-of-desperation-and-its-actually-working/).

Dispatch-specific format ideas (all use only real runs — the product literally
produces the footage):

1. **The 3-minute submit**: unedited screen recording of the console working one
   real application end to end, ending on the stored screenshot receipt.
2. **"While I was in lecture"**: phone clip of a lecture hall, cut to the console's
   run timeline showing what submitted during that hour.
3. **Receipts reveal**: flip through the screenshot receipts of one real day — the
   honest version of the results-reveal genre. Our real framing line: *"7
   applications submitted in one day across 5 different job boards"* (an actual
   2026-09-01 run, receipts on file in the product).
4. **The ritual, dramatized**: 40 seconds of retyping the same work history into a
   form that clears itself, cut to Dispatch doing it. Wry, not salesy.

Creators for later partnership (once there's budget): Erin McGoff / @advicewitherin
~2.8M TikTok (https://www.linkedin.com/in/erinmcgoff/); Wonsulting, 1.5M TikTok,
sells brand partnerships (https://www.wonsulting.com/partnerships); Jerry Lee ~745k
TikTok (https://www.tiktok.com/@jerryjhlee?lang=en).

---

## 2. Competitor scan

| Tool | Actually submits? | Pricing | Reputation and complaints |
|---|---|---|---|
| **Simplify** (closest analog) | No — autofill assist, human clicks submit | Free unlimited autofill; Simplify+ $19.99/wk, $39.99/mo, $89.99/3mo (https://help.simplify.jobs/articles/5623502-whats-included-in-simplify-features-and-pricing) | Chrome Web Store ~4.9/5 from ~3.7k ratings, 500k+ users (https://chromewebstore.google.com/detail/simplify-copilot-autofill/pbanhockgagggenencehbnadejlgchfc/reviews); complaints: wrong-field fills, crashes, generic AI cover letters, misses open-ended screeners (https://blog.loopcv.pro/simplify-review/, https://www.resumly.ai/answers/simplify-jobs-review) |
| **LazyApply** | Yes | Annual-only, no free tier (https://blog.fastapply.co/is-lazyapply-legit-2026-review) | Trustpilot 2.1/5 (110 reviews): "typically fails (90% of the time)", "There is no 'support'. Period." (https://www.trustpilot.com/review/lazyapply.com); wrong screener answers incl. work-authorization errors (https://blog.loopcv.pro/lazyapply-review/) |
| **JobRight.ai** | Marketed as agent; agent waitlist-gated ("sold as autopilot, behaves as copilot") | Turbo $29.99 → $39.99/mo (+33%), no trial/refunds, pricing page 404s (https://zplatform.ai/ai-reviews/jobright-ai/, https://outapply.com/blog/jobright-ai-pricing); free tier ~2–4 credits/day | Trustpilot 4.8/5 (2,946 reviews) with billing complaints concentrated in the one-star band (https://www.trustpilot.com/review/jobright.ai); resume AI inventing skills, phantom listings (https://favtutor.com/jobright-ai-review/) |
| **Sonara AI** | Did (cautionary tale) | — | Shut down Feb 1 2024 for lack of funding mid-users'-searches; acquired by BOLD and relaunched; ~4.0/5 from only 89 reviews (https://blog.loopcv.pro/what-happened-to-sonara/, https://www.applypass.com/post/sonara-ai-alternative-is-sonara-shutting-down) |
| **AIApply** | Auto-apply costs extra | $29/mo covers writing toolkit only; real auto-apply ≈ $70+/mo (https://checkthat.ai/brands/aiapply/pricing) | Trustpilot 4.3/5 (700+) but 100+ one-star; bait pricing ("shown at $12/week bills as $49/month") (https://scoutify.com/blog/aiapply-review/) |
| **Massive (UseMassive)** | Partial/assisted | $49/mo ≤50 apps, $99/mo ≤200 apps incl. Workday/iCIMS (https://www.sorce.jobs/reviews/massive) | "$300 for 107 applications and a single interview" (https://www.trustpilot.com/review/usemassive.com, https://www.adzuna.com/blog/usemassive-review-alternatives/) |
| **Careerflow** | No | ~$14/mo annual (https://www.toolsforhumans.ai/ai-tools/careerflow) | Crippled free tier; autofill "barely works"; AI inserts wrong info (https://www.flashfirejobs.com/blog/is-careerflow-worth-it) |
| **Teal** | No (zero auto-apply) | $13/wk, $29/mo, $79/qtr; weekly price rose $9→$13 in 2025 (https://blog.loopcv.pro/teal-hq-review/) | Praised free tier; hard-to-cancel billing, generic AI, ATS formatting failures (https://www.resumly.ai/answers/teal-review) |
| **JobCopilot** | Yes | From $8.90/wk (~$35–40/mo), no free tier (https://blog.loopcv.pro/jobcopilot-review/) | Ghost-listing applies, duplicate charges, <2% response rates reported (https://www.trustpilot.com/review/jobcopilot.com) |
| **BulkApply** | Yes | $15.99/mo; "unlimited" $23.99/mo (30 jobs/day) (https://www.sorce.jobs/blog/top-ai-job-search-tools-compared-review) | — |
| **Ladders Apply4Me** | Human-assisted | Inside Premium $49.97/mo … $299.64/yr; capped 50 apps/mo, cap poorly advertised (https://support.theladders.com/en_us/premium-membership-pricing-HycUhWHtlx, https://www.theladders.com/apply4me) | Cap surprise is the recurring complaint |

Taxonomy: autofill-only (Simplify, Teal, Careerflow; HiringCafe is search-only);
marketed-auto but gated/partial (JobRight, Massive, AIApply); actually submits
(LazyApply, JobCopilot, BulkApply, Ladders Apply4Me). Dispatch belongs to the
"actually submits" class — where every incumbent has a trust problem — while
carrying none of their trust debt: local-first, fail-closed capability gates, fills
only from the student's own profile, screenshot receipt per submission, and an email
system that can only draft, never send.

---

## 3. Pricing sketch (student product)

Market band: $14–$50/mo, clustering **$29–$40/mo for AI tiers** (per-tool sources in
§2). The mainstream anchor students already know is LinkedIn Premium Career at
$29.99/mo ($19.99 annual; up to $39.99 for new signups)
(https://socialrails.com/blog/linkedin-premium-pricing,
https://salesbread.com/how-much-does-linkedin-premium-cost/). Even ~$149/yr "feels
substantial on an entry-level salary" (Careerflow complaint, §2), and Teal's $13/wk
is called "steep" — students are price-sensitive and searches are episodic, which is
why Simplify, Teal, and JobCopilot all sell weekly SKUs.

Free-tier norms that calibrate our invite quota: JobRight free ≈ 2–4 credits/day
drip; Simplify's free tier is unlimited autofill but no AI; Massive trials 4 days;
LazyApply has zero free tier and is widely resented for it (sources in §2).

**Sketch (proposals, not commitments):**

- **Invite tier (free):** an invite link grants **15 completed applications**
  (defensible range 10–25 — above JobRight's daily drip, comfortably below the
  cheapest paid app-count tier, 50/mo at $49 from Massive/Ladders). "Completed"
  means submitted-with-receipt, which the invite/quota system under construction
  already measures. The quota is stated on the invite page — countering complaint
  cluster #4 (opaque pricing).
- **Student monthly: $15/mo, 50 completed applications** — deliberately half the
  $29–40 cluster, above BulkApply's bargain tier, at Massive's 50-app quota for
  under a third of its price.
- **Season pass: $39 for 3 months, 150 applications** — matches the episodic shape
  of a search (application intent peaks in a ~6-week fall window, §5) without a
  weekly SKU, since weekly billing is the #1 subscription-trap complaint in §2.
- **Anti-trap commitments, published verbatim:** monthly prices shown monthly; cancel
  in one click; unused quota rolls over one month; no auto-upgrade. Each one is the
  inverse of a §2 complaint and costs us almost nothing.

Flag: **no credible survey of student willingness-to-pay surfaced** (searched; none
found — §7). Adoption context: 73–80% of students/grads use AI somewhere in
applications
(https://www.peoplemanagement.co.uk/article/1960804/three-quarters-students-graduates-use-ai-during-job-applications-study-finds,
https://clutch.co/resources/state-ai-hiring), versus NACE's <1 in 3 using dedicated
AI job-hunt tools; ZipRecruiter finds AI-powered seekers ~2x as likely to land
offers (https://www.ziprecruiter-research.org/economic-insights-research/ai-powered-job-seekers).

---

## 4. Referral-loop design

Precedents, in order of relevance to our invite/quota mechanics:

- **Dropbox** (two-sided reward): 500MB to *both* sides per referral, capped at
  16GB; 100k → 4M signups in 15 months; referrals outperformed paid channels 2.8x;
  the ask was surfaced during onboarding
  (https://viral-loops.com/blog/dropbox-grew-3900-simple-referral-program/,
  https://growsurf.com/blog/dropbox-referral-program/).
- **Robinhood** (waitlist position ladder): each referral moves you up the queue;
  ~1M waitlisted pre-launch (https://viral-loops.com/blog/how-robinhoods-referral-built-a-1m-user/,
  https://getwaitlist.com/blog/robinhood).
- **Tinder** (campus seeding): sorority→fraternity campus walks took it <5,000 →
  ~15,000 users after one trip; download-required launch parties
  (https://medium.com/scott-d-clary/sorority-parties-to-50-million-users-the-tinder-go-to-market-strategy-marketing-case-study-9c003b48dc8d).
- **Fizz** (launch leaders + school-email exclusivity): 13 → 25 campuses in ~2
  months, 240 campuses by mid-2024, no paid marketing claimed
  (https://techcrunch.com/2022/11/23/fizz-college-social-app-series-a/,
  https://ethicsinsociety.stanford.edu/sites/ethicsinsociety/files/media/file/case_study_fizz1.pdf).
- **Perplexity Campus Strategist** (most copyable current playbook): ~3 strategists
  per campus, 2–3 hrs/month, cash per verified signup via affiliate program, campus
  budget, Pro access, merch (https://www.perplexity.ai/campus-strategists,
  https://www.perplexity.ai/hub/legal/campus-partners-program-terms,
  https://hirededge.beehiiv.com/p/perplexitys-campus-strategist-program).
- **Notion Campus Leaders** (selective, plan-required): template build-a-thons and
  workshops; perks are free Pro, event kits, co-marketing
  (https://www.notion.com/product/notion-for-education,
  https://jelliefish.substack.com/p/leading-the-notion-community-at-uiuc).
- Scale benchmark, for much later: Red Bull runs 4,000+ paid ambassadors at $18–21/hr
  (https://brandchamp.io/blog/red-bull-ambassador-program/).

**Proposed loop, built on the invite/quota system in flight:**

1. Every invite link carries a stated quota (15 completed applications, §3).
2. **Two-sided quota bonus** (Dropbox): when an invitee *completes 5 applications*
   (real usage, not signup — resistant to farming because completion requires
   receipts), the inviter earns +10 completed applications, capped (e.g., +100).
3. **Waitlist ladder** (Robinhood): before invites unlock broadly, referrals move
   students up the queue; the counter is public.
4. **Campus strategists** (Perplexity model): 3 students per pilot campus, paid per
   verified activated invite (activation = 5 completed applications), plus a free
   season pass and a small event budget. Selective like Notion's program — require a
   one-paragraph plan.
5. The unit that travels is the **receipt**: sharing a (self-redacted) screenshot of
   a submitted application with an invite code footer is the organic loop — the
   proof and the pitch are the same artifact.

---

## 5. Why September — timing evidence and week-by-week calendar

Summer 2027 internship postings open **July–October 2026**: Amazon/Databricks first
(Jul–Aug), Microsoft mid-August, Salesforce late Aug–early Sept
(https://www.extern.com/post/tech-internships-summer-2027-guide,
https://simplify.jobs/blog/summer-2027-internship-timeline). Live evidence: Anduril's
2027 SWE Intern req on Greenhouse has been reviewing since August 2026
(https://job-boards.greenhouse.io/andurilindustries/jobs/5148079007?gh_jid=5148079007),
and the SimplifyJobs Summer2027 repo is already populated. Rolling hiring makes the
urgency real: "Strong applicants who wait until November lose spots to weaker
applicants who submitted in August… the first 2–3 weeks matter more than anything
else" (https://www.extern.com/post/when-to-apply-for-internships-guide) — that line
is our core urgency message. New-grad roles are also posting Aug–Sep (e.g., 3,572 in
NYC on Glassdoor in Aug 2026), though the Aug–Sep *concentration* for big-tech
new-grad reqs specifically is only indirectly evidenced (§7).

Career-fair season runs mid-September to early October: USC Sept 10, UMD from Sept
15, NYU Business Sept 22 / Tech Oct 9, Vanderbilt Sept 23, UNH Sept 8–Dec 4
(university pages, via the timing sources above). Application intent peaks roughly
four weeks after Labor Day → an invite-gated launch lands in the **first half of
September**.

### Calendar

**Week 1 — Sep 1–7 (pre-launch, seed):**
waitlist page live with the Robinhood ladder; record the first batch of
receipts-format videos from real runs (the 3-minute submit; the Sep 1 "7 across 5
boards" day); finalize the club partnership and the free GitHub artifact; recruit
strategists at 3–5 pilot campuses; draft the founder post and have it sanity-read by
someone fluent in each subreddit's norms; open conversations with 2–3 Discord server
owners (§1.2 rates).

**Week 2 — Sep 8–14 (launch, first half of September per the timing evidence):**
invites unlock for the waitlist top; free artifact ships under the club's name;
founder build-in-public post on the permissible subreddit(s) only — rules re-read
first (§1.3, §7); first two short-form videos post; strategists run door-list
tabling at the week's career fairs (USC 9/10, UNH from 9/8).

**Week 3 — Sep 15–21 (community week):**
paid/sponsored placement or founder AMA in one career Discord (mod-blessed, §1.2);
2–3 more receipts videos, iterating on whichever hook held; strategists at UMD
(9/15+) fairs; first student-newsletter placements ($75–$500, §1.4); watch invite
activation (5-completions) rate as the north-star metric.

**Week 4 — Sep 22–30 (referral push + retro):**
turn on the two-sided quota bonus publicly; strategists at NYU (9/22) and Vanderbilt
(9/23) fairs; publish a transparent "first month, real numbers" recap (counts from
the database, screenshots as proof — the marketing artifact only this product can
make); begin the slow institutional motions (Handshake employer profile,
career-center licensing conversations, §1.4) so they mature by spring recruiting;
retro on channel CAC vs. activation and pick the two channels that earned October.

---

## 6. Top-5 highest-leverage moves, ranked

1. **Ship a free club-branded GitHub artifact with one campus CS club** — the Pitt
   CSC × Simplify wedge is the single proven, zero-ad-budget distribution channel in
   this exact market (47k stars, §1.1). Everything else gets easier once we're "the
   tool behind the list students already use."
2. **Founder-transparent Reddit/build-in-public launch, receipts-first** — the
   HiringCafe precedent shows honest + free + specific wins this audience; the
   LazyApply thread graveyard shows what happens otherwise (§1.3). Our safety story
   (your words only, screenshot receipts, can't send email) is uniquely suited to
   surviving that room.
3. **Receipts-native short-form content** — the 3-minute unedited submit recording
   and the real "7 applications, one day, 5 job boards" day are footage the product
   generates for free, in the exact struggle-and-receipts format that demonstrably
   performs on CareerTok (§1.5).
4. **Two-sided quota referral loop on the invite system** — Dropbox mechanics
   (both sides earn quota) with a Robinhood waitlist ladder, using
   completed-with-receipt applications as the anti-farming activation unit (§4).
   This makes every satisfied user a distributor at zero marginal cost.
5. **Campus strategist pilot at 3–5 schools, timed to their career fairs** — the
   Perplexity playbook (3 students/campus, paid per verified activation, §4) pointed
   at the §5 fair calendar; it compounds channels 1–4 on the ground during the
   exact weeks intent peaks.

---

## 7. Honesty flags — what we could not verify

Kept deliberately, per the validation-ladder culture of this repo:

1. **r/csMajors' explicit self-promotion rules** — Reddit blocked programmatic
   fetch and no mirror was found; the r/cscareerquestions "banned for tool
   promotion" record comes from a third-party database
   (https://www.soar.sh/blog/self-promotion-rules-by-subreddit-database). A human
   must read both sidebars before any post.
2. **Student willingness-to-pay** — no credible survey quantifying what students
   will pay for job-search tooling was found; the §3 price points are triangulated
   from competitor pricing and complaint language only.
3. **Big-tech new-grad (vs. internship) posting concentration in Aug–Sep** — the
   internship-timing evidence is strong and primary-sourced; the new-grad claim is
   indirect (aggregate posting counts), so the launch messaging should lean on
   internship timing.

Also inherited from the research pass: several competitor-complaint sources are blogs
run by competing tools; where a claim mattered (prices, Trustpilot scores, star
counts), primary sources were used.
