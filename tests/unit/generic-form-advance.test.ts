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
