import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Hygiene for the public surface (CLAUDE.md "Frontend aesthetics" +
 * "Components"): Tailwind classes only, tokens only, one seam for each
 * third-party library. Applies to the route-owned code under
 * frontend/src/public/** and the composites under
 * frontend/src/components/public/**. Vendored registry code
 * (components/{ui,charts,kokonutui}) is exempt — it is stamped
 * @ts-nocheck and restyled only where stock classes fight the tokens.
 * UNIT_CONFIRMED.
 */

const FRONTEND = path.join(process.cwd(), "frontend", "src");

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const PUBLIC_FILES = [
  ...walk(path.join(FRONTEND, "public")),
  ...walk(path.join(FRONTEND, "components", "public")),
];
const rel = (f: string): string => path.relative(process.cwd(), f).replace(/\\/g, "/");

/** Google's own logo colors are Google's, not ours — the one sanctioned literal. */
const BRAND_HEX_EXEMPT = /GoogleMark\.tsx$/;

describe("public surface hygiene (UNIT_CONFIRMED)", () => {
  it("covers both public trees and the composites exist", () => {
    expect(PUBLIC_FILES.length).toBeGreaterThanOrEqual(10);
    for (const name of [
      "PublicShell", "Eyebrow", "Display", "StatTile", "QuotaMeter", "PanelState",
      "LiveView", "LockedPanel", "FieldHint", "CopyButton", "Atmosphere",
    ]) {
      expect(
        fs.existsSync(path.join(FRONTEND, "components", "public", `${name}.tsx`)),
        name,
      ).toBe(true);
    }
  });

  it("no inline styles — Tailwind classes only", () => {
    for (const f of PUBLIC_FILES) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, `${rel(f)} uses style={{`).not.toMatch(/style=\{\{/);
    }
  });

  it("no arbitrary values, no color literals, no middle weights, no dark: variants", () => {
    for (const f of PUBLIC_FILES) {
      const src = fs.readFileSync(f, "utf8");
      const classNames = [...src.matchAll(/className=\{?["'`]([^"'`]*)["'`]/g)].map((m) => m[1]!);
      for (const cls of classNames) {
        // `w-[30rem]`, `text-[#123456]`, `mt-[3px]` — a value the scale does not have.
        expect(cls, `${rel(f)}: arbitrary value in "${cls}"`).not.toMatch(/\[[^\]]*\]/);
        // Weight lives at 200/400/800; the registry's middle does not exist here.
        expect(cls, `${rel(f)}: middle weight in "${cls}"`).not.toMatch(
          /\bfont-(thin|extralight|normal|medium|semibold|bold|extrabold|black)\b/,
        );
        // Theming is data-theme + tokens that flip; a dark: utility is a second theme.
        expect(cls, `${rel(f)}: dark: variant in "${cls}"`).not.toMatch(/\bdark:/);
      }
      if (!BRAND_HEX_EXEMPT.test(f)) {
        expect(src, `${rel(f)} carries a hex color`).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      }
    }
  });

  it("every iframe is titled and sandboxed", () => {
    for (const f of PUBLIC_FILES) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/<iframe\b([\s\S]*?)\/?>/g)) {
        const attrs = m[1]!;
        expect(attrs, `${rel(f)}: iframe title`).toMatch(/\btitle=\{?["'{]/);
        expect(attrs, `${rel(f)}: iframe sandbox`).toMatch(/\bsandbox=/);
      }
    }
  });

  it("third-party libraries enter through one seam each", () => {
    const all = walk(FRONTEND);
    for (const f of all) {
      const src = fs.readFileSync(f, "utf8");
      const r = rel(f);
      // shimmering-text.tsx is a KokonutUI registry component that
      // predates the kokonutui/ folder convention — vendor by origin.
      const vendor =
        /frontend\/src\/components\/(ui|charts|kokonutui)\//.test(r) ||
        r === "frontend/src/components/shimmering-text.tsx";
      if (/from "lucide-react"/.test(src)) {
        expect(r.startsWith("frontend/src/components/ui/"), `${r} imports lucide-react`).toBe(true);
      }
      if (/from "motion\/react"/.test(src) && !vendor) {
        expect(r, `${r} imports motion/react outside Animated.tsx`).toBe(
          "frontend/src/components/Animated.tsx",
        );
      }
      if (/from "next-themes"/.test(src)) {
        expect.fail(`${r} imports next-themes — this is a Vite app themed by data-theme`);
      }
    }
  });

  it("the console stylesheet rides in its own cascade layer below utilities", () => {
    const tw = fs.readFileSync(path.join(FRONTEND, "styles", "tailwind.css"), "utf8");
    expect(tw).toMatch(/@layer theme, base, console, components, utilities;/);
    expect(tw).toMatch(/@import "\.\/base\.css" layer\(console\);/);
    const main = fs.readFileSync(path.join(FRONTEND, "main.tsx"), "utf8");
    expect(main, "main.tsx must not import base.css unlayered").not.toMatch(
      /import "\.\/styles\/base\.css"/,
    );
    // Only the two documented breakpoints exist; the atmosphere utilities
    // are built from tokens, never a literal.
    expect(tw).toMatch(/--breakpoint-\*: initial;/);
    expect(tw).toMatch(/--breakpoint-sm: 640px;/);
    expect(tw).toMatch(/--breakpoint-lg: 960px;/);
    for (const util of ["bg-atmosphere", "bg-track-grid"]) {
      const body = new RegExp(`@utility ${util} \\{([\\s\\S]*?)\\n\\}`).exec(tw)?.[1] ?? "";
      expect(body, util).not.toBe("");
      expect(body, `${util} literal color`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|oklch\(|rgb\(/);
      expect(body, `${util} references tokens`).toMatch(/var\(--(accent|bg|border)/);
    }
  });

  it("the primitives are vendored, stamped, and restyled only where the tokens demand", () => {
    const ui = path.join(FRONTEND, "components", "ui");
    for (const name of [
      "button", "card", "dialog", "form", "input", "label", "select", "textarea",
      "radio-group", "checkbox", "progress", "badge", "tabs", "sheet", "sonner",
      "separator", "skeleton", "tooltip", "alert", "dropdown-menu", "table",
    ]) {
      const f = path.join(ui, `${name}.tsx`);
      expect(fs.existsSync(f), name).toBe(true);
      const src = fs.readFileSync(f, "utf8");
      expect(src.startsWith("// @ts-nocheck"), `${name} stamped by vendor-pragma`).toBe(true);
      expect(src, `${name} resolves the cn helper`).not.toMatch(/from "cn"/);
    }
    const button = fs.readFileSync(path.join(ui, "button.tsx"), "utf8");
    expect(button).toMatch(/font-heavy/);
    expect(button).toMatch(/min-h-11/);
    const badge = fs.readFileSync(path.join(ui, "badge.tsx"), "utf8");
    expect(badge).toMatch(/font-mono/);
    const input = fs.readFileSync(path.join(ui, "input.tsx"), "utf8");
    expect(input).toMatch(/min-h-11/);
    expect(input).toMatch(/text-base/);
  });
});
