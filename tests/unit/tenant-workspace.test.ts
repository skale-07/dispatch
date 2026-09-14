import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEncryptedFile } from "../../src/candidate/sensitiveCrypto.js";
import { loadPublicProfile } from "../../src/candidate/publicProfileIO.js";
import { parseScreenerBank } from "../../src/candidate/screeners.js";
import { personaSchema } from "../../src/candidate/personas.js";
import type { OnboardedUser } from "../../src/cloud/syncMapping.js";
import { loadConfig } from "../../src/config/env.js";
import { deriveTenantKey } from "../../src/tenants/keys.js";
import { tenantPaths } from "../../src/tenants/paths.js";
import { inspectWorkspace, listWorkspaces, materializeWorkspace, type WorkspaceClient } from "../../src/tenants/workspace.js";

/**
 * Plan M14 — materializeWorkspace writes exactly the files the engine's
 * own loaders accept, downloads documents once per upload, seals the
 * self-ID plaintext under the tenant key and nothing else, and refuses
 * by name with the flag off. Fake client, temp root, insecure test master.
 * UNIT_CONFIRMED.
 */

const UID = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const MASTER = Buffer.alloc(32, 9);

function user(over: Partial<OnboardedUser> = {}): OnboardedUser {
  const profile = {
    user_id: UID, full_name: "Maya Okafor", phone: "+1 412 555 0148",
    location_city: "Pittsburgh", location_region: "PA", location_country: "United States",
    linkedin_url: null, github_url: null, portfolio_url: null,
    work_authorization: "us_citizen", needs_sponsorship: false,
    education: [{ school: "Pitt", degree: "B.S.", field: "CS", start_year: 2023, end_year: 2027 }],
    job_preferences: { titles: ["SWE Intern"] },
    resume_object_path: null, resume_filename: null,
    onboarding_completed_at: "2026-09-12T20:00:00Z",
    about_me: "I build things and verify them.",
    legal_first_name: "Maya", legal_last_name: "Okafor",
  };
  return {
    userId: UID, email: "maya@pitt.edu", fullName: "Maya Okafor", phone: profile.phone,
    location: { city: "Pittsburgh", region: "PA", country: "United States" },
    links: { linkedin: null, github: null, portfolio: null },
    workAuthorization: "us_citizen", needsSponsorship: false,
    education: profile.education, jobPreferences: profile.job_preferences,
    resumeObjectPath: null, resumeFilename: null,
    onboardingCompletedAt: profile.onboarding_completed_at, maxCompletedApplications: 5,
    profile,
    documents: [
      { id: "d1", user_id: UID, kind: "resume", variant: "general", bucket: "resumes", object_path: `${UID}/resume/general/Maya.pdf`, filename: "Maya.pdf", role_families: [], is_default: true, uploaded_at: "2026-09-12T19:00:00Z" },
      { id: "d3", user_id: UID, kind: "transcript", variant: "general", bucket: "transcripts", object_path: `${UID}/transcript/general/T.pdf`, filename: "T.pdf", role_families: [], is_default: true, uploaded_at: "2026-09-12T19:05:00Z" },
    ],
    screenerAnswers: [{ user_id: UID, key: "age_over_18", kind: "registry", answer: "Yes", labels: [], source: "wizard", updated_at: null }],
    persona: {
      user_id: UID, persona_id: "default", headline: "CS junior",
      education: { school: "Pitt", class_year: 2027, majors: ["CS"] },
      projects: [{ name: "Dispatch", summary: "an agent", tools: [], relevance_tags: [] }],
      skills: [], interests: [],
    },
    integrations: [],
    ...over,
  };
}

function fakeClient(sensitive: unknown): WorkspaceClient & { downloads: string[]; rpcs: string[] } {
  const downloads: string[] = [];
  const rpcs: string[] = [];
  return {
    downloads,
    rpcs,
    storage: {
      from: (bucket: string) => ({
        download: async (objectPath: string) => {
          downloads.push(`${bucket}/${objectPath}`);
          return { data: new Blob([Buffer.from(`%PDF-${objectPath}`)]), error: null };
        },
      }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push(`${name}:${String(args["p_user"])}`);
      return { data: sensitive, error: null };
    },
  };
}

describe("materializeWorkspace (UNIT_CONFIRMED)", () => {
  let root: string;
  let operatorPrivate: string;
  let config: ReturnType<typeof loadConfig>;
  const KEY_A = deriveTenantKey(MASTER, UID);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-tenants-"));
    operatorPrivate = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-operator-"));
    fs.mkdirSync(path.join(operatorPrivate, "candidate"), { recursive: true });
    fs.writeFileSync(path.join(operatorPrivate, "candidate", "answer-aliases.json"), JSON.stringify({ version: 1, aliases: {} }));
    config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: "data/test.sqlite",
      TENANT_ENGINE_ENABLED: "true",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      TENANTS_ROOT: root,
      PRIVATE_DIR: operatorPrivate,
    });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(operatorPrivate, { recursive: true, force: true });
  });

  it("refuses by name with the flag off", async () => {
    const off = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite", TENANTS_ROOT: root });
    await expect(materializeWorkspace(user(), { client: fakeClient(null), config: off, tenantKey: KEY_A })).rejects.toThrow(/TENANT_ENGINE_ENABLED is false/);
    expect(listWorkspaces(root)).toEqual([]);
  });

  it("writes the engine's files where its loaders read them, downloads documents, seals self-ID under the tenant key", async () => {
    const client = fakeClient({
      consent: true,
      fields: { veteran_status: { choice: "answer", value: "I am not a protected veteran" }, gender: { choice: "prefer_not", value: null } },
    });
    const report = await materializeWorkspace(user(), { client, config, tenantKey: KEY_A, now: new Date("2026-09-12T21:00:00Z") });
    const p = tenantPaths(UID, root);

    // Engine loaders accept what was written.
    const profile = loadPublicProfile(path.join(p.candidateDir, "public-profile.json"));
    expect(profile.legal_name.first).toBe("Maya");
    expect(profile.address?.city).toBe("Pittsburgh");
    const bank = parseScreenerBank(JSON.parse(fs.readFileSync(path.join(p.candidateDir, "screeners.json"), "utf8")));
    expect(bank.answers["age_over_18"]).toBe("Yes");
    expect(bank.answers["work_authorization"]).toBe("Yes");
    expect(fs.readFileSync(path.join(p.candidateDir, "about-me.md"), "utf8")).toContain("## Application facts");
    expect(personaSchema.parse(JSON.parse(fs.readFileSync(path.join(p.candidateDir, "personas", "default.json"), "utf8"))).headline).toBe("CS junior");
    expect(fs.existsSync(path.join(p.candidateDir, "answer-aliases.json"))).toBe(true);

    // Documents: both downloaded, the default resume duplicated as default.pdf.
    expect(client.downloads).toEqual([`resumes/${UID}/resume/general/Maya.pdf`, `transcripts/${UID}/transcript/general/T.pdf`]);
    expect(fs.readFileSync(path.join(p.candidateDir, "resumes", "general.pdf"), "utf8")).toMatch(/^%PDF-/);
    expect(fs.existsSync(path.join(p.candidateDir, "resumes", "default.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(p.candidateDir, "transcript.pdf"))).toBe(true);

    // Self-ID: read through the service RPC for THIS user, sealed under the tenant key only.
    expect(client.rpcs).toEqual([`engine_read_sensitive_profile:${UID}`]);
    const enc = path.join(p.candidateDir, "sensitive-profile.enc");
    const sealed = readEncryptedFile<{ veteran_status: string; gender: string }>(enc, KEY_A);
    expect(sealed.veteran_status).toBe("I am not a protected veteran");
    expect(sealed.gender).toBe("Decline to self-identify");
    expect(() => readEncryptedFile(enc, deriveTenantKey(MASTER, OTHER))).toThrow();
    expect(fs.readFileSync(enc, "utf8")).not.toContain("veteran");
    // Nothing sensitive in any plaintext file.
    for (const f of ["public-profile.json", "screeners.json", "about-me.md", "tenant.json"]) {
      const file = f === "tenant.json" ? p.manifestPath : path.join(p.candidateDir, f);
      expect(fs.readFileSync(file, "utf8"), f).not.toMatch(/protected veteran|Decline to self/);
    }

    expect(report.sensitiveProfile).toBe("sealed");
    expect(report.persona).toBe("present");
    expect(report.downloaded).toHaveLength(2);
    const manifest = JSON.parse(fs.readFileSync(p.manifestPath, "utf8")) as Record<string, unknown>;
    expect(manifest["user_id"]).toBe(UID);
    expect(manifest["sensitive_profile"]).toBe("sealed");
    expect((manifest["eligibility"] as Record<string, unknown>)["outreach_eligible"]).toBe(false);

    // Every written path is inside the workspace; the status view agrees.
    const status = inspectWorkspace(UID, root);
    expect(status.files).toContain("sensitive-profile.enc");
    expect(status.staleUnsealed).toEqual([]);
    expect(listWorkspaces(root)).toEqual([UID]);
  });

  it("is idempotent: unchanged documents are not re-downloaded; a changed upload is; --force re-downloads all", async () => {
    const client = fakeClient(null);
    await materializeWorkspace(user(), { client, config, tenantKey: KEY_A });
    expect(client.downloads).toHaveLength(2);
    const second = await materializeWorkspace(user(), { client, config, tenantKey: KEY_A });
    expect(client.downloads).toHaveLength(2);
    expect(second.unchanged).toHaveLength(2);
    const u = user();
    u.documents[1]!.uploaded_at = "2026-09-13T00:00:00Z";
    const third = await materializeWorkspace(u, { client, config, tenantKey: KEY_A });
    expect(third.downloaded).toEqual(["private/candidate/transcript.pdf"]);
    await materializeWorkspace(u, { client, config, tenantKey: KEY_A, force: true });
    expect(client.downloads).toHaveLength(5);
  });

  it("consent withdrawn ⇒ the sealed file is removed; a persona that stops validating is removed too", async () => {
    await materializeWorkspace(user(), { client: fakeClient({ consent: true, fields: { pronouns: { choice: "answer", value: "They/them" } } }), config, tenantKey: KEY_A });
    const p = tenantPaths(UID, root);
    const enc = path.join(p.candidateDir, "sensitive-profile.enc");
    expect(fs.existsSync(enc)).toBe(true);
    const report = await materializeWorkspace(user({ persona: null }), { client: fakeClient(null), config, tenantKey: KEY_A });
    expect(fs.existsSync(enc)).toBe(false);
    expect(fs.existsSync(path.join(p.candidateDir, "personas", "default.json"))).toBe(false);
    expect(report.sensitiveProfile).toBe("none");
    expect(report.removed.sort()).toEqual(["private/candidate/personas/default.json", "private/candidate/sensitive-profile.enc"]);
    expect(report.personaReason).toMatch(/no persona row/);
  });
});
