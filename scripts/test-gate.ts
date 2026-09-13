#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { heavyTestFiles, needsHeavySuite } from "./testSplit.js";

/**
 * The commit gate's test step (CLAUDE.md "Verify gate").
 *
 *   npm run test:gate -- [--heavy auto|always|never] [--] [path ...]
 *
 * Runs the `fast` vitest project always. Runs the `heavy` project when the
 * change can reach the engine (scripts/testSplit.ts needsHeavySuite):
 * decided from the paths given — the same list you hand `git commit -- …`
 * — or, with none, from the working tree (unstaged + staged + untracked).
 * `--heavy always` forces it (nightly, release); `--heavy never` skips it
 * and SAYS SO in the output, so a log can never pass as a full gate.
 *
 * The heavy project must run solo on this box — never alongside a live
 * headed run — so the decision is printed before anything starts.
 */

type Mode = "auto" | "always" | "never";

function parseMode(v: string | undefined): Mode {
  if (v === "auto" || v === "always" || v === "never") return v;
  throw new Error(`--heavy expects auto|always|never, got ${String(v)}`);
}

function parseArgs(argv: string[]): { mode: Mode; paths: string[] } {
  let mode: Mode = "auto";
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a === "--heavy") {
      mode = parseMode(argv[i + 1]);
      i += 1;
    } else if (a.startsWith("--heavy=")) {
      mode = parseMode(a.slice("--heavy=".length));
    } else {
      paths.push(a);
    }
  }
  return { mode, paths };
}

function git(args: string[]): string[] {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
}

function workingTreePaths(): string[] {
  return [
    ...git(["diff", "--name-only", "HEAD"]),
    ...git(["diff", "--name-only", "--cached"]),
    ...git(["ls-files", "--others", "--exclude-standard"]),
  ];
}

function vitest(args: string[]): number {
  const r = spawnSync("npx", ["vitest", "run", ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return r.status ?? 1;
}

function runFast(): number {
  console.log(`\ntest-gate: vitest project "fast"`);
  return vitest(["--project", "fast"]);
}

/** Repo-relative posix paths of the files a JSON report marks failed. */
export function failedFilesFromReport(json: string, root: string): string[] {
  const report = JSON.parse(json) as { testResults?: Array<{ name?: string; status?: string }> };
  const rel = (abs: string): string => path.relative(root, abs).split(path.sep).join("/");
  return (report.testResults ?? [])
    .filter((t) => t.status !== "passed" && typeof t.name === "string")
    .map((t) => rel(t.name as string));
}

/**
 * The heavy project, with the house rule for its failures built in: the
 * Playwright-fixture files starve each other under file parallelism (a
 * solo run still shows 3–11 rotating timeouts), and the deciding evidence
 * is a SERIAL re-run of just the failed files. A file that fails both
 * times is real; one that passes serially was load.
 */
function runHeavy(): number {
  console.log(`\ntest-gate: vitest project "heavy"`);
  const report = path.join(os.tmpdir(), `test-gate-heavy-${process.pid}.json`);
  const first = vitest(["--project", "heavy", "--reporter=default", "--reporter=json", `--outputFile=${report}`]);
  if (first === 0) return 0;
  let failed: string[] = [];
  try {
    failed = failedFilesFromReport(fs.readFileSync(report, "utf8"), process.cwd());
  } catch {
    console.error("test-gate: heavy failed and the JSON report is unreadable — treating as a real failure");
    return first;
  } finally {
    fs.rmSync(report, { force: true });
  }
  if (failed.length === 0 || failed.length > 20) {
    console.error(`test-gate: heavy failed (${failed.length} files) — not re-running`);
    return first;
  }
  console.log(`\ntest-gate: ${failed.length} heavy file(s) failed; re-running them SERIALLY (the deciding evidence):\n  ${failed.join("\n  ")}`);
  const second = vitest(["--project", "heavy", "--no-file-parallelism", "--maxWorkers=1", ...failed]);
  if (second === 0) {
    console.log(`test-gate: the ${failed.length} file(s) passed serially — the first failures were load, not code.`);
    return 0;
  }
  console.error("test-gate: a heavy file failed twice — that is real.");
  return second;
}

const { mode, paths } = parseArgs(process.argv.slice(2));
const scope = paths.length > 0 ? paths : workingTreePaths();
const heavyFiles = heavyTestFiles();
const decision = needsHeavySuite(scope, heavyFiles);
const wantHeavy = mode === "always" ? true : mode === "never" ? false : decision.needed;

console.log(
  `test-gate: ${paths.length > 0 ? `${paths.length} committed path(s)` : `${scope.length} working-tree path(s)`}; ` +
    `heavy project ${wantHeavy ? "RUNS" : "skipped"} — ` +
    (mode === "auto" ? decision.because : `--heavy ${mode}`),
);
if (!wantHeavy) {
  console.log(`test-gate: NOTE fast project only (${heavyFiles.length} heavy files not run).`);
}

let status = runFast();
if (status === 0 && wantHeavy) status = runHeavy();
if (status !== 0) {
  console.error("test-gate: FAILED");
  process.exit(status);
}
console.log(`test-gate: ok (${wantHeavy ? "fast + heavy" : "fast only"})`);
