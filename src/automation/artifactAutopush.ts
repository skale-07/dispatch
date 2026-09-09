import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/** An index.lock older than this with no git behind it is a leftover (#215). */
const STALE_INDEX_LOCK_MS = 5 * 60_000;

const exec = promisify(execFile);

/**
 * Stage-1 self-improvement loop, courier leg: after an armed session ends,
 * commit and push the session's artifacts so the analysis agent sees them
 * without the operator hand-carrying a git push. Everything here is
 * bounded and fail-open — a git problem becomes a named note in the
 * session report, never a session failure.
 *
 * Safety posture:
 *   - Gated by ARTIFACT_AUTOPUSH_ENABLED (fail closed, like every
 *     mutation capability).
 *   - Stages ONLY artifacts/ — code, config, and private/ are never
 *     touched by this path (private/ is gitignored besides).
 *   - The operator's pre-commit hook (check:secrets) runs normally:
 *     --no-verify is NEVER passed, so the existing secret gate is the
 *     final arbiter of what leaves the machine. A hook refusal aborts
 *     the push loudly instead of bypassing it.
 *   - Pushes to the CURRENT branch only; two retries with backoff.
 */
export type ArtifactAutopushReport = {
  pushed: boolean;
  commit: string | null;
  files_staged: number;
  notes: string[];
};

const GIT_TIMEOUT_MS = 60_000;

export async function autopushArtifacts(input: {
  armRunId: string;
  /** Repo root override (tests use a temp repo). */
  cwd?: string;
  /** Commit message override (still artifact-only staging either way). */
  message?: string;
}): Promise<ArtifactAutopushReport> {
  const cwd = input.cwd ?? process.cwd();
  const report: ArtifactAutopushReport = {
    pushed: false,
    commit: null,
    files_staged: 0,
    notes: [],
  };
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
    return stdout.trim();
  };

  try {
    // #215 (day28): three times in one evening an `index.lock` outlived the
    // git that made it (5 MB index, cycles a minute apart), and every later
    // push — and the operator's own commits — failed on "File exists".
    // A real git operation never holds the lock for minutes; one that old
    // with nothing writing it is a leftover, and clearing it is what the
    // operator would do by hand. Logged as a note either way.
    const lockPath = path.join(cwd, ".git", "index.lock");
    try {
      const stat = fs.statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > STALE_INDEX_LOCK_MS) {
        fs.unlinkSync(lockPath);
        report.notes.push(
          `artifact autopush: removed a stale .git/index.lock (${Math.round(ageMs / 60_000)} min old, nothing writing it)`,
        );
      } else {
        report.notes.push(
          `artifact autopush: .git/index.lock held by a live git (${Math.round(ageMs / 1000)}s old) — skipping this push`,
        );
        return report;
      }
    } catch {
      // no lock — the normal case
    }
    await git("add", "-A", "--", "artifacts");
    const staged = await git("diff", "--cached", "--name-only");
    const files = staged.split("\n").filter((l) => l.trim() !== "");
    report.files_staged = files.length;
    if (files.length === 0) {
      report.notes.push("artifact autopush: nothing new to push");
      return report;
    }
    // Anything staged outside artifacts/ means the working tree carried
    // unrelated staged changes — refuse rather than sweep them along.
    const stray = files.filter((f) => !f.startsWith("artifacts/"));
    if (stray.length > 0) {
      await git("reset", "--", ...stray.slice(0, 100));
      report.notes.push(
        `artifact autopush: unstaged ${stray.length} non-artifact file(s) that were already staged`,
      );
    }
    const stillStaged = (await git("diff", "--cached", "--name-only"))
      .split("\n")
      .filter((l) => l.trim() !== "");
    if (stillStaged.length === 0) {
      report.notes.push("artifact autopush: nothing artifact-only to push");
      return report;
    }

    // NO --no-verify: the operator's pre-commit secret gate stays the
    // final check on what leaves the machine.
    // #211 (day28 19:11 UTC): an operator `git add src/…` landed between
    // this function's stray check and its commit, and the "art:" commit
    // swept two source files along. A pathspec commit records ONLY the
    // artifacts tree whatever else the shared index holds.
    await git(
      "commit",
      "-m",
      input.message ??
        `art: automation session ${input.armRunId.slice(0, 8)} (autopush)`,
      "--",
      "artifacts",
    );
    report.commit = await git("rev-parse", "--short", "HEAD");

    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    let lastErr: unknown = null;
    for (const delayMs of [0, 2_000, 4_000]) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      try {
        await git("push", "origin", branch);
        report.pushed = true;
        report.notes.push(
          `artifact autopush: ${stillStaged.length} file(s) pushed to ${branch} as ${report.commit}`,
        );
        return report;
      } catch (err) {
        lastErr = err;
      }
    }
    report.notes.push(
      `artifact autopush: commit ${report.commit} created but push failed after retries: ${
        lastErr instanceof Error ? lastErr.message.slice(0, 160) : String(lastErr)
      }`,
    );
    return report;
  } catch (err) {
    report.notes.push(
      `artifact autopush failed (session unaffected): ${
        err instanceof Error ? err.message.slice(0, 200) : String(err)
      }`,
    );
    return report;
  }
}
