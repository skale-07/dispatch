import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authBudgetExhausted,
  clearAuthFailures,
  recordAuthFailure,
} from "../../src/verification/authAttemptBudget.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * #93: per-host auth budget — 3 failed/silent attempts in 6h cools the
 * host down instead of hammering it into a bot flag (live tiaa: ~35
 * attempts across two nights). UNIT_CONFIRMED on a temp ledger.
 */
describe("auth attempt budget (#93, UNIT_CONFIRMED)", () => {
  let privDir: string;
  const savedPriv = process.env.PRIVATE_DIR;

  beforeEach(() => {
    privDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-authbudget-"));
    process.env.PRIVATE_DIR = privDir;
    resetConfigCache();
  });
  afterEach(() => {
    if (savedPriv === undefined) delete process.env.PRIVATE_DIR;
    else process.env.PRIVATE_DIR = savedPriv;
    fs.rmSync(privDir, { recursive: true, force: true });
    resetConfigCache();
  });

  it("three failures in the window exhaust the budget; the message names the cool-down", () => {
    const host = "tenant.wd1.myworkdayjobs.com";
    expect(authBudgetExhausted(host)).toBeNull();
    recordAuthFailure(host);
    recordAuthFailure(host);
    expect(authBudgetExhausted(host)).toBeNull();
    recordAuthFailure(host);
    const msg = authBudgetExhausted(host);
    expect(msg).toContain("budget exhausted");
    expect(msg).toContain("3 failed/silent");
    expect(msg).toContain("manual operator sign-in");
  });

  it("a success clears the ledger; stale failures age out of the 6h window", () => {
    const host = "tenant.wd1.myworkdayjobs.com";
    recordAuthFailure(host);
    recordAuthFailure(host);
    recordAuthFailure(host);
    expect(authBudgetExhausted(host)).not.toBeNull();
    clearAuthFailures(host);
    expect(authBudgetExhausted(host)).toBeNull();
    // stale: recorded 7h ago
    const old = Date.now() - 7 * 60 * 60 * 1000;
    recordAuthFailure(host, old);
    recordAuthFailure(host, old);
    recordAuthFailure(host, old);
    expect(authBudgetExhausted(host)).toBeNull();
    // hosts are independent
    recordAuthFailure("other.example.com");
    expect(authBudgetExhausted(host)).toBeNull();
  });
});
