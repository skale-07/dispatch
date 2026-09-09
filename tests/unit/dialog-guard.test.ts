import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { attachDialogGuard } from "../../src/browser/dialogGuard.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";

type FakeDialog = {
  type: () => string;
  message: () => string;
  dismiss: () => Promise<void>;
};

describe("dialog guard (#205)", () => {
  it("dismisses every dialog and swallows a dismiss that fails because the dialog is already gone (UNIT_CONFIRMED)", async () => {
    const ctx = new EventEmitter();
    const detach = attachDialogGuard(ctx as never, "test");
    expect(ctx.listenerCount("dialog")).toBe(1);

    let dismissed = 0;
    const ok: FakeDialog = {
      type: () => "confirm",
      message: () => "Leave this page?",
      dismiss: async () => {
        dismissed += 1;
      },
    };
    // The race the guard exists for: Playwright's dismiss rejects because
    // the page already closed the dialog. Must NOT become an unhandled
    // rejection (vitest fails the run on one).
    const gone: FakeDialog = {
      type: () => "alert",
      message: () => "x".repeat(500),
      dismiss: async () => {
        throw new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing");
      },
    };
    ctx.emit("dialog", ok);
    ctx.emit("dialog", gone);
    await new Promise((r) => setImmediate(r));
    expect(dismissed).toBe(1);

    detach();
    expect(ctx.listenerCount("dialog")).toBe(0);
  });

  it("a fixture page that pops confirm()/alert() keeps running and confirm() reads as declined (FIXTURE_CONFIRMED)", async () => {
    const result = await withFixtureHtmlPage(
      "<html><body><form id='f'><input name='q' value='1'></form></body></html>",
      async (page) => {
        type Dialogs = { confirm: (m: string) => boolean; alert: (m: string) => void };
        const confirmed = await page.evaluate(() =>
          (globalThis as unknown as Dialogs).confirm("Really?"),
        );
        await page.evaluate(() => (globalThis as unknown as Dialogs).alert("done"));
        return { confirmed, value: await page.inputValue("input[name=q]") };
      },
    );
    expect(result).toEqual({ confirmed: false, value: "1" });
  }, 60_000);
});
