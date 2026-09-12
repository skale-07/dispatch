import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * design/tokens.json is the machine-readable mirror of the CSS custom
 * properties in frontend/src/styles/tokens.css (which the running UI
 * consumes and which stays authoritative). A design schema that can drift
 * from the shipped UI is decoration — this test makes the mirror a
 * contract. UNIT_CONFIRMED.
 *
 * LIGHT is the default theme, so it lives in :root; dark is applied by the
 * OS preference and by the explicit toggle, which means the dark palette
 * is necessarily written twice (CSS cannot share a declaration block
 * across a media boundary). The two copies are asserted identical here so
 * that duplication can never become drift.
 */

const CSS_PATH = path.join(process.cwd(), "frontend", "src", "styles", "tokens.css");
const JSON_PATH = path.join(process.cwd(), "design", "tokens.json");

type TokenLeaf = { $type: string; $value: string | string[] };
type TokenGroup = { [key: string]: TokenLeaf | TokenGroup | string };

function parseVars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    out[m[1]!] = m[2]!.replace(/\s+/g, " ").trim();
  }
  return out;
}

function blockAfter(css: string, selectorPattern: RegExp): string {
  const m = css.match(selectorPattern);
  expect(m, `block ${selectorPattern} present in tokens.css`).toBeTruthy();
  return m![1]!;
}

/**
 * :root carries the default (light) palette plus every non-color scale;
 * the dark palette appears in both the media query and the explicit
 * toggle block.
 */
function readCssPalettes(): {
  light: Record<string, string>;
  dark: Record<string, string>;
  darkMedia: Record<string, string>;
} {
  const css = fs.readFileSync(CSS_PATH, "utf8");
  return {
    light: parseVars(blockAfter(css, /:root\s*\{([\s\S]*?)\}/)),
    dark: parseVars(blockAfter(css, /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/)),
    darkMedia: parseVars(
      blockAfter(css, /:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\}/),
    ),
  };
}

function readJsonTokens(): TokenGroup {
  return JSON.parse(fs.readFileSync(JSON_PATH, "utf8")) as TokenGroup;
}

function leaf(group: TokenGroup, ...keys: string[]): TokenLeaf {
  let cur: TokenLeaf | TokenGroup | string = group;
  for (const k of keys) {
    expect(typeof cur, `group at ${keys.join(".")}`).toBe("object");
    cur = (cur as TokenGroup)[k]!;
    expect(cur, `token ${keys.join(".")}`).toBeTruthy();
  }
  return cur as TokenLeaf;
}

describe("design/tokens.json ↔ tokens.css contract (UNIT_CONFIRMED)", () => {
  const css = readCssPalettes();
  const json = readJsonTokens();

  it("every color token in the schema matches the CSS palette, both themes", () => {
    const colors = leaf(json, "color") as unknown as {
      dark: Record<string, TokenLeaf>;
      light: Record<string, TokenLeaf>;
    };
    for (const theme of ["dark", "light"] as const) {
      for (const [name, token] of Object.entries(colors[theme])) {
        expect(
          css[theme][name],
          `--${name} exists in the CSS ${theme} palette`,
        ).toBeDefined();
        expect(
          css[theme][name]!.toLowerCase(),
          `--${name} (${theme})`,
        ).toBe((token.$value as string).toLowerCase());
      }
    }
  });

  it("the CSS palettes carry no color the schema doesn't document", () => {
    const colors = leaf(json, "color") as unknown as {
      dark: Record<string, TokenLeaf>;
    };
    const documented = new Set(Object.keys(colors.dark));
    for (const theme of ["light", "dark"] as const) {
      const cssColorNames = Object.keys(css[theme]).filter(
        (n) => /^#|rgba?\(/.test(css[theme][n]!) && !n.endsWith("-dim"),
      );
      for (const name of cssColorNames) {
        // -dim companions are derived (alpha of the base) and shadows are
        // depth documented in their own group — everything else must be in
        // the color schema.
        if (name.startsWith("shadow")) continue;
        expect(
          documented.has(name),
          `--${name} (${theme}) documented in tokens.json`,
        ).toBe(true);
      }
    }
  });

  it("the two dark-palette copies are identical — duplication cannot become drift", () => {
    expect(css.darkMedia).toEqual(css.dark);
  });

  it("fonts, radii, layout, and shadows match", () => {
    expect(css.light["font-mono"]).toBe(leaf(json, "font", "mono").$value);
    expect(css.light["font-ui"]).toBe(leaf(json, "font", "ui").$value);
    expect(css.light["font-display"]).toBe(leaf(json, "font", "display").$value);
    expect(css.light["radius"]).toBe(leaf(json, "radius", "default").$value);
    expect(css.light["radius-sm"]).toBe(leaf(json, "radius", "sm").$value);
    expect(css.light["radius-lg"]).toBe(leaf(json, "radius", "lg").$value);
    expect(css.light["sidebar-w"]).toBe(leaf(json, "layout", "sidebar-width").$value);
    expect(css.light["breakpoint-compact"]).toBe(
      leaf(json, "layout", "breakpoint-compact").$value,
    );
    for (const theme of ["light", "dark"] as const) {
      expect(css[theme]["shadow-sm"]).toBe(leaf(json, "shadow", theme, "sm").$value);
      expect(css[theme]["shadow"]).toBe(leaf(json, "shadow", theme, "default").$value);
    }
  });

  it("the type scale is mirrored, and it is the only set of sizes", () => {
    const type = leaf(json, "type") as unknown as Record<string, TokenLeaf>;
    const names = Object.keys(type).filter((k) => !k.startsWith("$"));
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) {
      expect(css.light[`text-${name}`], `--text-${name} in tokens.css`).toBe(
        type[name]!.$value,
      );
    }
  });

  it("the spacing scale, motion tokens, and z-layers are mirrored", () => {
    const space = leaf(json, "space") as unknown as Record<string, TokenLeaf>;
    for (const name of Object.keys(space).filter((k) => !k.startsWith("$"))) {
      expect(css.light[`space-${name}`], `--space-${name}`).toBe(
        space[name]!.$value,
      );
    }
    expect(css.light["duration-fast"]).toBe(
      leaf(json, "motion", "duration-fast").$value,
    );
    expect(css.light["duration-base"]).toBe(
      leaf(json, "motion", "duration-base").$value,
    );
    expect(css.light["ease-out"]).toBe(leaf(json, "motion", "ease-out").$value);
    const layer = leaf(json, "layer") as unknown as Record<string, TokenLeaf>;
    for (const name of Object.keys(layer).filter((k) => !k.startsWith("$"))) {
      expect(css.light[`z-${name}`], `--z-${name}`).toBe(layer[name]!.$value);
    }
  });

  it("the compact layout exists and fires at the documented breakpoint", () => {
    // DESIGN.md §5 promised since the brand work that the sidebar
    // collapses to a top bar below ~960px. Nothing implemented it, and
    // nothing caught that the documentation was false. A media query
    // cannot read a custom property, so the literal in base.css is
    // checked against the token instead.
    const base = fs.readFileSync(
      path.join(process.cwd(), "frontend", "src", "styles", "base.css"),
      "utf8",
    );
    const breakpoint = css.light["breakpoint-compact"]!;
    expect(base).toMatch(
      new RegExp(`@media\\s*\\(max-width:\\s*${breakpoint}\\)`),
    );
    // The rule has to actually restack the shell, not merely exist.
    const block = base.match(
      new RegExp(`@media\\s*\\(max-width:\\s*${breakpoint}\\)\\s*\\{([\\s\\S]*?)\\n\\}`),
    )?.[1];
    expect(block, "compact block body").toBeTruthy();
    expect(block).toMatch(/\.shell\s*\{[^}]*flex-direction:\s*column/);
  });

  it("the Tailwind bridge maps ONLY onto real tokens (U2 — one system, not two)", () => {
    // frontend/src/styles/tailwind.css exposes Tailwind/shadcn theme
    // names as var() references into tokens.css. Every reference must
    // resolve to a declared token, and the stock palette must stay
    // wiped — an off-palette bg-blue-500 must not exist.
    const tw = fs.readFileSync(
      path.join(process.cwd(), "frontend", "src", "styles", "tailwind.css"),
      "utf8",
    );
    expect(tw).toContain("--color-*: initial");
    // No color is ever BORN in the bridge: every declaration is a var()
    // reference or a color-mix of them, so a literal hex/oklch/rgb here
    // would be a second palette starting.
    expect(tw).not.toMatch(/#[0-9a-fA-F]{3,8}\b|oklch\(|rgb\(/);
    // Every var() reference resolves — to a token, or to a derivation
    // declared in this same file (the chart vocabulary), whose own value
    // is itself covered by these two rules. The chain always ends in
    // tokens.css.
    const declared = new Set([
      ...Object.keys(css.light),
      ...[...tw.matchAll(/^\s*--([a-z0-9-]+):/gm)].map((m) => m[1]!),
    ]);
    const refs = [...tw.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThanOrEqual(20);
    for (const ref of refs) {
      expect(
        declared.has(ref),
        `--${ref} referenced by the bridge resolves to a token or an in-file derivation`,
      ).toBe(true);
    }
  });

  it("Motion's animation constants mirror the motion tokens (U1)", () => {
    // frontend/src/components/Animated.tsx is the one seam to the Motion
    // library; its durations/easing are written as literals (Motion takes
    // numbers, CSS takes strings), so the mirror is a contract like every
    // other token pairing in this file.
    const animated = fs.readFileSync(
      path.join(process.cwd(), "frontend", "src", "components", "Animated.tsx"),
      "utf8",
    );
    const num = (name: string): number =>
      Number(animated.match(new RegExp(`${name} = ([0-9.]+)`))?.[1]);
    const cssMs = (token: string): number =>
      Number(css.light[token]!.replace("ms", ""));
    expect(num("DURATION_FAST") * 1000).toBe(cssMs("duration-fast"));
    expect(num("DURATION_BASE") * 1000).toBe(cssMs("duration-base"));
    const ease = animated.match(/EASE_OUT[^=]*= \[([^\]]+)\]/)?.[1]
      ?.split(",")
      .map((s) => Number(s.trim()));
    expect(`cubic-bezier(${ease!.join(", ")})`).toBe(css.light["ease-out"]);
  });

  it("brand assets use palette colors only (favicon + every design/*.svg)", () => {
    const designDir = path.join(process.cwd(), "design");
    const assets = [
      path.join(process.cwd(), "frontend", "public", "favicon.svg"),
      ...fs
        .readdirSync(designDir)
        .filter((f) => f.endsWith(".svg"))
        .map((f) => path.join(designDir, f)),
    ];
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const palette = new Set(
      [...Object.values(css.dark), ...Object.values(css.light)].map((v) =>
        v.toLowerCase(),
      ),
    );
    for (const asset of assets) {
      const svg = fs.readFileSync(asset, "utf8");
      for (const m of svg.matchAll(/#[0-9a-f]{6}\b/gi)) {
        expect(
          palette.has(m[0]!.toLowerCase()),
          `${path.basename(asset)} color ${m[0]} is a palette color`,
        ).toBe(true);
      }
    }
  });

  it("the marketing site runs the console's system exactly — one system, two surfaces", () => {
    // site/dispatch.css re-declares everything as literals because it ships
    // with no build step, so the mirror is a contract rather than a
    // convention: both palettes and every shared scale must agree
    // value-for-value with tokens.css.
    const site = fs.readFileSync(
      path.join(process.cwd(), "site", "dispatch.css"),
      "utf8",
    );
    const siteLight = parseVars(blockAfter(site, /:root\s*\{([\s\S]*?)\}/));
    const siteDark = parseVars(
      blockAfter(site, /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/),
    );
    const siteDarkMedia = parseVars(
      blockAfter(site, /:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\}/),
    );
    expect(siteDarkMedia, "the site's two dark copies are identical").toEqual(
      siteDark,
    );

    for (const [theme, siteVars] of [
      ["light", siteLight],
      ["dark", siteDark],
    ] as const) {
      for (const [name, value] of Object.entries(siteVars)) {
        const consoleValue = css[theme][name];
        if (consoleValue === undefined) continue; // site-only layout var
        expect(
          value.toLowerCase().replace(/\s+/g, " "),
          `site/dispatch.css --${name} (${theme}) matches tokens.css`,
        ).toBe(consoleValue.toLowerCase().replace(/\s+/g, " "));
      }
    }

    // The site must not invent a font size outside the shared scale — the
    // exact drift that made the console's own scale documentation false.
    const sizes = [...site.matchAll(/font-size:\s*([^;]+);/g)].map((m) =>
      m[1]!.trim(),
    );
    const strays = sizes.filter(
      (v) =>
        !v.startsWith("var(--text-") &&
        // The rem anchor on <body>, the fluid hero, and SVG drawing units
        // are layout decisions, not scale steps.
        !["16px", "12px", "10px"].includes(v) &&
        !v.startsWith("clamp("),
    );
    expect(strays, "site font sizes come from the shared type scale").toEqual([]);
  });

  it("the read-only dashboard carries the palette too — no unbranded surface", () => {
    // src/dashboard/server.ts ships its page as a string inside the server
    // and cannot import tokens.css, so it writes the palette out literally.
    const server = fs.readFileSync(
      path.join(process.cwd(), "src", "dashboard", "server.ts"),
      "utf8",
    );
    const html = server.slice(
      server.indexOf("const INDEX_HTML"),
      server.indexOf("</html>`;"),
    );
    expect(html).toContain("prefers-color-scheme: dark");
    const palette = new Set(
      [...Object.values(css.dark), ...Object.values(css.light)].map((v) =>
        v.toLowerCase(),
      ),
    );
    const hexes = [...html.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0]!);
    expect(hexes.length).toBeGreaterThanOrEqual(8);
    for (const hex of hexes) {
      expect(
        palette.has(hex.toLowerCase()),
        `dashboard color ${hex} is a palette color`,
      ).toBe(true);
    }
  });
});

/**
 * CLAUDE.md "Frontend aesthetics" (2026-09-11) as executable rules: the
 * three faces and nothing generic, weight at its extremes, display sizes
 * that jump, motion tokens for one reveal, and a palette whose legibility
 * is computed rather than eyeballed. UNIT_CONFIRMED.
 */
describe("frontend aesthetics rules are enforced by the tokens (UNIT_CONFIRMED)", () => {
  const css = readCssPalettes();
  const json = readJsonTokens();
  const read = (...p: string[]): string => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");

  /** Families CLAUDE.md bans, plus the system stacks that smuggle them in. */
  const BANNED_FAMILY =
    /\b(Inter|Roboto|Open Sans|Lato|Arial|Helvetica|system-ui|-apple-system|BlinkMacSystemFont|Segoe UI)\b/;

  it("the three faces are the only families named, and the display face exists", () => {
    for (const token of ["font-ui", "font-display", "font-mono"]) {
      expect(css.light[token], `--${token}`).toBeDefined();
      expect(css.light[token], `--${token} names no banned family`).not.toMatch(BANNED_FAMILY);
    }
    expect(css.light["font-ui"]).toContain("Bricolage Grotesque");
    expect(css.light["font-display"]).toContain("Fraunces");
    expect(css.light["font-mono"]).toContain("JetBrains Mono");
  });

  it("no surface names a banned family — bridge, site, dashboard, or the site's font links", () => {
    const families = (text: string): string[] =>
      [...text.matchAll(/(?:font-family|--font-[a-z]+):\s*([^;]+);/g)].map((m) => m[1]!);
    for (const file of [
      ["frontend", "src", "styles", "tailwind.css"],
      ["frontend", "src", "styles", "base.css"],
      ["site", "dispatch.css"],
      ["src", "dashboard", "server.ts"],
    ]) {
      for (const fam of families(read(...file))) {
        expect(fam, `${file.join("/")}: ${fam}`).not.toMatch(BANNED_FAMILY);
      }
    }
    for (const page of ["index.html", "pricing.html"]) {
      const html = read("site", page);
      const link = html.match(/fonts\.googleapis\.com\/css2\?([^"]+)"/)?.[1] ?? "";
      expect(link, `${page} links Google Fonts`).not.toBe("");
      expect(link).toContain("Bricolage+Grotesque");
      expect(link).toContain("Fraunces");
      expect(link).toContain("JetBrains+Mono");
      expect(link).not.toMatch(/family=Inter\b/);
    }
  });

  it("the faces are self-hosted: main.tsx imports all three fontsource packages and not Inter", () => {
    const main = read("frontend", "src", "main.tsx");
    for (const pkg of ["bricolage-grotesque", "fraunces", "jetbrains-mono"]) {
      expect(main, pkg).toMatch(new RegExp(`import "@fontsource-variable/${pkg}`));
    }
    expect(main).not.toContain("@fontsource-variable/inter");
    const pkgJson = JSON.parse(read("frontend", "package.json")) as { dependencies: Record<string, string> };
    for (const pkg of ["bricolage-grotesque", "fraunces", "jetbrains-mono"]) {
      expect(pkgJson.dependencies[`@fontsource-variable/${pkg}`], pkg).toBeDefined();
    }
    expect(pkgJson.dependencies["@fontsource-variable/inter"]).toBeUndefined();
  });

  it("weight lives at its extremes — 200 / 400 / 800 — and no stylesheet writes a numeric weight", () => {
    expect(css.light["weight-light"]).toBe("200");
    expect(css.light["weight-regular"]).toBe("400");
    expect(css.light["weight-heavy"]).toBe("800");
    for (const name of ["light", "regular", "heavy"]) {
      expect(css.light[`weight-${name}`]).toBe(leaf(json, "weight", name).$value);
    }
    for (const file of [
      ["frontend", "src", "styles", "base.css"],
      ["site", "dispatch.css"],
    ]) {
      const literals = [...read(...file).matchAll(/font-weight:\s*(\d+)/g)].map((m) => m[1]!);
      expect(literals, `${file.join("/")} numeric font-weight literals`).toEqual([]);
    }
    // The Tailwind bridge exposes ONLY those three and wipes the stock nine.
    const tw = read("frontend", "src", "styles", "tailwind.css");
    expect(tw).toContain("--font-weight-*: initial");
    expect(tw).toContain("--font-*: initial");
    expect(tw).toMatch(/--font-sans: var\(--font-ui\)/);
    expect(tw).toMatch(/--font-display: var\(--font-display\)/);
    expect(tw).toMatch(/--font-mono: var\(--font-mono\)/);
  });

  it("display sizes jump: the hero rung is at least 3× body", () => {
    const rem = (token: string): number => Number(css.light[token]!.replace("rem", ""));
    expect(rem("text-5xl") / rem("text-base")).toBeGreaterThanOrEqual(3);
    expect(rem("text-4xl") / rem("text-base")).toBeGreaterThanOrEqual(3);
    expect(rem("text-5xl")).toBeGreaterThan(rem("text-4xl"));
  });

  it("the reveal's motion tokens exist and Animated.tsx mirrors them", () => {
    expect(css.light["duration-slow"]).toBe(leaf(json, "motion", "duration-slow").$value);
    expect(css.light["stagger"]).toBe(leaf(json, "motion", "stagger").$value);
    const animated = read("frontend", "src", "components", "Animated.tsx");
    const num = (name: string): number => Number(animated.match(new RegExp(`${name} = ([0-9.]+)`))?.[1]);
    const cssMs = (token: string): number => Number(css.light[token]!.replace("ms", ""));
    expect(Math.round(num("DURATION_SLOW") * 1000)).toBe(cssMs("duration-slow"));
    expect(Math.round(num("STAGGER") * 1000)).toBe(cssMs("stagger"));
  });

  it("every text and signal color clears WCAG AA on both grounds, in both themes — computed", () => {
    const luminance = (hex: string): number => {
      const c = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const contrast = (a: string, b: string): number => {
      const [x, y] = [luminance(a), luminance(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    for (const theme of ["light", "dark"] as const) {
      const p = css[theme];
      for (const ground of ["bg", "bg-raised"]) {
        for (const fg of ["text", "text-dim", "accent", "ok", "warn", "danger", "purple"]) {
          expect(
            contrast(p[fg]!, p[ground]!),
            `${theme}: --${fg} on --${ground} ≥ 4.5`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(p["text-faint"]!, p[ground]!), `${theme}: --text-faint on --${ground} ≥ 3`)
          .toBeGreaterThanOrEqual(3);
      }
      // Primary button: raised surface as text on the accent fill.
      expect(contrast(p["bg-raised"]!, p["accent"]!), `${theme}: button text ≥ 4.5`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it("one accent, and never a purple-to-blue gradient", () => {
    for (const file of [
      ["frontend", "src", "styles", "tokens.css"],
      ["frontend", "src", "styles", "base.css"],
      ["frontend", "src", "styles", "tailwind.css"],
      ["site", "dispatch.css"],
    ]) {
      const text = read(...file);
      for (const m of text.matchAll(/gradient\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) {
        const body = m[1]!;
        expect(
          body.includes("--purple") && body.includes("--accent"),
          `${file.join("/")}: gradient mixes --purple and --accent`,
        ).toBe(false);
      }
    }
  });

  it("each theme declares its color-scheme so native controls follow the palette", () => {
    const tokens = read("frontend", "src", "styles", "tokens.css");
    expect(tokens).toMatch(/:root\s*\{\s*color-scheme: light;/);
    expect(tokens).toMatch(/:root:not\(\[data-theme="light"\]\)\s*\{\s*color-scheme: dark;/);
    expect(tokens).toMatch(/:root\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/);
  });
});
