import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  collectOnboardingChecks,
  summarizeOnboarding,
  type OnboardingCheck,
} from "../../src/console/onboardingStatus.js";
import { buildOnboardingRoutes } from "../../src/console/onboardingRoutes.js";

/**
 * Onboarding readiness (UNIT_CONFIRMED). Two properties matter most:
 * fail-closed honesty (a check that cannot run is "unknown", and
 * "unknown" never counts toward ready) and read-only collection (the
 * collector verifies what the documented CLI commands left on disk; it
 * never creates any of it).
 */

function check(
  overrides: Partial<OnboardingCheck> & { id: string },
): OnboardingCheck {
  return {
    step: "prerequisites",
    label: overrides.id,
    status: "ok",
    required: true,
    detail: "",
    fix: null,
    ...overrides,
  };
}

describe("summarizeOnboarding (pure aggregation)", () => {
  it("is ready only when every required check is ok", () => {
    const summary = summarizeOnboarding([
      check({ id: "a" }),
      check({ id: "b", step: "profile" }),
      check({ id: "c", step: "sessions" }),
    ]);
    expect(summary.ready).toBe(true);
    expect(summary.steps.map((s) => s.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("a required todo blocks readiness and marks its step", () => {
    const summary = summarizeOnboarding([
      check({ id: "a" }),
      check({ id: "b", step: "profile", status: "todo" }),
    ]);
    expect(summary.ready).toBe(false);
    expect(summary.steps.find((s) => s.id === "profile")?.status).toBe("todo");
    expect(summary.steps.find((s) => s.id === "prerequisites")?.status).toBe("ok");
  });

  it("unknown never promotes: a required unknown blocks readiness", () => {
    const summary = summarizeOnboarding([
      check({ id: "a", status: "unknown" }),
    ]);
    expect(summary.ready).toBe(false);
    expect(summary.steps.find((s) => s.id === "prerequisites")?.status).toBe(
      "unknown",
    );
  });

  it("todo outranks unknown for the step verdict (there is work to do either way)", () => {
    const summary = summarizeOnboarding([
      check({ id: "a", status: "unknown" }),
      check({ id: "b", status: "todo" }),
    ]);
    expect(summary.steps.find((s) => s.id === "prerequisites")?.status).toBe(
      "todo",
    );
  });

  it("optional checks inform but never block", () => {
    const summary = summarizeOnboarding([
      check({ id: "a" }),
      check({ id: "opt1", required: false, status: "todo" }),
      check({ id: "opt2", required: false, status: "unknown" }),
    ]);
    expect(summary.ready).toBe(true);
    expect(summary.steps.find((s) => s.id === "prerequisites")?.status).toBe("ok");
  });
});

describe("collectOnboardingChecks (read-only collection)", () => {
  let tmpDir: string;
  let db: Db;
  const savedEnv: Record<string, string | undefined> = {};

  const okProbe = async (): Promise<{ cdp_reachable: boolean }> => ({
    cdp_reachable: true,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-onboarding-"));
    for (const key of ["PRIVATE_DIR", "DATABASE_PATH"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.PRIVATE_DIR = path.join(tmpDir, "private");
    process.env.DATABASE_PATH = path.join(tmpDir, "app.sqlite");
    resetConfigCache();
    db = openDatabase(process.env.DATABASE_PATH);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function byId(checks: OnboardingCheck[]): Map<string, OnboardingCheck> {
    return new Map(checks.map((c) => [c.id, c]));
  }

  it("an empty private dir reports the real to-dos, never ok", async () => {
    const checks = byId(
      await collectOnboardingChecks(db, {
        probeCdp: okProbe,
        envFilePath: path.join(tmpDir, "no-such.env"),
      }),
    );
    expect(checks.get("env_file")?.status).toBe("todo");
    expect(checks.get("public_profile")?.status).toBe("todo");
    expect(checks.get("jobright_session")?.status).toBe("todo");
    expect(checks.get("sensitive_profile")?.status).toBe("todo");
    expect(checks.get("gmail_token")?.status).toBe("todo");
    // The migrated temp DB is genuinely ok, as is the faked CDP probe.
    expect(checks.get("database_migrated")?.status).toBe("ok");
    expect(checks.get("debug_chrome")?.status).toBe("ok");
    expect(summarizeOnboarding([...checks.values()]).ready).toBe(false);
  });

  it("verifies what the documented commands left on disk", async () => {
    const candidateDir = path.join(process.env.PRIVATE_DIR!, "candidate");
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(
      path.join(candidateDir, "public-profile.json"),
      JSON.stringify({
        legal_name: { first: "Ada", last: "Lovelace" },
        email: "ada@example.com",
      }),
    );
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "# flags\n");
    const authDir = path.join(process.env.PRIVATE_DIR!, "auth");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, "jobright.storage.json"),
      JSON.stringify({ cookies: [], origins: [] }),
    );

    const checks = byId(
      await collectOnboardingChecks(db, {
        probeCdp: okProbe,
        envFilePath: envPath,
      }),
    );
    expect(checks.get("env_file")?.status).toBe("ok");
    expect(checks.get("public_profile")?.status).toBe("ok");
    expect(checks.get("jobright_session")?.status).toBe("ok");
  });

  it("a present-but-broken profile is a todo naming the parse failure", async () => {
    const candidateDir = path.join(process.env.PRIVATE_DIR!, "candidate");
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(
      path.join(candidateDir, "public-profile.json"),
      JSON.stringify({ email: "no legal_name" }),
    );
    const checks = byId(
      await collectOnboardingChecks(db, { probeCdp: okProbe }),
    );
    expect(checks.get("public_profile")?.status).toBe("todo");
    expect(checks.get("public_profile")?.detail).toContain("does not parse");
  });

  it("an unmigrated database is a todo pointing at npm run migrate", async () => {
    const freshPath = path.join(tmpDir, "fresh.sqlite");
    const fresh = openDatabase(freshPath);
    try {
      const checks = byId(
        await collectOnboardingChecks(fresh, { probeCdp: okProbe }),
      );
      expect(checks.get("database_migrated")?.status).toBe("todo");
      expect(checks.get("database_migrated")?.fix).toContain("npm run migrate");
    } finally {
      closeDatabase(fresh);
    }
  });

  it("a probe that cannot run reports unknown, never ok (fail-closed honesty)", async () => {
    const checks = byId(
      await collectOnboardingChecks(db, {
        probeCdp: async () => {
          throw new Error("CDP exploded");
        },
      }),
    );
    expect(checks.get("debug_chrome")?.status).toBe("unknown");
    expect(checks.get("debug_chrome")?.detail).toContain("CDP exploded");
  });

  it("collection is read-only: it creates nothing under private/", async () => {
    await collectOnboardingChecks(db, {
      probeCdp: okProbe,
      envFilePath: path.join(tmpDir, "no-such.env"),
    });
    expect(fs.existsSync(process.env.PRIVATE_DIR!)).toBe(false);
  });

  it("the route serves the aggregated summary as JSON", async () => {
    const routes = buildOnboardingRoutes({
      db,
      seams: { probeCdp: okProbe, envFilePath: path.join(tmpDir, "no-such.env") },
    });
    expect(routes).toHaveLength(1);
    expect(routes[0]!.method).toBe("GET");
    expect(routes[0]!.pattern).toBe("/api/onboarding/status");

    const out = { statusCode: 0, body: "" };
    const res = {
      headersSent: false,
      writeHead(status: number) {
        out.statusCode = status;
        (this as { headersSent: boolean }).headersSent = true;
        return this;
      },
      end(chunk?: string | Buffer) {
        out.body = chunk === undefined ? "" : chunk.toString();
      },
    } as unknown as ServerResponse;
    await routes[0]!.handler({
      req: {} as IncomingMessage,
      res,
      params: {},
      searchParams: new URLSearchParams(),
    });
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body) as {
      ready: boolean;
      steps: Array<{ id: string; checks: unknown[] }>;
    };
    expect(body.ready).toBe(false);
    expect(body.steps.map((s) => s.id)).toEqual([
      "prerequisites",
      "profile",
      "sessions",
    ]);
  });
});
