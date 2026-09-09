import { describe, expect, it } from "vitest";
import {
  isNetworkOutageError,
  waitForConnectivity,
} from "../../src/automation/connectivity.js";

describe("connectivity guard (#203, UNIT_CONFIRMED)", () => {
  it("names transport-level outages and nothing else", () => {
    expect(
      isNetworkOutageError(
        'page.goto: net::ERR_INTERNET_DISCONNECTED at https://jobright.ai/jobs/recommend\nCall log:',
      ),
    ).toBe(true);
    expect(isNetworkOutageError("net::ERR_NAME_NOT_RESOLVED at https://x")).toBe(true);
    expect(isNetworkOutageError("getaddrinfo ENOTFOUND api.example.com")).toBe(true);
    // A site problem is not an outage: the next app may be on another host.
    expect(isNetworkOutageError("page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE")).toBe(false);
    expect(isNetworkOutageError("Timeout 30000ms exceeded waiting for selector")).toBe(false);
    expect(isNetworkOutageError("CDP session won't attach")).toBe(false);
  });

  it("returns on the first successful probe without sleeping", async () => {
    let slept = 0;
    const r = await waitForConnectivity({
      attempts: 5,
      intervalMs: 1000,
      probe: async () => true,
      sleep: async () => {
        slept += 1;
      },
    });
    expect(r).toEqual({ online: true, probes: 1, waited_ms: 0 });
    expect(slept).toBe(0);
  });

  it("stops at the attempt cap and reports the wait it spent", async () => {
    const sleeps: number[] = [];
    let probes = 0;
    const r = await waitForConnectivity({
      attempts: 3,
      intervalMs: 250,
      probe: async () => {
        probes += 1;
        return false;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(probes).toBe(3);
    // No sleep after the final probe — the cap is the cap.
    expect(sleeps).toEqual([250, 250]);
    expect(r).toEqual({ online: false, probes: 3, waited_ms: 500 });
  });

  it("recovers when the link comes back inside the cap", async () => {
    let n = 0;
    const r = await waitForConnectivity({
      attempts: 4,
      intervalMs: 10,
      probe: async () => ++n >= 3,
      sleep: async () => undefined,
    });
    expect(r).toEqual({ online: true, probes: 3, waited_ms: 20 });
  });
});
