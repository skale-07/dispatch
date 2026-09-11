import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * #258 (night30, OOM): a CDP_ATTACH session's close() only disconnected,
 * so every page it opened stayed in the operator's Chrome — 13 stale
 * application tabs after four hours, until the box ran out of memory. It
 * now closes exactly the pages it opened (and their popups), and never a
 * tab it did not open.
 */
type FakePage = {
  closed: boolean;
  close: () => Promise<void>;
  on: (ev: string, fn: (p: FakePage) => void) => void;
  once: (ev: string, fn: () => void) => void;
  emitPopup: (p: FakePage) => void;
};

const makePage = (): FakePage => {
  const popupHandlers: Array<(p: FakePage) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const page: FakePage = {
    closed: false,
    close: vi.fn(async () => {
      page.closed = true;
      for (const h of closeHandlers) h();
    }),
    on: (ev, fn) => {
      if (ev === "popup") popupHandlers.push(fn);
    },
    once: (ev, fn) => {
      if (ev === "close") closeHandlers.push(fn);
    },
    emitPopup: (p) => {
      for (const h of popupHandlers) h(p);
    },
  };
  return page;
};

const state = vi.hoisted(() => ({
  operatorTab: null as unknown,
  created: [] as unknown[],
  browserClose: null as unknown,
}));

vi.mock("playwright", async (importOriginal) => {
  const actual = await importOriginal<typeof import("playwright")>();
  return {
    ...actual,
    chromium: {
      connectOverCDP: async () => {
        const context = {
          pages: () => [state.operatorTab],
          newPage: async () => {
            const p = makePage();
            state.created.push(p);
            return p;
          },
          on: () => undefined,
          off: () => undefined,
        };
        return { contexts: () => [context], close: state.browserClose };
      },
    },
  };
});
vi.mock("../../src/browser/dialogGuard.js", () => ({ attachDialogGuard: () => () => undefined }));

const { PlaywrightServiceSession } = await import("../../src/auth/serviceSession.js");

describe("CDP_ATTACH session closes only the pages it opened (#258)", () => {
  beforeEach(() => {
    process.env.AGENT_CDP_URL = "http://127.0.0.1:9222";
    resetConfigCache();
    state.operatorTab = makePage();
    state.created = [];
    state.browserClose = vi.fn(async () => undefined);
  });
  afterEach(() => resetConfigCache());

  it("closes its own pages and their popups, never the operator's tab, then disconnects", async () => {
    const session = new PlaywrightServiceSession({ service: "jobright", mode: "CDP_ATTACH", skipAuthValidation: true });
    await session.open();
    const a = (await session.newPage()) as unknown as FakePage;
    const b = (await session.newPage()) as unknown as FakePage;
    const popup = makePage();
    a.emitPopup(popup); // Apply → new tab
    await b.close(); // already closed by its caller
    await session.close();
    expect(a.closed).toBe(true);
    expect(popup.closed).toBe(true);
    expect((b.close as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((state.operatorTab as FakePage).closed).toBe(false);
    expect(state.browserClose).toHaveBeenCalledTimes(1);
  });
});
