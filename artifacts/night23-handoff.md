# Night23 handoff prompt (written 2026-08-31 ~18:20 EDT, night22 end)

Paste everything below into the next session:

---

Standing overnight authorization applies: run all commands without asking;
push-notify only for urgent (auth unrecoverable, safety-flag problem, broken
repo). Read `artifacts/overnight-issues-2026-08-31.md` (night22, issues
#96–#106) and memory (`overnight-loop-conventions`) first — continue that
process, don't reinvent it.

CONTEXT: night22 ended with TIAA SUBMITTED→VERIFIED→COMPLETED (first-ever
Workday submission, receipt-attempt-15.png). All fixes committed through
`64b253fd` (gate 1442/1442 green). The computer was shut down MID-WAY through
the outreach backfill, killing the script `private/tmp-outreach-backfill.sh`.

DO, in order:

1. Preflight: `npx tsx private/tmp-restart-cdp.ts` (a real connectOverCDP
   attach check — the HTTP probe lies; expect the #13 wedge after any
   process kill).

2. FINISH THE OUTREACH BACKFILL — for each submitted app that still lacks
   Gmail drafts, run: `contacts:insider --application <id> --headed`, then
   per contact `email:generate` then `gmail:draft --headed`. One generate
   retry max per rejected contact; further rejections stay parked as review
   items (persona-fit, operator's to improve). Check what already landed:
   TIAA fda27acb… has 3 drafts / 3 parked rejections — done, skip it.
   Jump Trading c5a627f2… fully done — skip. Re-check DB before running:
   apps = COMPLETED/SUBMITTED minus those two →
   1e213072-a614-41a9-9e9f-c8206965333e (Neuralink),
   2d517c7a-8b64-43d6-8d6b-58a85c779851 (DV Trading),
   6cb05b18-3160-41a7-80b0-930b4a842f9b (Old Mission),
   11eba960-21a4-4bfc-be45-5396f4a357fb (Exa).
   The killed script may have partially processed some — query
   contacts/email_generations/gmail_drafts per app and only run the
   missing steps. Drafts only — Send is forbidden; the operator sends.

3. RESTART THE APPLICATION PIPELINE: one job at a time,
   `npm run auto:cycle -- --no-update --headed --max-apps 1 --app-deadline 180`,
   stay on the same job until submitted or operator-blocked (night20
   directive). After EVERY future submitted job, run the same outreach
   chain (insider → generate → draft) before moving on — standing operator
   directive from night22.

4. Log to `artifacts/overnight-issues-<date>.md`, numbering from #107.
   Gate solo before every commit (this box can't run gate + live browser
   together; `npm run test -- --maxWorkers=2`). Verify-in-place, the #97
   consent widgets, #101 date widgets, #105 checkbox groups, and #106
   Review-page submit recognition are all committed — Workday tenants
   should now run end-to-end; the known-good pattern for TIAA-class silent
   sign-ins: don't grind — the create route establishes the session, rerun.

Known open items: #77 tenant sign-in click swallowed (workaround holds),
#83 phoneType replay fence, #55 CDP attach preflight, #29 review re-parks,
#19 Cloudflare. Operator data flagged ⚠ for review in the night22 log:
internal_investigation No, IRCA Yes, major GPA 3.5, highest completed
High School/GED, graduation May 2029.
