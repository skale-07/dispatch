// Renders frontend/public/og.png (1200×630) — the social preview card —
// from an inline HTML page that uses only palette colors from
// frontend/src/styles/tokens.css (dark theme: --bg, --bg-raised, --text,
// --text-dim, --accent, --border). Deterministic; re-run after a palette
// change. Usage: node frontend/tests/og-image.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "..", "public", "og.png");

const P = {
  bg: "#0e0f14",
  raised: "#16171e",
  text: "#ece9e1",
  dim: "#a3a099",
  accent: "#6d7dff",
  border: "#2b2c36",
  ok: "#4cc46a",
};

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1200px;height:630px;background:${P.bg};
    font-family:"Bricolage Grotesque",ui-sans-serif,sans-serif;color:${P.text}}
  .wrap{position:relative;width:1200px;height:630px;padding:72px 80px;box-sizing:border-box}
  .brand{display:flex;align-items:center;gap:16px;font-family:"JetBrains Mono",ui-monospace,monospace;
    font-size:28px;font-weight:800;letter-spacing:.02em}
  h1{font-size:64px;line-height:1.08;margin:56px 0 24px;font-weight:800;letter-spacing:-.01em;max-width:900px}
  p{font-size:28px;line-height:1.35;color:${P.dim};margin:0;max-width:860px}
  .receipt{position:absolute;right:80px;bottom:72px;background:${P.raised};border:1px solid ${P.border};
    border-radius:14px;padding:22px 26px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:20px;color:${P.dim}}
  .receipt b{color:${P.ok};font-weight:800}
  .foot{position:absolute;left:80px;bottom:72px;font-size:22px;color:${P.dim}}
</style></head><body><div class="wrap">
  <div class="brand">
    <svg width="40" height="40" viewBox="0 0 24 24"><path d="M6 18 L18 6" stroke="${P.accent}" stroke-width="2" stroke-linecap="round" fill="none"/><circle cx="6" cy="18" r="2.4" fill="${P.bg}" stroke="${P.accent}" stroke-width="2"/><circle cx="12" cy="12" r="2.4" fill="${P.bg}" stroke="${P.accent}" stroke-width="2"/><circle cx="18" cy="6" r="3" fill="${P.accent}"/></svg>
    dispatch
  </div>
  <h1>Applying to jobs is a part-time job. Give it to an agent.</h1>
  <p>It fills the forms on real employer sites while you're in class — and keeps a screenshot receipt for every one.</p>
  <div class="receipt"><b>✓ submitted</b> · receipt stored<br>screenshot · confirmation text</div>
  <div class="foot">invite-only · receipts for everything</div>
</div></body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: OUT, type: "png" });
  console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes)`);
} finally {
  await browser.close();
}
