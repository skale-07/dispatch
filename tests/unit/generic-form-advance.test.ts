import { describe, expect, it } from "vitest";
import {
  walkGenericFormPages,
  walkSectionEditors,
} from "../../src/applications/genericFormAdvance.js";
import {
  expandCollapsedSections,
  openSectionEditors,
  saveOpenSectionEditors,
} from "../../src/ats/shared/sectionExpand.js";
import { resolveSubmitControl } from "../../src/ats/shared/submitControl.js";
import { genericSelectorsV1 } from "../../src/ats/generic/selectors.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

describe("generic form-page advance (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("clicks Continue To Application, fills the next page, then leaves Submit alone", async () => {
    const html = `<!DOCTYPE html><html><body>
      <form id="f">
        <div id="step">
          <label>Phone<input name="phone" /></label>
          <button type="submit">Continue To Application</button>
        </div>
      </form>
      <script>
        document.getElementById("f").addEventListener("submit", (e) => {
          e.preventDefault();
          document.getElementById("step").innerHTML =
            '<label>First<input name="first_name" required /></label>' +
            '<button type="submit">Submit application</button>';
        });
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      let fills = 0;
      const walk = await walkGenericFormPages(
        page,
        async () => {
          fills += 1;
          return { fillable: 1, filled: 1, verifyPassed: true };
        },
        { settleMs: 5_000 },
      );
      expect(fills).toBe(1);
      expect(walk.pages).toHaveLength(1);
      expect(walk.verifyFailed).toBe(false);
      const submit = await resolveSubmitControl(
        walk.page,
        genericSelectorsV1.submitCascade,
      );
      expect(submit.found).toBe(true);
    });
  }, 30_000);

  // #141 (live UKG Pro AuthCode/Register 2026-09-01): the mid-flow
  // account-setup page continues via "Create account" — submit-shaped,
  // outside the <form> (associated by form= attribute), excluded from the
  // submit cascade by name. The walk must take it as a page advance when
  // the page SAYS it is account setup and holds no file input.
  it("#141 advances through an account-setup page via Create account", async () => {
    const html = `<!DOCTYPE html><html><body>
      <h2>Almost there!</h2>
      <p>Please provide your name to set up your account</p>
      <form id="registrationDetailsForm">
        <label>First name<input name="firstName" required /></label>
        <label>Last name<input name="lastName" required /></label>
      </form>
      <button type="submit" id="create" form="registrationDetailsForm">Create account</button>
      <script>
        document.getElementById("create").addEventListener("click", (e) => {
          e.preventDefault();
          document.body.innerHTML =
            '<h2>Application</h2>' +
            '<form><label>Why us<input name="why" required /></label>' +
            '<button type="submit">Submit application</button></form>';
        });
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      let fills = 0;
      const walk = await walkGenericFormPages(
        page,
        async () => {
          fills += 1;
          return { fillable: 1, filled: 1, verifyPassed: true };
        },
        { settleMs: 5_000 },
      );
      expect(walk.notes.join(" ")).toMatch(/account-setup continuation/);
      expect(fills).toBe(1);
      expect(walk.pages).toHaveLength(1);
      const submit = await resolveSubmitControl(
        walk.page,
        genericSelectorsV1.submitCascade,
      );
      expect(submit.found).toBe(true);
    });
  }, 30_000);

  it("#141 guard: a page WITHOUT the account-setup marker never takes the tier", async () => {
    const html = `<!DOCTYPE html><html><body>
      <p>Join our talent community</p>
      <form>
        <label>Email<input name="email" /></label>
      </form>
      <button type="submit" id="create">Create account</button>
      <script>
        document.getElementById("create").addEventListener("click", () => {
          (globalThis).__accountClicked = true;
        });
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const walk = await walkGenericFormPages(page, async () => ({
        fillable: 0,
        filled: 0,
        verifyPassed: true,
      }));
      expect(walk.pages).toHaveLength(0);
      expect(
        await page.evaluate(
          () => (globalThis as unknown as { __accountClicked?: boolean }).__accountClicked,
        ),
      ).toBeUndefined();
      expect(walk.notes.join(" ")).toMatch(/no Next\/Continue/);
    });
  }, 30_000);

  // #143 (live UKG OpportunityApply 2026-09-01): the application renders
  // as Bootstrap-style collapsible panels; 13 planned fills timed out on
  // controls hidden inside div.collapse sections.
  it("#143 expands collapsed panels and never clicks action-named toggles", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div class="collapsible-panel-title" id="contactHdr">Contact Information
        <i class="collapse-indicator" aria-expanded="false"></i>
      </div>
      <div class="collapse" id="contactBody" style="display:none">
        <label>Address 1<input id="AddressLine1" required /></label>
      </div>
      <!-- UKG live shape: the chevron is a SIBLING of the header, not inside it -->
      <div class="panel-heading">
        <h2 class="collapsible-panel-title" id="skillsHdr">Skills</h2>
        <i class="collapse-indicator" aria-expanded="false" style="display:none"></i>
      </div>
      <div class="collapse" id="SkillsBody" style="display:none">
        <textarea id="SkillsText"></textarea>
      </div>
      <button aria-expanded="false" id="danger">Submit application</button>
      <script>
        document.getElementById('contactHdr').addEventListener('click', () => {
          const b = document.getElementById('contactBody');
          b.style.display = 'block';
          document.querySelector('#contactHdr [aria-expanded]').setAttribute('aria-expanded', 'true');
        });
        document.getElementById('skillsHdr').addEventListener('click', () => {
          document.getElementById('SkillsBody').style.display = 'block';
          document.querySelector('.panel-heading [aria-expanded]').setAttribute('aria-expanded', 'true');
        });
        document.getElementById('danger').addEventListener('click', () => {
          (globalThis).__submitClicked = true;
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await expandCollapsedSections(page, { settleMs: 0 });
      expect(r.clicked).toBe(2);
      expect(r.notes.join(" ")).toMatch(/expanded 2 collapsed section/);
      expect(await page.locator("#AddressLine1").isVisible()).toBe(true);
      expect(await page.locator("#SkillsBody").isVisible()).toBe(true);
      expect(
        await page.evaluate(
          () => (globalThis as unknown as { __submitClicked?: boolean }).__submitClicked,
        ),
      ).toBeUndefined();
      // Second call is a no-op — everything is already expanded.
      const again = await expandCollapsedSections(page, { settleMs: 0 });
      expect(again.clicked).toBe(0);
    });
  }, 30_000);

  // #145 (live UKG OpportunityApply 2026-09-01): sections are read-only
  // until their "Edit <Section>" button mounts the controls + Save.
  it("#145 opens Edit-named section editors, saves them after, never touches other actions", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div class="section">
        <span>Shubham Kale</span>
        <collapsible-panel-button>
          <button data-automation="primary-action-button" aria-label="Edit Contact Information">✎</button>
        </collapsible-panel-button>
        <button data-automation="primary-action-button" aria-label="Delete profile">🗑</button>
        <div id="editor" style="display:none">
          <label>City<input id="City" /></label>
          <button data-automation="save-button" id="save">Save</button>
        </div>
      </div>
      <script>
        document.querySelector('[aria-label="Edit Contact Information"]').addEventListener('click', () => {
          document.getElementById('editor').style.display = 'block';
        });
        document.querySelector('[aria-label="Delete profile"]').addEventListener('click', () => {
          (globalThis).__deleted = true;
        });
        document.getElementById('save').addEventListener('click', () => {
          document.getElementById('editor').style.display = 'none';
          (globalThis).__saved = ((globalThis).__saved || 0) + 1;
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const cfg = {
        trigger:
          "button[data-automation='primary-action-button'], collapsible-panel-button button",
        triggerNamePattern: /^(edit|add)\b/i,
        save: "button[data-automation='save-button']",
        saveNamePattern: /^save$/i,
      };
      const opened = await openSectionEditors(page, cfg, { settleMs: 0 });
      expect(opened.clicked).toBe(1);
      expect(opened.notes.join(" ")).toMatch(/Edit Contact Information/);
      expect(await page.locator("#City").isVisible()).toBe(true);
      expect(
        await page.evaluate(
          () => (globalThis as unknown as { __deleted?: boolean }).__deleted,
        ),
      ).toBeUndefined();
      await page.locator("#City").fill("Baltimore");
      const saved = await saveOpenSectionEditors(page, cfg, { settleMs: 0 });
      expect(saved.clicked).toBe(1);
      expect(
        await page.evaluate(
          () => (globalThis as unknown as { __saved?: number }).__saved,
        ),
      ).toBe(1);
    });
  }, 30_000);

  // #145c (live UKG run 16): editors are strictly ONE at a time — every
  // other pencil is disabled while one is open, so a blanket open pass can
  // only ever reach the first. The walk must cycle open → fill → save per
  // editor, dedupe by name, and stop when nothing new opens.
  it("#145c cycles one-at-a-time section editors: open, fill, save, next", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div id="s1">
        <button data-automation="primary-action-button" aria-label="Edit Contact Information">✎</button>
        <div class="editor" style="display:none">
          <label>City<input id="City" /></label>
          <button data-automation="save-button">Save</button>
        </div>
      </div>
      <div id="s2">
        <button data-automation="primary-action-button" aria-label="Edit Skills">✎</button>
        <div class="editor" style="display:none">
          <label>Skills<input id="Skills" /></label>
          <button data-automation="save-button">Save</button>
        </div>
      </div>
      <button data-automation="primary-action-button" aria-label="Delete profile">🗑</button>
      <script>
        const pencils = [...document.querySelectorAll('[aria-label^="Edit"]')];
        const setOthers = (self, disabled) =>
          pencils.forEach((p) => { if (p !== self) p.disabled = disabled; });
        pencils.forEach((p) => {
          const section = p.parentElement;
          const editor = section.querySelector('.editor');
          p.addEventListener('click', () => {
            editor.style.display = 'block';
            p.disabled = true;
            setOthers(p, true);
          });
          editor.querySelector('[data-automation="save-button"]').addEventListener('click', () => {
            editor.style.display = 'none';
            p.disabled = false;
            setOthers(p, false);
            globalThis.__saved = (globalThis.__saved || 0) + 1;
          });
        });
        document.querySelector('[aria-label="Delete profile"]').addEventListener('click', () => {
          globalThis.__deleted = true;
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const seen: string[] = [];
      const walk = await walkSectionEditors(
        page,
        async ({ page: p }) => {
          const visible: string[] = [];
          for (const id of ["City", "Skills"]) {
            if (await p.locator(`#${id}`).isVisible()) {
              visible.push(id);
              await p.locator(`#${id}`).fill("x");
            }
          }
          seen.push(visible.join(","));
          return { fillable: 1, filled: visible.length, verifyPassed: true };
        },
        genericSelectorsV1.sectionEditors,
        { settleMs: 0 },
      );
      expect(walk.editors).toBe(2);
      // Each fill saw exactly ONE editor's controls — never both at once.
      expect(seen).toEqual(["City", "Skills"]);
      expect(
        await page.evaluate(
          () => (globalThis as unknown as { __saved?: number }).__saved,
        ),
      ).toBe(2);
      expect(
        await page.evaluate(
          () => (globalThis as unknown as { __deleted?: boolean }).__deleted,
        ),
      ).toBeUndefined();
      expect(walk.notes.join(" ")).toMatch(/cycled 2 editor/);
    });
  }, 30_000);

  it("#145c releases an editor whose Save is refused via Cancel, then continues", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div id="s1">
        <button data-automation="primary-action-button" aria-label="Add Work Experience">+</button>
        <div class="editor" style="display:none">
          <label>Employer<input id="Employer" required /></label>
          <div class="error" role="alert" style="display:none">Employer is required</div>
          <button data-automation="save-button">Save</button>
          <button id="cancel1">Cancel</button>
        </div>
      </div>
      <div id="s2">
        <button data-automation="primary-action-button" aria-label="Edit Skills">✎</button>
        <div class="editor" style="display:none">
          <label>Skills<input id="Skills" /></label>
          <button data-automation="save-button">Save</button>
        </div>
      </div>
      <script>
        const pencils = [...document.querySelectorAll('[data-automation="primary-action-button"]')];
        const setOthers = (self, disabled) =>
          pencils.forEach((p) => { if (p !== self) p.disabled = disabled; });
        pencils.forEach((p) => {
          const section = p.parentElement;
          const editor = section.querySelector('.editor');
          const close = () => { editor.style.display = 'none'; p.disabled = false; setOthers(p, false); };
          p.addEventListener('click', () => { editor.style.display = 'block'; p.disabled = true; setOthers(p, true); });
          editor.querySelector('[data-automation="save-button"]').addEventListener('click', () => {
            const req = editor.querySelector('[required]');
            if (req && !req.value) { editor.querySelector('.error').style.display = 'block'; return; }
            close();
            globalThis.__saved = (globalThis.__saved || 0) + 1;
          });
          const c = editor.querySelector('#cancel1');
          if (c) c.addEventListener('click', () => { close(); globalThis.__cancelled = true; });
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const walk = await walkSectionEditors(
        page,
        async ({ page: p }) => {
          // Only Skills is fillable from the profile; Employer stays empty.
          const skills = p.locator("#Skills");
          const filled = (await skills.isVisible()) ? 1 : 0;
          if (filled) await skills.fill("x");
          return { fillable: 1, filled, verifyPassed: filled === 1 };
        },
        genericSelectorsV1.sectionEditors,
        { settleMs: 0 },
      );
      expect(walk.editors).toBe(2);
      expect(walk.notes.join(" ")).toMatch(/save did not close the editor — page says: Employer is required/);
      expect(walk.notes.join(" ")).toMatch(/released the stuck editor via Cancel/);
      expect(
        await page.evaluate(() => (globalThis as unknown as { __cancelled?: boolean }).__cancelled),
      ).toBe(true);
      expect(
        await page.evaluate(() => (globalThis as unknown as { __saved?: number }).__saved),
      ).toBe(1);
      // Every pencil is enabled again — nothing left the page wedged.
      expect(await page.locator('[aria-label="Edit Skills"]').isDisabled()).toBe(false);
    });
  }, 30_000);

  // Live UKG run 18 (#151): the resume parser emitted a fragment
  // work-experience row (employer "Gloria", no title); Save refused with
  // "Experience job title must not be empty." and the Cancel release then
  // discarded every correct row. The fragment row is removed with the
  // page's own "Delete Work Experience 4", Save retried, editor closes.
  it("#151 removes a parsed history row whose required control nothing can fill, then Save succeeds", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div id="s1">
        <button data-automation="primary-action-button" aria-label="Edit Contact Information">✎</button>
        <div class="editor" style="display:none">
          <div class="row">
            <label>Job Title<input id="NewWorkExperience_JobTitle0" required value="Software Engineer" /></label>
            <label>Company / Organization<input id="NewWorkExperience_Organization0" required value="Summer Atlantic" /></label>
            <button type="button" data-automation="remove-button" aria-label="Delete Work Experience 1">x</button>
          </div>
          <div class="row">
            <label>Job Title<input id="NewWorkExperience_JobTitle1" required /></label>
            <label>Company / Organization<input id="NewWorkExperience_Organization1" required value="Gloria" /></label>
            <button type="button" data-automation="remove-button" aria-label="Delete Work Experience 2">x</button>
          </div>
          <div class="error" role="alert" style="display:none">Experience job title must not be empty.</div>
          <button data-automation="save-button">Save and continue</button>
          <button id="cancel1">Cancel</button>
        </div>
      </div>
      <script>
        const pencil = document.querySelector('[data-automation="primary-action-button"]');
        const editor = document.querySelector('.editor');
        const close = () => { editor.style.display = 'none'; pencil.disabled = false; };
        pencil.addEventListener('click', () => { editor.style.display = 'block'; pencil.disabled = true; });
        editor.querySelector('[data-automation="save-button"]').addEventListener('click', () => {
          const empty = [...editor.querySelectorAll('[required]')].find((r) => !r.value);
          if (empty) { editor.querySelector('.error').style.display = 'block'; return; }
          close();
          globalThis.__saved = (globalThis.__saved || 0) + 1;
        });
        editor.querySelectorAll('[data-automation="remove-button"]').forEach((b) => {
          b.addEventListener('click', () => {
            b.closest('.row').remove();
            globalThis.__removed = [...(globalThis.__removed || []), b.getAttribute('aria-label')];
          });
        });
        editor.querySelector('#cancel1').addEventListener('click', () => { close(); globalThis.__cancelled = true; });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const walk = await walkSectionEditors(
        page,
        async () => ({ fillable: 0, filled: 0, verifyPassed: true }),
        genericSelectorsV1.sectionEditors,
        { settleMs: 0 },
      );
      expect(walk.editors).toBe(1);
      const joined = walk.notes.join(" ");
      expect(joined).toMatch(/page says: Experience job title must not be empty/);
      expect(joined).toMatch(/removed employment row 1 via "Delete Work Experience 2"/);
      expect(joined).toMatch(/save succeeded after removing the incomplete row/);
      expect(joined).not.toMatch(/via Cancel/);
      const state = await page.evaluate(() => {
        const g = globalThis as unknown as { __saved?: number; __removed?: string[]; __cancelled?: boolean };
        return { saved: g.__saved, removed: g.__removed, cancelled: g.__cancelled };
      });
      expect(state).toEqual({ saved: 1, removed: ["Delete Work Experience 2"], cancelled: undefined });
      // The complete row stands.
      expect(await page.locator("#NewWorkExperience_JobTitle0").count()).toBe(1);
    });
  }, 30_000);

  // Live UKG run 20 (#152): the resume-review page shows "Add Experience"
  // beside four parsed rows; the walk clicked it and a blank row nothing
  // truthful could fill was born. An Add is only for an EMPTY section.
  it("#152 skips an Add trigger whose section already holds entries, still opens an empty section's Add", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div id="work">
        <button data-automation="primary-action-button" aria-label="Add Experience">+</button>
        <div class="row">
          <label>Job Title<input id="NewWorkExperience_JobTitle0" value="Software Engineer" /></label>
          <button type="button" data-automation="remove-button" aria-label="Delete Work Experience 1">x</button>
        </div>
        <div class="entry">Co-Founder, Open Health Intelligence
          <button type="button" data-automation="edit-button" aria-label="Edit Experience Item 2">✎</button>
        </div>
      </div>
      <div id="edu">
        <button data-automation="primary-action-button" aria-label="Add Education">+</button>
        <div class="editor" style="display:none">
          <label>School<input id="NewEducation_SchoolId0" /></label>
          <button data-automation="save-button">Save</button>
        </div>
      </div>
      <script>
        document.querySelector('[aria-label="Add Experience"]').addEventListener('click', () => { globalThis.__addedRow = true; });
        const edu = document.querySelector('#edu');
        edu.querySelector('[aria-label="Add Education"]').addEventListener('click', () => { edu.querySelector('.editor').style.display = 'block'; });
        edu.querySelector('[data-automation="save-button"]').addEventListener('click', () => { edu.querySelector('.editor').style.display = 'none'; globalThis.__saved = 1; });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const walk = await walkSectionEditors(
        page,
        async ({ page: p }) => {
          await p.locator("#NewEducation_SchoolId0").fill("Johns Hopkins University");
          return { fillable: 1, filled: 1, verifyPassed: true };
        },
        genericSelectorsV1.sectionEditors,
        { settleMs: 0 },
      );
      expect(walk.editors).toBe(1);
      const joined = walk.notes.join(" ");
      expect(joined).toMatch(/skipped "Add Experience" — the employment section already holds 2 entry/);
      expect(joined).toMatch(/opened "Add Education"/);
      const state = await page.evaluate(() => {
        const g = globalThis as unknown as { __addedRow?: boolean; __saved?: number };
        return { addedRow: g.__addedRow, saved: g.__saved };
      });
      expect(state).toEqual({ addedRow: undefined, saved: 1 });
    });
  }, 30_000);

  it("does not click when a real submit control is already visible", async () => {
    const html = `<form>
      <input name="first_name" />
      <button type="submit">Submit application</button>
    </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      let fills = 0;
      const walk = await walkGenericFormPages(page, async () => {
        fills += 1;
        return { fillable: 1, filled: 1, verifyPassed: true };
      });
      expect(fills).toBe(0);
      expect(walk.pages).toHaveLength(0);
      expect(walk.notes.join(" ")).toMatch(/leaving it for the gated submit path/);
    });
  }, 30_000);
});
