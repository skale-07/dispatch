import { describe, expect, it } from "vitest";
import { discoverFieldsFromHtml, isListingPageChrome } from "../../src/applications/fieldDiscovery.js";

/**
 * #200 (live Daylit / jobs.polymer.co/lendica/41094, 2026-09-08 night27):
 * the page's "Subscribe to updates" modal (CSS-hidden, same document)
 * carried `<input type=email id=careers_page_subscription_email>` and was
 * planned as the applicant's email; and the react-select "Do you now, or
 * will you ever require employment sponsorship…?" (required) discovered
 * as `field_7` while its shorter sibling resolved. Markup below is the
 * live form snapshot's shape. FIXTURE_CONFIRMED.
 */
const POLYMER_HTML = `<!DOCTYPE html><html><body data-controller="subscribe">
<header><a href="/lendica">View jobs</a><button class="job-header__subscribe" data-action="click->subscribe#showSubscriptionModal">Subscribe</button></header>
<div class="subscribe-modal" data-target="subscribe.subscriptionModal">
  <div class="subscribe-modal__ui"><div data-target="subscribe.subscriptionForm">
    <h3 class="subscribe-modal__title">Subscribe to updates</h3>
    <p>Enter an email address to receive updates whenever we post new job openings.</p>
    <form class="subscribe-modal__form" action="/lendica/41094" method="post">
      <label class="label" for="name">Email address</label>
      <input name="email" required="required" data-target="subscribe.email" type="email" id="careers_page_subscription_email">
      <button type="submit" class="submit">Subscribe</button>
    </form>
  </div></div>
</div>
<main>
<h1>Full Stack AI Engineer Co-Op (Northeastern Students only) Spring 2027</h1>
<form class="application-form">
  <div class="css-1uenj4r-FormInput"><div class="css-g40xht-FormLabel"><div class="css-whxii6-FormLabel_Label"><label for="inputName">Name</label><span class="css-i1lemh-FormLabel_RequiredLabel">(required)</span></div></div><input id="inputName" name="27035" type="text"></div>
  <div class="css-1uenj4r-FormInput"><div class="css-g40xht-FormLabel"><div class="css-whxii6-FormLabel_Label"><label for="inputEmailaddress">Email address</label><span class="css-i1lemh-FormLabel_RequiredLabel">(required)</span></div></div><input id="inputEmailaddress" name="27036" type="text"></div>
  <div data-testid="form-select-dropdown" class="css-8bif0p-FormSelect"><div class="css-g40xht-FormLabel"><div class="css-whxii6-FormLabel_Label"><label>Are you legally authorized to work for any employer in the US? </label><span class="css-i1lemh-FormLabel_RequiredLabel">(required)</span></div></div><div class="css-10nd86i css-1x1u478-FormSelect_UI"><div class="css-vj8t7z form-select-ui__control"><div class="css-1hwfws3 form-select-ui__value-container"><div class="css-1492t68 form-select-ui__placeholder">select</div><div class="css-1g6gooi"><div class="form-select-ui__input" style="display: inline-block;"><input autocapitalize="none" autocomplete="off" autocorrect="off" id="react-select-2-input" spellcheck="false" tabindex="0" type="text" aria-autocomplete="list"><div style="position: absolute; top: 0px; left: 0px; visibility: hidden; height: 0px; overflow: scroll; white-space: pre;"></div></div></div></div><div class="css-1wy0on6 form-select-ui__indicators"><span class="css-d8oujb form-select-ui__indicator-separator"></span><div aria-hidden="true" class="css-1ep9fjw form-select-ui__indicator form-select-ui__dropdown-indicator"><svg height="20" width="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M4.516 7.548c0.436-0.446 1.043-0.481 1.576 0l3.908 3.747 3.908-3.747c0.533-0.481 1.141-0.446 1.574 0 0.436 0.445 0.408 1.197 0 1.615-0.406 0.418-4.695 4.502-4.695 4.502-0.217 0.223-0.502 0.335-0.787 0.335s-0.57-0.112-0.789-0.335c0 0-4.287-4.084-4.695-4.502s-0.436-1.17 0-1.615z"></path></svg></div></div></div><input name="27039" type="hidden" value=""></div></div>
  <div data-testid="form-select-dropdown" class="css-8bif0p-FormSelect"><div class="css-g40xht-FormLabel"><div class="css-whxii6-FormLabel_Label"><label>Do you now, or will you ever require employment sponsorship to work in the US?</label><span class="css-i1lemh-FormLabel_RequiredLabel">(required)</span></div></div><div class="css-10nd86i css-1x1u478-FormSelect_UI"><div class="css-vj8t7z form-select-ui__control"><div class="css-1hwfws3 form-select-ui__value-container"><div class="css-1492t68 form-select-ui__placeholder">select</div><div class="css-1g6gooi"><div class="form-select-ui__input" style="display: inline-block;"><input autocapitalize="none" autocomplete="off" autocorrect="off" id="react-select-3-input" spellcheck="false" tabindex="0" type="text" aria-autocomplete="list"><div style="position: absolute; top: 0px; left: 0px; visibility: hidden; height: 0px; overflow: scroll; white-space: pre;"></div></div></div></div><div class="css-1wy0on6 form-select-ui__indicators"><span class="css-d8oujb form-select-ui__indicator-separator"></span><div aria-hidden="true" class="css-1ep9fjw form-select-ui__indicator form-select-ui__dropdown-indicator"><svg height="20" width="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M4.516 7.548c0.436-0.446 1.043-0.481 1.576 0l3.908 3.747 3.908-3.747c0.533-0.481 1.141-0.446 1.574 0 0.436 0.445 0.408 1.197 0 1.615-0.406 0.418-4.695 4.502-4.695 4.502-0.217 0.223-0.502 0.335-0.787 0.335s-0.57-0.112-0.789-0.335c0 0-4.287-4.084-4.695-4.502s-0.436-1.17 0-1.615z"></path></svg></div></div></div><input name="27040" type="hidden" value=""></div></div>
  <div class="css-1uenj4r-FormInput"><div class="css-g40xht-FormLabel"><div class="css-whxii6-FormLabel_Label"><label for="inputReferral">Did someone refer you to this job at Daylit? Please provide their name</label><span class="css-i1lemh-FormLabel_RequiredLabel">(required)</span></div></div><input id="inputReferral" name="27041" type="text"></div>
</form>
</main></body></html>`;

describe("Polymer careers form discovery (#200, FIXTURE_CONFIRMED)", () => {
  it("drops the subscription modal's email input — it is a job-alert signup, not the application", () => {
    const fields = discoverFieldsFromHtml(POLYMER_HTML);
    const ids = fields.map((f) => f.inputId ?? f.id);
    expect(ids).not.toContain("careers_page_subscription_email");
    // The applicant's real Email address is still discovered exactly once.
    expect(fields.filter((f) => /^email address$/i.test(f.label)).length).toBe(1);
  });

  it("labels BOTH react-select questions from their bare <label>, long or short", () => {
    const fields = discoverFieldsFromHtml(POLYMER_HTML);
    const byId = new Map(fields.map((f) => [f.inputId ?? f.id, f.label]));
    expect(byId.get("react-select-2-input")).toMatch(/^Are you legally authorized to work for any employer in the US/);
    expect(byId.get("react-select-3-input")).toMatch(/^Do you now, or will you ever require employment sponsorship to work in the US/);
    // The referral input keeps its own `for` label and never steals a select's.
    expect(byId.get("inputReferral")).toMatch(/^Did someone refer you/);
    expect(fields.some((f) => /^field_\d+$/.test(f.label))).toBe(false);
  });

  it("a subscription-marked wrapper that holds the application is the page, never stripped (live run 4)", () => {
    const wrapped = `<html><body><div class="subscribe-page-wrapper">${POLYMER_HTML.replace(/<!DOCTYPE html><html><body[^>]*>|<\/body><\/html>/g, "")}</div></body></html>`;
    const fields = discoverFieldsFromHtml(wrapped);
    expect(fields.length).toBeGreaterThanOrEqual(5);
    expect(fields.map((f) => f.inputId ?? f.id)).not.toContain("careers_page_subscription_email");
  });

  it("subscription email machine names are listing chrome even when the subtree survives", () => {
    expect(isListingPageChrome({ label: "Email address", inputId: "careers_page_subscription_email", name: "email" })).toBe(true);
    expect(isListingPageChrome({ label: "Email address", inputId: "newsletter_email" })).toBe(true);
    expect(isListingPageChrome({ label: "Email address", inputId: "inputEmailaddress", name: "27036" })).toBe(false);
  });
});
