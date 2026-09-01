import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { createApplication, getApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { listOpenReviewItems } from "../../src/queue/reviewItems.js";
import {
  extractContactsFromHtml,
  runContactsExtraction,
} from "../../src/contacts/extractContacts.js";
import { listContacts, upsertContact } from "../../src/contacts/repository.js";
import {
  ALUM_SUBJECT_PREFIX,
  NON_ALUM_SUBJECT_PREFIX,
  LINKEDIN_PROFILE_URL,
  assertEmailGenerationAllowed,
  buildEmailPrompt,
  generateEmailForContact,
  loadOutreachTemplate,
  TemplateNotConfiguredError,
  validateGeneratedEmail,
  type EmailContext,
  type GeneratedEmail,
} from "../../src/contacts/emailGenerate.js";
import type { EmailLlmClient } from "../../src/contacts/emailLlm.js";
import { personaSchema, type Persona } from "../../src/candidate/personas.js";
import { resetConfigCache } from "../../src/config/index.js";

const CONTACTS_FIXTURE = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "jobright",
  "contacts",
  "dom.sanitized.html",
);

const testPersona: Persona = personaSchema.parse({
  persona_id: "test",
  headline: "Rising sophomore at Johns Hopkins studying Applied Math & Statistics and Economics",
  education: {
    school: "Johns Hopkins University",
    class_year: 2029,
    majors: ["Applied Mathematics & Statistics", "Economics"],
  },
  projects: [
    {
      name: "Deterministic Application Pipeline",
      summary: "State-machine driven job application processor",
      tools: ["TypeScript", "SQLite", "Playwright"],
      relevance_tags: ["infra", "automation"],
    },
    {
      name: "Volatility Forecasting Model",
      summary: "GARCH-family model comparison on equity indices",
      tools: ["Python", "statsmodels"],
      relevance_tags: ["quant", "modeling"],
    },
  ],
});

function contextFor(sourceCategory: string): EmailContext {
  return {
    contact: {
      name: "Jordan Rivera",
      title: "Software Engineer",
      company: "Acme Robotics",
      source_category: sourceCategory,
    },
    job: {
      company: "Acme Robotics",
      role: "SWE Intern",
      description: "Build robot control UIs in TypeScript on the platform team.",
    },
    persona: testPersona,
  };
}

function validOutput(sourceCategory: string): GeneratedEmail {
  const alum = sourceCategory === "school";
  const why = alum
    ? "I recently applied to Acme Robotics's SWE Intern role and saw that you're a JHU alum now working as a Software Engineer at Acme Robotics. I'd really appreciate 15 minutes sometime in the next week to hear about your experience at Acme Robotics and how you think someone with my background should approach the process."
    : "I recently applied to Acme Robotics's SWE Intern role and saw that you're a Software Engineer at Acme Robotics. I'd really appreciate 15 minutes sometime in the next week to hear about your experience at Acme Robotics and how you think someone with my background should approach the process.";
  return {
    subject: `${alum ? ALUM_SUBJECT_PREFIX : NON_ALUM_SUBJECT_PREFIX}Acme Robotics SWE Intern`,
    used_alum_subject: alum,
    persona_projects_used: [
      "Deterministic Application Pipeline",
      "Volatility Forecasting Model",
    ],
    body_text: [
      "Hi Jordan,",
      "",
      `Hope you're doing well. My name is Shubham Kale, and I'm a sophomore at Johns Hopkins studying Applied Math & Statistics and Economics. ${why}`,
      "",
      "A few quick points on my background:",
      "- I own Deterministic Application Pipeline, including TypeScript, SQLite, and Playwright.",
      "- I also built Volatility Forecasting Model, focused on statistical evaluation.",
      "",
      "If my background seems relevant, I'd also be very grateful for a referral for the SWE Intern role.",
      "",
      "Best,",
      "Shubham Kale",
      LINKEDIN_PROFILE_URL,
      "Applied Mathematics, Economics, & Public Health",
      "Johns Hopkins University",
      "Hodson Trust Scholar",
    ].join("\n"),
  };
}

class StubClient implements EmailLlmClient {
  constructor(private readonly payload: unknown) {}
  async generateJson(): Promise<{ text: string; model: string }> {
    return {
      text:
        typeof this.payload === "string"
          ? this.payload
          : JSON.stringify(this.payload),
      model: "stub-model-1",
    };
  }
}

describe("contacts extraction (FIXTURE_CONFIRMED — selectors live-UNVERIFIED)", () => {
  it("parses cards with section-based source categories", () => {
    const html = fs.readFileSync(CONTACTS_FIXTURE, "utf8");
    const contacts = extractContactsFromHtml(html);
    expect(contacts).toHaveLength(3);
    expect(contacts[0]).toMatchObject({
      name: "Jordan Rivera",
      source_category: "school",
      jobright_contact_id: "c-school-1",
    });
    expect(contacts[1]?.source_category).toBe("beyond");
    expect(contacts[2]?.name).toBe("Priya Natarajan");
  });
});

describe("contacts persistence + extraction run (UNIT/FIXTURE)", () => {
  let dbPath: string;
  let db: Db;
  let applicationId: string;

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-contacts-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e6)}`,
      company: "Acme Robotics",
      role: "SWE Intern",
    });
    applicationId = createApplication(db, { jobId: job.id }).id;
    db.prepare(`UPDATE applications SET state = 'SUBMITTED' WHERE id = ?`).run(
      applicationId,
    );
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("fixture extraction persists contacts and advances state", async () => {
    const report = await runContactsExtraction({
      db,
      applicationId,
      fixtureHtmlPath: CONTACTS_FIXTURE,
    });
    expect(report.extracted).toBe(3);
    expect(report.created).toBe(3);
    expect(report.end_state).toBe("CONTACTS_EXTRACTED");
    expect(getApplication(db, applicationId)?.state).toBe("CONTACTS_EXTRACTED");

    // Re-run reuses instead of duplicating (partial unique indexes).
    db.prepare(
      `UPDATE applications SET state = 'SUBMITTED' WHERE id = ?`,
    ).run(applicationId);
    const again = await runContactsExtraction({
      db,
      applicationId,
      fixtureHtmlPath: CONTACTS_FIXTURE,
    });
    expect(again.created).toBe(0);
    expect(again.reused).toBe(3);
    expect(listContacts(db, applicationId)).toHaveLength(3);
  });

  it("zero contacts completes the application", async () => {
    const empty = path.join(os.tmpdir(), `jaa-empty-${randomUUID()}.html`);
    fs.writeFileSync(empty, "<html><body><p>no contacts here</p></body></html>");
    try {
      const report = await runContactsExtraction({
        db,
        applicationId,
        fixtureHtmlPath: empty,
      });
      expect(report.extracted).toBe(0);
      expect(report.end_state).toBe("COMPLETED");
    } finally {
      fs.unlinkSync(empty);
    }
  });
});

describe("outreach template + prompt (UNIT_CONFIRMED)", () => {
  it("loads the real template (placeholder is gone)", () => {
    const t = loadOutreachTemplate();
    expect(t).toContain("Hopkins sophomore interested in");
    expect(t).toContain("Shubham Kale");
    expect(t).toContain(LINKEDIN_PROFILE_URL);
  });

  it("fails closed on a placeholder template", () => {
    const p = path.join(os.tmpdir(), `jaa-tpl-${randomUUID()}.md`);
    fs.writeFileSync(p, "# t\n\nPASTE_USER_APPROVED_EMAIL_TEMPLATE_HERE\n");
    try {
      expect(() => loadOutreachTemplate(p)).toThrow(TemplateNotConfiguredError);
    } finally {
      fs.unlinkSync(p);
    }
    expect(() => loadOutreachTemplate("/nonexistent.md")).toThrow(
      TemplateNotConfiguredError,
    );
  });

  it("prompt carries template rules, persona and contact context", () => {
    const prompt = buildEmailPrompt({
      template: loadOutreachTemplate(),
      context: contextFor("beyond"),
    });
    expect(prompt.system).toContain("Never claim you were referred");
    expect(prompt.system).toContain("Output schema");
    expect(prompt.user).toContain("Jordan Rivera");
    expect(prompt.user).toContain("Volatility Forecasting Model");
  });
});

describe("deterministic email validation (UNIT_CONFIRMED)", () => {
  it("accepts a compliant non-alum email and a compliant alum email", () => {
    expect(
      validateGeneratedEmail({
        output: validOutput("beyond"),
        context: contextFor("beyond"),
      }).valid,
    ).toBe(true);
    expect(
      validateGeneratedEmail({
        output: validOutput("school"),
        context: contextFor("school"),
      }).valid,
    ).toBe(true);
  });

  it("v3: subject prefix is uniform; the alum METADATA flag still must match", () => {
    // The operator's v2 template uses one subject for every contact, so a
    // school-flavored output against a beyond contact fails only on the
    // used_alum_subject metadata — not on the (identical) prefix.
    const r = validateGeneratedEmail({
      output: validOutput("school"),
      context: contextFor("beyond"),
    });
    expect(r.valid).toBe(false);
    expect(r.violations.join(" ")).toMatch(/used_alum_subject/);
  });

  it("v3: leftover [bracket] placeholders and a missing LinkedIn URL reject", () => {
    const unfilled = {
      ...validOutput("beyond"),
      body_text: `${validOutput("beyond").body_text}\n[team/product/background]`,
    };
    const r1 = validateGeneratedEmail({
      output: unfilled,
      context: contextFor("beyond"),
    });
    expect(r1.violations.join(" ")).toMatch(/placeholder/);

    const noLink = {
      ...validOutput("beyond"),
      body_text: validOutput("beyond").body_text.replace(
        `\n${LINKEDIN_PROFILE_URL}`,
        "",
      ),
    };
    const r2 = validateGeneratedEmail({
      output: noLink,
      context: contextFor("beyond"),
    });
    expect(r2.violations.join(" ")).toMatch(/linkedin\.com\/in\/shubham-kale/);
  });

  it("v3: a nameless contact must be greeted 'Hi there,' — no guessed names", () => {
    const namelessCtx: EmailContext = {
      ...contextFor("email"),
      contact: { ...contextFor("email").contact, name: null },
    };
    const guessed = {
      ...validOutput("beyond"),
      body_text: validOutput("beyond").body_text, // greets "Hi Jordan,"
    };
    const r1 = validateGeneratedEmail({ output: guessed, context: namelessCtx });
    expect(r1.violations.join(" ")).toMatch(/Hi there/);

    const proper = {
      ...validOutput("beyond"),
      body_text: validOutput("beyond").body_text.replace(
        "Hi Jordan,",
        "Hi there,",
      ),
    };
    const r2 = validateGeneratedEmail({ output: proper, context: namelessCtx });
    expect(r2.valid).toBe(true);
  });

  it("rejects non-bracket placeholder tokens (live 2026-08-18: REPLACE_PROJECT_ONE was VALIDATED)", () => {
    const hollow = validOutput("beyond");
    hollow.body_text = hollow.body_text.replace(
      "Deterministic Application Pipeline",
      "REPLACE_PROJECT_ONE",
    );
    // Keep persona_projects_used consistent so the ONLY violation under
    // test is the placeholder token itself.
    hollow.persona_projects_used = ["Volatility Forecasting Model"];
    const r = validateGeneratedEmail({
      output: hollow,
      context: contextFor("beyond"),
    });
    expect(r.valid).toBe(false);
    expect(r.violations.join(" ")).toMatch(/placeholder token/);
  });

  it("rejects invented projects and unused claimed projects", () => {
    const invented = {
      ...validOutput("beyond"),
      persona_projects_used: ["Totally Invented Quant Fund"],
    };
    const r = validateGeneratedEmail({
      output: invented,
      context: contextFor("beyond"),
    });
    expect(r.valid).toBe(false);
    expect(r.violations.join(" ")).toMatch(/invented/);
  });

  it("accepts a compound project name written as one segment in the body (#107, live 2026-08-31: Old Mission rejections)", () => {
    const compoundPersona = personaSchema.parse({
      ...testPersona,
      projects: [
        ...testPersona.projects,
        {
          name: "Summer Atlantic Capital / SAC Nexus Anomaly Detection System",
          summary: "Anomaly detection ML core",
          tools: ["Python", "FastAPI"],
          relevance_tags: ["ml"],
        },
      ],
    });
    const context = { ...contextFor("beyond"), persona: compoundPersona };
    const output = validOutput("beyond");
    output.persona_projects_used = [
      ...output.persona_projects_used,
      "Summer Atlantic Capital / SAC Nexus Anomaly Detection System",
    ];
    output.body_text = output.body_text.replace(
      "A few quick points on my background:",
      "A few quick points on my background:\n- For the SAC Nexus Anomaly Detection System, I built the ML core with Python and FastAPI.",
    );
    const r = validateGeneratedEmail({ output, context });
    expect(r.violations).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("still rejects a compound project claim when no segment appears in the body", () => {
    const compoundPersona = personaSchema.parse({
      ...testPersona,
      projects: [
        ...testPersona.projects,
        {
          name: "Summer Atlantic Capital / SAC Nexus Anomaly Detection System",
          summary: "Anomaly detection ML core",
          tools: ["Python", "FastAPI"],
          relevance_tags: ["ml"],
        },
      ],
    });
    const context = { ...contextFor("beyond"), persona: compoundPersona };
    const output = validOutput("beyond");
    output.persona_projects_used = [
      ...output.persona_projects_used,
      "Summer Atlantic Capital / SAC Nexus Anomaly Detection System",
    ];
    const r = validateGeneratedEmail({ output, context });
    expect(r.valid).toBe(false);
    expect(r.violations.join(" ")).toMatch(/absent from body/);
  });

  it("greeting check is case-insensitive against the scraped name (#108, live 2026-08-31: 'paola manganiello' vs 'Hi Paola,')", () => {
    const context = contextFor("beyond");
    context.contact.name = "jordan rivera";
    const output = validOutput("beyond"); // greets "Hi Jordan,"
    const r = validateGeneratedEmail({ output, context });
    expect(r.violations).toEqual([]);

    const missing = validOutput("beyond");
    missing.body_text = missing.body_text.replace("Hi Jordan,", "Hi there,");
    const r2 = validateGeneratedEmail({ output: missing, context });
    expect(r2.valid).toBe(false);
    expect(r2.violations.join(" ")).toMatch(/first name/);
  });

  it("subject naming a distinctive company token passes; unrelated subject still fails (#115)", () => {
    const context = contextFor("beyond");
    context.job.company = "CACI International Inc";
    context.contact.company = "CACI International Inc";
    const output = validOutput("beyond");
    output.subject = `${NON_ALUM_SUBJECT_PREFIX}CACI Software Developer internship`;
    const r = validateGeneratedEmail({ output, context });
    expect(r.violations.join(" ")).not.toMatch(/name the company/);

    const generic = validOutput("beyond");
    generic.subject = `${NON_ALUM_SUBJECT_PREFIX}your team's open role`;
    const r2 = validateGeneratedEmail({ output: generic, context });
    expect(r2.violations.join(" ")).toMatch(/name the company/);
  });

  it("rejects referral claims and false school ties", () => {
    const referral = validOutput("beyond");
    referral.body_text += "\nI was referred by your colleague.";
    expect(
      validateGeneratedEmail({ output: referral, context: contextFor("beyond") })
        .valid,
    ).toBe(false);

    const tie = validOutput("beyond");
    tie.body_text = tie.body_text.replace(
      "Hi Jordan,",
      "Hi Jordan, as a fellow Hopkins person,",
    );
    expect(
      validateGeneratedEmail({ output: tie, context: contextFor("beyond") })
        .valid,
    ).toBe(false);

    const inventedAlum = validOutput("beyond");
    inventedAlum.body_text = inventedAlum.body_text.replace(
      "you're a Software Engineer at Acme Robotics",
      "you're a JHU alum now working as a Software Engineer at Acme Robotics",
    );
    expect(
      validateGeneratedEmail({
        output: inventedAlum,
        context: contextFor("beyond"),
      }).valid,
    ).toBe(false);
  });
});

describe("generateEmailForContact with stub client (UNIT_CONFIRMED, no network)", () => {
  let dbPath: string;
  let db: Db;
  let applicationId: string;
  let contactId: string;
  let personasDir: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-gen-${randomUUID()}.sqlite`);
    const privateDir = path.join(os.tmpdir(), `jaa-gen-priv-${randomUUID()}`);
    personasDir = path.join(privateDir, "candidate", "personas");
    fs.mkdirSync(personasDir, { recursive: true });
    fs.writeFileSync(
      path.join(personasDir, "default.json"),
      JSON.stringify(testPersona),
    );
    process.env.DATABASE_PATH = dbPath;
    process.env.PRIVATE_DIR = privateDir;
    process.env.EMAIL_GENERATION_ENABLED = "true";
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key-000000000000";
    // Hermetic: an ambient Anthropic key must not flip the provider choice.
    delete process.env.ANTHROPIC_API_KEY;
    resetConfigCache();

    db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e6)}`,
      company: "Acme Robotics",
      role: "SWE Intern",
    });
    applicationId = createApplication(db, { jobId: job.id }).id;
    db.prepare(
      `UPDATE applications SET state = 'CONTACTS_EXTRACTED' WHERE id = ?`,
    ).run(applicationId);
    contactId = upsertContact(db, {
      applicationId,
      name: "Jordan Rivera",
      title: "Software Engineer",
      company: "Acme Robotics",
      sourceCategory: "beyond",
      jobrightContactId: "c-beyond-1",
    }).id;
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.EMAIL_GENERATION_ENABLED;
    delete process.env.OPENAI_API_KEY;
    delete process.env.PRIVATE_DIR;
    resetConfigCache();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("gate refuses when flag off or key missing", () => {
    process.env.EMAIL_GENERATION_ENABLED = "false";
    resetConfigCache();
    expect(() => assertEmailGenerationAllowed()).toThrow(
      /EMAIL_GENERATION_ENABLED=false/,
    );
    process.env.EMAIL_GENERATION_ENABLED = "true";
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    resetConfigCache();
    expect(() => assertEmailGenerationAllowed()).toThrow(
      /ANTHROPIC_API_KEY, OPENAI_API_KEY, or MOONSHOT_API_KEY/,
    );
  });

  it("VALIDATED path writes the row with the model id and advances state", async () => {
    const result = await generateEmailForContact({
      db,
      applicationId,
      contactId,
      client: new StubClient(validOutput("beyond")),
    });
    expect(result.validation_status).toBe("VALIDATED");
    expect(result.model).toBe("stub-model-1");
    expect(result.subject).toContain("Hopkins sophomore interested in");
    expect(result.application_state).toBe("EMAIL_GENERATED");

    const row = db
      .prepare(
        `SELECT model, validation_status FROM email_generations WHERE id = ?`,
      )
      .get(result.email_generation_id) as {
      model: string;
      validation_status: string;
    };
    expect(row.model).toBe("stub-model-1");
    expect(row.validation_status).toBe("VALIDATED");
  });

  it("REJECTED output opens exactly one review item, no state advance, and upserts on retry", async () => {
    const bad = validOutput("beyond");
    bad.persona_projects_used = ["Invented Project"];
    const r1 = await generateEmailForContact({
      db,
      applicationId,
      contactId,
      client: new StubClient(bad),
    });
    expect(r1.validation_status).toBe("REJECTED");
    expect(r1.subject).toBeNull();
    expect(getApplication(db, applicationId)?.state).toBe("EMAIL_GENERATING");
    const items = listOpenReviewItems(db).filter((i) =>
      /Outreach generation rejected/.test(i.title),
    );
    expect(items).toHaveLength(1);

    // Second attempt with the same contact upserts the single row
    // (UNIQUE app+contact+prompt_version) rather than inserting another.
    const r2 = await generateEmailForContact({
      db,
      applicationId,
      contactId,
      client: new StubClient(bad),
    });
    expect(r2.validation_status).toBe("REJECTED");
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM email_generations WHERE application_id = ?`,
      )
      .get(applicationId) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("malformed model output is REJECTED, not thrown", async () => {
    const result = await generateEmailForContact({
      db,
      applicationId,
      contactId,
      client: new StubClient("this is not json at all"),
    });
    expect(result.validation_status).toBe("REJECTED");
    expect(result.violations.join(" ")).toMatch(/schema validation/);
  });

  it("COMPLETED apps still generate — pipeline skip is not a dead end", async () => {
    db.prepare(`UPDATE applications SET state = 'COMPLETED' WHERE id = ?`).run(
      applicationId,
    );
    const result = await generateEmailForContact({
      db,
      applicationId,
      contactId,
      client: new StubClient(validOutput("beyond")),
    });
    expect(result.validation_status).toBe("VALIDATED");
    expect(result.application_state).toBe("COMPLETED");
    expect(getApplication(db, applicationId)?.state).toBe("COMPLETED");
  });

  it("QUEUED apps generate without walking into post-submit outreach states", async () => {
    db.prepare(`UPDATE applications SET state = 'QUEUED' WHERE id = ?`).run(
      applicationId,
    );
    const result = await generateEmailForContact({
      db,
      applicationId,
      contactId,
      client: new StubClient(validOutput("beyond")),
    });
    expect(result.validation_status).toBe("VALIDATED");
    expect(result.application_state).toBe("QUEUED");
    expect(getApplication(db, applicationId)?.state).toBe("QUEUED");
  });
});
