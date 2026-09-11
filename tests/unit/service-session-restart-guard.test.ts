import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * #250: a failed CDP attach restarts the debug Chrome — but the restart
 * always kills the APPLIER's profile. An attach to a different endpoint
 * (the dedicated outreach Chrome, #233) must never reach it, or a wedged
 * Gmail window kills a live fill.
 */
const { restart, connect } = vi.hoisted(() => ({
  restart: vi.fn(async () => ({ reachable: false, launched: false, notes: [] as string[] })),
  connect: vi.fn(async () => {
    throw new Error("ws handshake timed out");
  }),
}));

vi.mock("../../src/automation/cdpChrome.js", () => ({ restartCdpChrome: restart }));
vi.mock("playwright", async (importOriginal) => {
  const actual = await importOriginal<typeof import("playwright")>();
  return { ...actual, chromium: { connectOverCDP: connect } };
});

const { PlaywrightServiceSession } = await import("../../src/auth/serviceSession.js");

describe("serviceSession CDP restart guard (#250)", () => {
  const saved = process.env.AGENT_CDP_URL;
  beforeEach(() => {
    process.env.AGENT_CDP_URL = "http://127.0.0.1:9222";
    resetConfigCache();
    restart.mockClear();
    connect.mockClear();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_CDP_URL;
    else process.env.AGENT_CDP_URL = saved;
    resetConfigCache();
  });

  it("never restarts the applier Chrome when a DIFFERENT endpoint fails to attach", async () => {
    const session = new PlaywrightServiceSession({
      service: "jobright",
      mode: "CDP_ATTACH",
      cdpUrl: "http://127.0.0.1:9223",
      skipAuthValidation: true,
    });
    await expect(session.open()).rejects.toThrow(/127\.0\.0\.1:9223 is unresponsive.*chrome:debug:gmail/);
    expect(restart).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("still attempts the bounded restart when the applier's own endpoint fails", async () => {
    const session = new PlaywrightServiceSession({
      service: "jobright",
      mode: "CDP_ATTACH",
      skipAuthValidation: true,
    });
    await expect(session.open()).rejects.toThrow(/127\.0\.0\.1:9222 is unresponsive.*chrome:debug:jobright/);
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
