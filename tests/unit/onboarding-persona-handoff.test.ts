import { describe, expect, it } from "vitest";
import { EMPTY_PROFILE, type HandoffTaskRow, type PersonaRow } from "../../frontend/src/public/contract.js";
import {
  ACTIVE_HANDOFF_STATUSES,
  GMAIL_CONNECT_KINDS,
  HANDOFF_POLL_CAP,
  HANDOFF_POLL_MS,
  connectKindFor,
  handoffPhase,
  integrationStatusLabel,
  isActiveHandoff,
  pickHandoff,
} from "../../frontend/src/public/onboarding/handoff.js";
import {
  EMPTY_PROJECT,
  PLACEHOLDER_PROJECT,
  personaFormFrom,
  personaIsBlank,
  personaRowFrom,
  personaStrict,
} from "../../frontend/src/public/onboarding/persona.js";

/**
 * Plan M10 pure modules: the outreach persona mapping (step 10) and the
 * JobRight handoff phase mapping (step 11). UNIT_CONFIRMED.
 */

describe("outreach persona (UNIT_CONFIRMED)", () => {
  it("prefills from the profile when there is no persona — never invents", () => {
    const form = personaFormFrom(null, {
      ...EMPTY_PROFILE,
      school: "Pitt",
      grad_year: "2027",
      field: "Computer Science",
      additional_fields: "Statistics",
      skills: "Python, SQL",
    });
    expect(form.headline).toBe("");
    expect(form.school).toBe("Pitt");
    expect(form.class_year).toBe("2027");
    expect(form.majors).toBe("Computer Science, Statistics");
    expect(form.skills).toBe("Python, SQL");
    expect(form.projects).toEqual([]);
    expect(personaIsBlank(form)).toBe(true);
    expect(personaRowFrom(form)).toBeNull();
  });

  it("a saved persona round-trips through the form", () => {
    const row: PersonaRow = {
      user_id: "u",
      persona_id: "default",
      headline: "CS junior building ML tooling",
      education: { school: "Pitt", class_year: 2027, majors: ["Computer Science"] },
      projects: [{ name: "Dispatch", summary: "an agent for forms", tools: ["TypeScript", "Playwright"], relevance_tags: ["automation"] }],
      skills: ["Python"],
      interests: ["climate"],
    };
    const form = personaFormFrom(row, EMPTY_PROFILE);
    expect(form.projects[0]?.tools).toBe("TypeScript, Playwright");
    const back = personaRowFrom(form);
    expect(back).toEqual({
      headline: row.headline,
      education: row.education,
      projects: row.projects,
      skills: row.skills,
      interests: row.interests,
    });
  });

  it("refuses placeholder project names like the engine loader and the table CHECK", () => {
    expect(PLACEHOLDER_PROJECT.test("REPLACE_ME")).toBe(true);
    expect(PLACEHOLDER_PROJECT.test("Replace me")).toBe(false);
    const r = personaStrict.safeParse({
      headline: "x",
      school: "",
      class_year: "",
      majors: "",
      projects: [{ ...EMPTY_PROJECT, name: "REPLACE_PROJECT_1" }],
      skills: "",
      interests: "",
    });
    expect(r.success).toBe(false);
  });

  it("strict mirrors the engine's personaSchema once a persona exists; blank is legal", () => {
    const base = { headline: "", school: "", class_year: "", majors: "", projects: [] as unknown[], skills: "", interests: "" };
    expect(personaStrict.safeParse(base).success).toBe(true);
    // Prefilled school/majors alone are not a persona.
    expect(personaStrict.safeParse({ ...base, school: "Pitt", majors: "CS" }).success).toBe(true);
    const complete = {
      ...base,
      headline: "CS junior building ML tooling",
      school: "Pitt",
      majors: "Computer Science",
      projects: [{ ...EMPTY_PROJECT, name: "Dispatch", summary: "an agent for forms" }],
    };
    expect(personaStrict.safeParse(complete).success).toBe(true);
    const paths = (v: unknown): string[] => {
      const r = personaStrict.safeParse(v);
      return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    };
    // The engine loader requires each of these (src/candidate/personas.ts).
    expect(paths({ ...complete, headline: "" })).toContain("headline");
    expect(paths({ ...complete, school: "" })).toContain("school");
    expect(paths({ ...complete, majors: "" })).toContain("majors");
    expect(paths({ ...complete, projects: [] })).toContain("headline");
    expect(paths({ ...complete, projects: [{ ...EMPTY_PROJECT, summary: "built a thing" }] })).toContain("projects.0.name");
    expect(paths({ ...complete, projects: [{ ...EMPTY_PROJECT, name: "Dispatch" }] })).toContain("projects.0.summary");
    // An entirely blank project row is dropped, not an error.
    const blankRow = personaRowFrom({ ...complete, projects: [...complete.projects, { ...EMPTY_PROJECT }] });
    expect(blankRow?.projects).toHaveLength(1);
  });
});

const task = (over: Partial<HandoffTaskRow>): HandoffTaskRow => ({
  id: "t1",
  user_id: "u",
  kind: "jobright_connect",
  status: "open",
  reason: null,
  context: {},
  live_view_url: null,
  expires_at: null,
  attempts: 0,
  result: null,
  created_at: "2026-09-12T20:00:00Z",
  updated_at: "2026-09-12T20:00:00Z",
  ...over,
});

describe("JobRight handoff phases (UNIT_CONFIRMED)", () => {
  it("maps every status to a UI phase; the UI never invents 'completed'", () => {
    expect(handoffPhase(null)).toBe("none");
    for (const s of ["open", "requested", "provisioning"] as const) expect(handoffPhase(task({ status: s }))).toBe("requested");
    expect(handoffPhase(task({ status: "live" }))).toBe("live");
    for (const s of ["user_done", "verifying"] as const) expect(handoffPhase(task({ status: s }))).toBe("verifying");
    for (const s of ["completed", "failed", "expired", "cancelled"] as const) expect(handoffPhase(task({ status: s }))).toBe(s);
  });

  it("picks the newest ACTIVE task of the kinds, else the newest finished one", () => {
    const rows = [
      task({ id: "old-done", status: "completed", created_at: "2026-09-10T00:00:00Z" }),
      task({ id: "live", status: "live", created_at: "2026-09-11T00:00:00Z" }),
      task({ id: "other-kind", kind: "captcha", status: "live", created_at: "2026-09-12T00:00:00Z" }),
    ];
    expect(pickHandoff(rows, ["jobright_connect", "jobright_reconnect"])?.id).toBe("live");
    expect(pickHandoff([rows[0]!], ["jobright_connect"])?.id).toBe("old-done");
    expect(pickHandoff(rows, ["gmail_connect"])).toBeNull();
    expect(isActiveHandoff(rows[1]!)).toBe(true);
    expect(isActiveHandoff(rows[0]!)).toBe(false);
    expect(ACTIVE_HANDOFF_STATUSES).not.toContain("completed");
  });

  it("polling is bounded: 5 s ticks, capped at 15 minutes", () => {
    expect(HANDOFF_POLL_MS).toBe(5000);
    expect(HANDOFF_POLL_CAP * HANDOFF_POLL_MS).toBe(15 * 60 * 1000);
  });

  it("status labels never invent a state", () => {
    expect(integrationStatusLabel(null)).toBe("not connected");
    expect(
      integrationStatusLabel({
        user_id: "u", provider: "jobright", status: "connected", account_email: "maya@pitt.edu", premium: true,
        scopes: [], connected_at: null, expires_at: null, last_checked_at: null, last_error: null, updated_at: "",
      }),
    ).toBe("connected as maya@pitt.edu");
  });
});

describe("Gmail handoff (decision 2026-09-14, UNIT_CONFIRMED)", () => {
  const row = (provider: "jobright" | "gmail", status: "connected" | "expired" | "revoked" | "disconnected" | "pending_handoff") => ({
    user_id: "u", provider, status, account_email: null, premium: false,
    scopes: [], connected_at: null, expires_at: null, last_checked_at: null, last_error: null, updated_at: "",
  });

  it("Gmail connects through the same handoff kinds the engine queue already knows; once connected it is a reconnect", () => {
    expect(GMAIL_CONNECT_KINDS).toEqual(["gmail_connect", "gmail_reconnect"]);
    expect(connectKindFor("gmail", null)).toBe("gmail_connect");
    expect(connectKindFor("gmail", row("gmail", "disconnected"))).toBe("gmail_connect");
    expect(connectKindFor("gmail", row("gmail", "pending_handoff"))).toBe("gmail_connect");
    for (const s of ["connected", "expired", "revoked"] as const) expect(connectKindFor("gmail", row("gmail", s))).toBe("gmail_reconnect");
    expect(connectKindFor("jobright", null)).toBe("jobright_connect");
    expect(connectKindFor("jobright", row("jobright", "expired"))).toBe("jobright_reconnect");
  });

  it("a Gmail task and a JobRight task are picked independently of each other", () => {
    const base = { user_id: "u", status: "live" as const, context: {}, live_view_url: null, provider_session_id: null, expires_at: null, attempts: 0, reason: null, result: null, updated_at: "" };
    const tasks: HandoffTaskRow[] = [
      { ...base, id: "j", kind: "jobright_connect", created_at: "2026-09-14T01:00:00Z" },
      { ...base, id: "g", kind: "gmail_connect", created_at: "2026-09-14T02:00:00Z" },
    ];
    expect(pickHandoff(tasks, GMAIL_CONNECT_KINDS)?.id).toBe("g");
    expect(pickHandoff(tasks, ["jobright_connect", "jobright_reconnect"])?.id).toBe("j");
  });
});
