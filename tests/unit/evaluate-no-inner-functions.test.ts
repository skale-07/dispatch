import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #245b (live Barnes & Thornburg ashby 2026-09-10): three fills died with
 * `ReferenceError: __name is not defined`, and `diagnoseDisabledSubmit`
 * had been failing the same way SILENTLY for far longer — its caller
 * `.catch(...)`es into an empty diagnosis, so every disabled submit was
 * reported as "no code input, no invalid fields, no errors", which is
 * exactly the signal the emailed-verification-code recovery depends on.
 *
 * The live pipeline runs under **tsx**, whose esbuild keeps function names
 * by wrapping every named function in a `__name(...)` helper. That helper
 * lives in the Node module, not in the page — so a named function declared
 * INSIDE a `page.evaluate` / `locator.evaluate` callback compiles to code
 * the browser cannot run. Verified directly (private probe):
 *
 *   named arrow inside evaluate -> ReferenceError: __name is not defined
 *   the same logic inlined      -> OK
 *
 * Vitest compiles differently and does NOT reproduce it, which is why the
 * fixture tests passed while the live run failed. That is the whole reason
 * this guard is a source check rather than a behavioural one.
 *
 * The rule: inside an evaluate callback, inline the logic, or move the
 * whole body into a string expression (see requiredCompleteness's
 * SCAN_EXPRESSION and submitDiagnostics's DIAGNOSTIC_SCAN_EXPRESSION —
 * a string is never compiled, so it cannot be rewritten). Object-valued
 * consts (`const g = globalThis as …`) are fine; only FUNCTIONS get
 * wrapped.
 */
const SRC = path.join(process.cwd(), "src");

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

/**
 * Lines inside an `.evaluate(` / `.evaluateHandle(` callback. Depth is
 * counted from the `(` of the evaluate call itself, so the scan ends with
 * that call instead of running on into the rest of the file.
 */
function evaluateCallbackLines(
  source: string,
): Array<{ line: string; lineNo: number }> {
  const lines = source.split(/\r?\n/);
  const out: Array<{ line: string; lineNo: number }> = [];
  let depth = 0;
  let inside = false;
  for (const [i, raw] of lines.entries()) {
    let text = raw;
    if (!inside) {
      const m = /\.(?:evaluate|evaluateHandle|evaluateAll)\(/.exec(raw);
      if (!m) continue;
      inside = true;
      depth = 0;
      text = raw.slice(m.index + m[0].length - 1); // start at the "("
    }
    for (const ch of text) {
      if (ch === "{" || ch === "(" || ch === "[") depth += 1;
      if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    }
    out.push({ line: raw, lineNo: i + 1 });
    if (depth <= 0) inside = false;
  }
  return out;
}

/** `const f = (…) => …`, `const f = function …`, or `function f(…)`. */
const NAMED_FUNCTION =
  /^\s*(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|\w+)\s*(?::[^=]*)?=>)|^\s*(?:async\s+)?function\s+\w+\s*\(/;

describe("no named functions inside evaluate callbacks (#245b)", () => {
  it("keeps every evaluate callback free of the tsx __name trap", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const source = fs.readFileSync(file, "utf8");
      if (!/\.(?:evaluate|evaluateHandle|evaluateAll)\(/.test(source)) continue;
      for (const { line, lineNo } of evaluateCallbackLines(source)) {
        if (NAMED_FUNCTION.test(line)) {
          offenders.push(
            `${path.relative(process.cwd(), file).replace(/\\/g, "/")}:${lineNo}  ${line.trim().slice(0, 90)}`,
          );
        }
      }
    }
    expect(
      offenders,
      "A named function inside an evaluate callback compiles to `__name(...)` under tsx and\n" +
        "throws ReferenceError in the page. Inline it, or move the body into a string expression.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("the scanner actually finds the shape it is guarding against", () => {
    const sample = [
      "await page.evaluate(() => {",
      "  const clean = (t: string): string => t.trim();",
      "  return clean(' x ');",
      "});",
      "const unrelated = (a: string): string => a;",
    ].join("\n");
    const flagged = evaluateCallbackLines(sample).filter((l) =>
      NAMED_FUNCTION.test(l.line),
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.line).toContain("const clean");
  });
});
