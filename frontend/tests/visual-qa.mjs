#!/usr/bin/env node
/**
 * Visual QA walk of the PUBLIC app — every route, every designed state,
 * at desktop (1440) and phone (390) widths, as PNGs an agent or a human
 * can look at.
 *
 * What it is NOT: a test. It has no assertions beyond "the page rendered
 * without a console error"; the judgement happens by reading the pixels
 * and the resulting notes go in docs/marketing/qa-<date>.md.
 *
 * Fixture posture (house rules): it never touches a real Supabase
 * project. The build under test is made with a FIXTURE Supabase URL
 * (see `npm run frontend:build` in the header of docs/marketing/qa-*.md),
 * every network call to that host is intercepted here and answered from
 * the in-file fixtures, and "signed in" is a locally planted session in
 * localStorage. Nothing here can read or write anyone's data.
 *
 * Usage (from the repo root, after building frontend/dist with
 *   VITE_SUPABASE_URL=https://qa-fixture.invalid
 *   VITE_SUPABASE_ANON_KEY=qa-fixture-anon-key):
 *   node frontend/tests/visual-qa.mjs [--out artifacts/qa-frontend/<date>]
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const dist = path.join(repoRoot, "frontend", "dist");

const outArg = process.argv.indexOf("--out");
const outDir = path.resolve(
  repoRoot,
  outArg >= 0
    ? process.argv[outArg + 1]
    : path.join("artifacts", "qa-frontend", new Date().toISOString().slice(0, 10)),
);
fs.mkdirSync(outDir, { recursive: true });

/* ── fixture Supabase identity (must match the build's env) ─────────── */
const FIXTURE_HOST = "qa-fixture.invalid";
const STORAGE_KEY = `sb-${FIXTURE_HOST.split(".")[0]}-auth-token`;
const USER = { id: "11111111-2222-4333-8444-555555555555", email: "maya@pitt.edu" };

/** A structurally valid (unsigned) JWT so supabase-js accepts the session shape. */
function fakeJwt(exp) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: USER.id,
    email: USER.email,
    role: "authenticated",
    aud: "authenticated",
    exp,
    iat: exp - 3600,
    session_id: "qa-session",
  })}.qa-fixture-signature`;
}
function plantedSession() {
  const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
  return {
    access_token: fakeJwt(exp),
    refresh_token: "qa-refresh",
    token_type: "bearer",
    expires_in: 6 * 3600,
    expires_at: exp,
    user: {
      id: USER.id,
      email: USER.email,
      aud: "authenticated",
      role: "authenticated",
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      created_at: "2026-09-01T00:00:00Z",
    },
  };
}

/* ── data fixtures ──────────────────────────────────────────────────── */
const day = (n) => new Date(Date.UTC(2026, 8, n, 15, 0, 0)).toISOString();
const APPS = [
  { id: "a1", company: "Anduril", role: "Software Engineer Intern (Summer 2027)", status: "SUBMITTED", route: "ats", source_ats: "greenhouse", engine_updated_at: day(1), submitted_at: day(1), receipt_path: `${USER.id}/a1/submission.png` },
  { id: "a2", company: "Databricks", role: "Data Engineering Intern", status: "SUBMITTED", route: "ats", source_ats: "lever", engine_updated_at: day(1), submitted_at: day(1), receipt_path: `${USER.id}/a2/submission.png` },
  { id: "a3", company: "Ramp", role: "SWE Intern — Very Long Title That Goes On And On For Layout Testing Purposes", status: "SUBMITTED", route: "ats", source_ats: "ashby", engine_updated_at: day(1), submitted_at: day(1), receipt_path: `${USER.id}/a3/submission.png` },
  { id: "a4", company: "Datadog", role: "Software Engineer Intern", status: "SUBMITTED", route: "ats", source_ats: "greenhouse", engine_updated_at: day(1), submitted_at: day(1), receipt_path: null },
  { id: "a5", company: "Stripe", role: "Product Engineer Intern", status: "NEEDS_REVIEW", route: "ats", source_ats: "greenhouse", engine_updated_at: day(2), submitted_at: null, receipt_path: null },
  { id: "a6", company: "Duolingo", role: "Software Engineer Intern", status: "QUEUED", route: "ats", source_ats: "workday", engine_updated_at: day(2), submitted_at: null, receipt_path: null },
  { id: "a7", company: null, role: null, status: "DISCOVERED", route: null, source_ats: null, engine_updated_at: day(2), submitted_at: null, receipt_path: null },
];
/** user_quota_status row (20260902000400 shape): max is EFFECTIVE = base + bonus. */
const QUOTA = (completed, base = 15, bonus = 0) => ({
  user_id: USER.id,
  max_completed_applications: base + bonus,
  completed_applications: completed,
  remaining: Math.max(0, base + bonus - completed),
  base_max_completed_applications: base,
  bonus_completed_applications: bonus,
});
/** referral_settings() — the launcher's shipped constants (20260902000300). */
const SETTINGS = { max_active_referral_codes: 3, referral_code_quota: 5, activation_completed_applications: 5, inviter_bonus_per_activation: 10, inviter_bonus_cap: 100 };
const CODE = (code, redeemed_at = null, created = day(1)) => ({ code, max_completed_applications: SETTINGS.referral_code_quota, redeemed_at, created_at: created });
const CODES_ONE = [CODE("JRA-9C3T-HX5D")];
const CODES_MIXED = [CODE("JRA-4N7P-2WQ8", "2026-08-30T15:00:00Z"), CODE("JRA-9C3T-HX5D")];
const CODES_CAPPED = [CODE("JRA-9C3T-HX5D"), CODE("JRA-2M7W-K4RP", null, day(2)), CODE("JRA-X8Q3-D6TN", null, day(2)), CODE("JRA-4N7P-2WQ8", "2026-08-30T15:00:00Z")];
const MINTED = { ...CODE("JRA-7V2H-QN8B", null, new Date().toISOString()), active_unredeemed: 1, max_active_referral_codes: SETTINGS.max_active_referral_codes };
const BONUSES = [
  { invitee_user_id: "aaaaaaaa-0000-4000-8000-000000000001", inviter_user_id: USER.id, invite_id: "inv-r1", bonus: 10, granted_at: "2026-08-30T15:00:00Z" },
  { invitee_user_id: "aaaaaaaa-0000-4000-8000-000000000002", inviter_user_id: USER.id, invite_id: null, bonus: 10, granted_at: day(1) },
];
/** engine_status rows (20260902000500); freshness is judged against a 5-minute sync interval, so
 * the timestamp is computed at REQUEST time (a run takes minutes; a row built at startup drifts). */
const ENGINE = (agoMs, last_error = null) => ({
  user_id: USER.id,
  last_seen_at: new Date(Date.now() - agoMs).toISOString(),
  engine_version: "f13308a8",
  last_sync_attempted: 7,
  last_sync_upserted: last_error ? 0 : 7,
  last_sync_duration_ms: 842,
  last_error,
});
const pgError = (status, message, code = "P0001") => () => ({ status, contentType: "application/json", body: JSON.stringify({ code, message, details: null, hint: null }) });
const PROFILE = {
  user_id: USER.id,
  full_name: "Maya Okafor",
  phone: "+1 412 555 0148",
  location_city: "Pittsburgh",
  location_region: "PA",
  location_country: "USA",
  linkedin_url: "https://linkedin.com/in/mayaokafor",
  github_url: "https://github.com/mayaok",
  portfolio_url: null,
  education: [{ school: "University of Pittsburgh", degree: "B.S.", field: "Computer Science", start_year: 2023, end_year: 2027 }],
  work_authorization: "us_citizen",
  needs_sponsorship: false,
  resume_object_path: `${USER.id}/Maya_Okafor_Resume.pdf`,
  resume_filename: "Maya_Okafor_Resume.pdf",
  resume_uploaded_at: day(1),
  job_preferences: { titles: ["Software Engineer Intern", "Data Analyst"], locations: ["NYC", "remote"], remote: "hybrid", employment_types: ["internship"], min_salary_usd: 70000 },
  onboarding_completed_at: day(1),
};

/* ── static server with SPA fallback (no dependency) ─────────────────── */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
function serveDist() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      let file = path.join(dist, decodeURIComponent(url.pathname));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* ── network fixture router ─────────────────────────────────────────── */
/**
 * Every request to the fixture Supabase host is answered here. `mode`
 * picks a scenario; anything unlisted is a 404 with a PostgREST-shaped
 * body so the UI's real error path renders.
 */
function fixtureResponder(mode) {
  const json = (status, body) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  return (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = mode[p.includes("/rest/v1/") ? p.split("/rest/v1/")[1] : p.includes("/rpc/") ? "rpc" : p.includes("/auth/v1/otp") ? "otp" : p.includes("/storage/") ? "storage" : "other"] ?? mode.default;
    if (typeof m === "function") return route.fulfill(m(req));
    if (m === "500") return route.fulfill(json(500, { code: "XX000", message: "fixture: service unavailable", details: null, hint: null }));
    if (m === "hang") return; // never fulfilled: exercises the 6s cap
    return route.fulfill(json(404, { code: "PGRST205", message: `fixture: no handler for ${p}`, details: null, hint: null }));
  };
}
const ok = (body) => () => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * A signed-in member's baseline: profile, quota, apps, the referral
 * loop's constants, one unredeemed code, no bonuses yet, engine never
 * connected. Scenes override the one object they are about.
 */
const member = (over = {}) => ({
  user_profiles: ok([PROFILE]), user_quota_status: ok([QUOTA(4)]), my_applications: ok(APPS),
  "rpc/referral_settings": ok(SETTINGS), my_referral_invites: ok(CODES_ONE), referral_bonuses: ok([]),
  "rpc/mint_referral_invite": ok(MINTED), engine_status: ok([]),
  ...over,
});
/** Signed in, invite just redeemed (or not), blank profile, no app_users row yet. */
const fresh = (over = {}) => ({
  user_profiles: ok([]), "rpc/redeem_invite": ok({ invite_id: "inv-1", max_completed_applications: 15 }), user_quota_status: ok([]), my_applications: ok([]),
  "rpc/referral_settings": ok(SETTINGS), my_referral_invites: ok([]), referral_bonuses: ok([]),
  "rpc/mint_referral_invite": pgError(400, "not a member yet"), engine_status: ok([]),
  ...over,
});

const MODES = {
  signedOut: { default: "404" },
  otpOk: { otp: ok({}) },
  otpRateLimited: {
    otp: () => ({ status: 429, contentType: "application/json", body: JSON.stringify({ code: 429, error_code: "over_email_send_rate_limit", msg: "For security purposes, you can only request this after 58 seconds." }) }),
  },
  freshUser: fresh(),
  inviteFailed: fresh({ "rpc/redeem_invite": pgError(400, "invite already redeemed") }),
  // 20260902000300: the two new verbatim redeem_invite refusals.
  inviteOwn: fresh({ "rpc/redeem_invite": pgError(400, "cannot redeem your own invite") }),
  inviteMember: member({ "rpc/redeem_invite": pgError(400, "already a member") }),
  returningUser: member(),
  lowQuota: member({ user_quota_status: ok([QUOTA(13)]) }),
  exhausted: member({ user_quota_status: ok([QUOTA(15)]) }),
  // 20260902000400: quota tile with an earned bonus (base 15 + 20 from two activated friends).
  quotaBonus: member({ user_quota_status: ok([QUOTA(4, 15, 20)]), referral_bonuses: ok(BONUSES), my_referral_invites: ok(CODES_MIXED) }),
  // Referral panel states (cloud-deploy §9).
  referralNone: member({ my_referral_invites: ok([]) }),
  referralMixed: member({ my_referral_invites: ok(CODES_MIXED) }),
  referralCapped: member({ my_referral_invites: ok(CODES_CAPPED), "rpc/mint_referral_invite": pgError(400, "referral cap reached") }),
  referralViewDown: member({ my_referral_invites: pgError(500, "fixture: service unavailable", "XX000") }),
  // Engine heartbeat states (cloud-deploy §10; SYNC_INTERVAL_MS = 5 min => stale after 10).
  engineRunning: member({ engine_status: () => ok([ENGINE(45_000)])() }),
  enginePushFailed: member({ engine_status: () => ok([ENGINE(70_000, "upsert application_status_mirror: 401 invalid service key")])() }),
  engineOffline: member({ engine_status: () => ok([ENGINE(3 * 3600_000)])() }),
  waitlistOk: { waitlist: () => ({ status: 201, contentType: "application/json", body: "" }) },
  waitlistDup: { waitlist: () => ({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "23505", message: 'duplicate key value violates unique constraint "waitlist_email_key"', details: "Key (email)=(maya@pitt.edu) already exists.", hint: null }) }) },
  serviceDown: { default: "500" },
  serviceHang: { default: "hang" },
};

/* ── the walk ───────────────────────────────────────────────────────── */
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const problems = [];

async function main() {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error(`no build at ${dist} — run the frontend build first`);
  const { server, base } = await serveDist();
  const browser = await chromium.launch({ headless: true });
  const shots = [];

  async function scene(name, { viewport, theme, session, mode, invite, url, act, fullPage = true, keepScroll = false }) {
    const ctx = await browser.newContext({ viewport: VIEWPORTS[viewport], deviceScaleFactor: 1, reducedMotion: "reduce" });
    await ctx.addInitScript(({ key, sess, theme, inviteCode }) => {
      if (sess) localStorage.setItem(key, JSON.stringify(sess));
      if (theme) localStorage.setItem("jaa.console.theme", theme);
      if (inviteCode) localStorage.setItem("dispatch.pendingInvite", inviteCode);
    }, { key: STORAGE_KEY, sess: session ? plantedSession() : null, theme, inviteCode: invite ?? null });
    await ctx.route(`https://${FIXTURE_HOST}/**`, fixtureResponder(MODES[mode ?? "signedOut"]));
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", (err) => errors.push(String(err)));
    // A deliberately hanging fixture never reaches networkidle; settle on
    // load plus a short pause instead.
    const hanging = MODES[mode ?? "signedOut"].default === "hang";
    await page.goto(`${base}${url}`, { waitUntil: hanging ? "load" : "networkidle" });
    if (hanging) await page.waitForTimeout(600);
    // Fonts: wait for Inter so the screenshots show the shipped type.
    await page.evaluate(() => document.fonts.ready);
    if (act) await act(page);
    // A full-page shot is stitched; a sticky top bar photographed mid-scroll
    // shows up in the middle of the stitch. Start from the top.
    if (!keepScroll) await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const file = path.join(outDir, `${name}.${viewport}.png`);
    await page.screenshot({ path: file, fullPage });
    const width = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    const overflow = width.doc > width.win ? `horizontal overflow: document ${width.doc}px > viewport ${width.win}px` : null;
    const record = { name, viewport, file: path.relative(repoRoot, file), url: page.url().replace(base, ""), errors: errors.filter((e) => !/qa-fixture\.invalid|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(e)), overflow };
    if (record.errors.length || overflow) problems.push(record);
    shots.push(record);
    console.log(`${record.overflow ? "!! " : record.errors.length ? "?? " : "   "}${record.file}${overflow ? `  ${overflow}` : ""}${record.errors.length ? `  console: ${record.errors.join(" | ")}` : ""}`);
    await ctx.close();
  }

  // Wizard helpers. Steps are 0-based: About, Education, Work auth, Resume, Preferences, Review.
  const toStep = (n, fillRequired = true) => async (page) => {
    for (let i = 0; i < n; i += 1) {
      if (fillRequired && i === 0) {
        const name = page.getByLabel(/full name/i);
        if ((await name.inputValue()) === "") await name.fill("Maya Okafor");
      }
      if (fillRequired && i === 1) {
        const school = page.getByLabel(/^school/i);
        if ((await school.inputValue()) === "") await school.fill("University of Pittsburgh");
      }
      await page.getByRole("button", { name: /^next/ }).click();
    }
  };

  for (const viewport of Object.keys(VIEWPORTS)) {
    // ── signed out ──
    await scene("01-landing", { viewport, url: "/" });
    await scene("01-landing.dark", { viewport, url: "/", theme: "dark" });
    await scene("02-signup", { viewport, url: "/signup" });
    await scene("03-redeem-prefilled", { viewport, url: "/redeem?code=JRA-7K2M-9QXF" });
    await scene("04-signup-sent", {
      viewport, url: "/redeem?code=JRA-7K2M-9QXF", mode: "otpOk",
      act: async (page) => { await page.getByLabel(/email/i).fill("maya@pitt.edu"); await page.getByRole("button", { name: /sign-in link/i }).click(); await page.getByText(/check your email/i).waitFor(); },
    });
    await scene("05-signup-error", {
      viewport, url: "/signup", mode: "otpRateLimited",
      act: async (page) => { await page.getByLabel(/email/i).fill("maya@pitt.edu"); await page.getByRole("button", { name: /sign-in link/i }).click(); await page.locator(".banner.danger").waitFor(); },
    });
    await scene("06-dashboard-signed-out-redirect", { viewport, url: "/dashboard" });
    await scene("07-not-found", { viewport, url: "/nowhere" });
    // The "08-waitlist-*" scenes were retired with open signup
    // (20260911000100): the landing no longer has a waitlist form, it has
    // the free-quota CTA, which "01-landing" already captures.

    // ── signed in, fresh (invite just redeemed, blank profile) ──
    await scene("10-signup-signed-in", { viewport, url: "/signup", session: true, mode: "freshUser" });
    await scene("11-onboarding-1-about-invite-applied", { viewport, url: "/onboarding", session: true, mode: "freshUser", invite: "JRA-7K2M-9QXF" });
    await scene("11-onboarding-1-validation", { viewport, url: "/onboarding", session: true, mode: "freshUser", act: async (page) => { await page.getByRole("button", { name: /^next/ }).click(); await page.locator(".banner.warn").waitFor(); } });
    await scene("11-onboarding-invite-failed", { viewport, url: "/onboarding", session: true, mode: "inviteFailed", invite: "JRA-7K2M-9QXF" });
    await scene("11-onboarding-invite-own", { viewport, url: "/onboarding", session: true, mode: "inviteOwn", invite: "JRA-9C3T-HX5D", fullPage: false });
    await scene("11-onboarding-invite-already-member", { viewport, url: "/onboarding", session: true, mode: "inviteMember", invite: "JRA-7K2M-9QXF", fullPage: false });
    await scene("12-onboarding-2-education", { viewport, url: "/onboarding", session: true, mode: "freshUser", act: toStep(1) });
    await scene("13-onboarding-3-workauth", { viewport, url: "/onboarding", session: true, mode: "freshUser", act: toStep(2) });
    await scene("13-onboarding-3-workauth-chosen", {
      viewport, url: "/onboarding", session: true, mode: "freshUser",
      act: async (page) => { await toStep(2)(page); await page.getByLabel(/U\.S\. citizen/).check(); await page.getByLabel(/^No$/).check(); },
    });
    await scene("14-onboarding-4-resume", { viewport, url: "/onboarding", session: true, mode: "freshUser", act: toStep(3) });
    await scene("15-onboarding-5-preferences", { viewport, url: "/onboarding", session: true, mode: "freshUser", act: toStep(4) });
    await scene("16-onboarding-6-review-blank", { viewport, url: "/onboarding", session: true, mode: "freshUser", act: toStep(5) });
    await scene("16-onboarding-6-review-filled", { viewport, url: "/onboarding", session: true, mode: "returningUser", act: toStep(5, false) });
    await scene("17-onboarding-load-error", { viewport, url: "/onboarding", session: true, mode: "serviceDown" });
    await scene("17-onboarding-loading", { viewport, url: "/onboarding", session: true, mode: "serviceHang", fullPage: false });

    // ── dashboard ──
    await scene("20-dashboard-empty", { viewport, url: "/dashboard", session: true, mode: "freshUser" });
    await scene("21-dashboard-populated", { viewport, url: "/dashboard", session: true, mode: "returningUser" });
    await scene("21-dashboard-populated.dark", { viewport, url: "/dashboard", session: true, mode: "returningUser", theme: "dark" });
    await scene("22-dashboard-quota-low", { viewport, url: "/dashboard", session: true, mode: "lowQuota", fullPage: false });
    await scene("22-dashboard-quota-exhausted", { viewport, url: "/dashboard", session: true, mode: "exhausted" });
    await scene("22-dashboard-quota-bonus", {
      viewport, url: "/dashboard", session: true, mode: "quotaBonus", fullPage: false,
      act: async (page) => { await page.locator(".quota-bonus").waitFor(); },
    });

    // ── invite-a-friend panel: 0 / 1 / mixed / capped codes, mint, not a member, view down ──
    const atInvite = (ready) => async (page) => { await page.locator(ready).first().waitFor(); await page.locator("#invite").scrollIntoViewIfNeeded(); };
    await scene("24-invite-panel-none", { viewport, url: "/dashboard", session: true, mode: "referralNone", fullPage: false, keepScroll: true, act: atInvite("#invite .empty-state") });
    await scene("24-invite-panel-one", { viewport, url: "/dashboard", session: true, mode: "returningUser", fullPage: false, keepScroll: true, act: atInvite("#invite .code-list code") });
    await scene("24-invite-panel-mixed", { viewport, url: "/dashboard", session: true, mode: "referralMixed", fullPage: false, keepScroll: true, act: atInvite("#invite .code-list code") });
    await scene("24-invite-panel-capped", { viewport, url: "/dashboard", session: true, mode: "referralCapped", fullPage: false, keepScroll: true, act: atInvite("#mint-blocked-reason") });
    await scene("24-invite-panel-minted", {
      viewport, url: "/dashboard", session: true, mode: "referralNone", fullPage: false, keepScroll: true,
      act: async (page) => { await page.locator("#invite .empty-state").waitFor(); await page.getByRole("button", { name: /mint a code/i }).click(); await page.locator("#invite .code-list code").waitFor(); await page.locator("#invite").scrollIntoViewIfNeeded(); },
    });
    await scene("24-invite-panel-not-member", { viewport, url: "/dashboard", session: true, mode: "freshUser", fullPage: false, keepScroll: true, act: atInvite("#mint-blocked-reason") });
    await scene("24-invite-panel-view-down", { viewport, url: "/dashboard", session: true, mode: "referralViewDown", fullPage: false, keepScroll: true, act: atInvite("#invite .empty-state") });
    await scene("24-invite-panel-bonus", { viewport, url: "/dashboard", session: true, mode: "quotaBonus", fullPage: false, keepScroll: true, act: atInvite("#invite .referral-bonus-line") });

    // ── engine heartbeat: not connected / running / running-push-failed / offline ──
    const atEngine = async (page) => { await page.locator(".engine-line").waitFor(); await page.locator(".engine-line").scrollIntoViewIfNeeded(); };
    await scene("25-engine-not-connected", { viewport, url: "/dashboard", session: true, mode: "returningUser", fullPage: false, keepScroll: true, act: atEngine });
    await scene("25-engine-running", { viewport, url: "/dashboard", session: true, mode: "engineRunning", fullPage: false, keepScroll: true, act: atEngine });
    await scene("25-engine-push-failed", { viewport, url: "/dashboard", session: true, mode: "enginePushFailed", fullPage: false, keepScroll: true, act: atEngine });
    await scene("25-engine-offline", { viewport, url: "/dashboard", session: true, mode: "engineOffline", fullPage: false, keepScroll: true, act: atEngine });
    await scene("23-dashboard-error", { viewport, url: "/dashboard", session: true, mode: "serviceDown" });
    await scene("23-dashboard-loading", { viewport, url: "/dashboard", session: true, mode: "serviceHang", fullPage: false });

    // ── keyboard: where does focus go, in order? ──
    await scene("30-landing-focus-order", {
      viewport, url: "/", fullPage: false,
      act: async (page) => {
        const order = [];
        for (let i = 0; i < 12; i += 1) {
          await page.keyboard.press("Tab");
          order.push(await page.evaluate(() => { const el = document.activeElement; return el ? `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ").filter(Boolean).join(".") : ""}:"${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40)}"` : "none"; }));
        }
        fs.writeFileSync(path.join(outDir, `30-landing-focus-order.${viewport}.txt`), order.join("\n"));
      },
    });
  }

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), shots, problems }, null, 2));
  await browser.close();
  server.close();
  console.log(`\n${shots.length} screenshots in ${path.relative(repoRoot, outDir)}; ${problems.length} with console errors or overflow`);
}

main().catch((err) => { console.error(err); process.exit(1); });
