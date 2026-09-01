import type { ServerResponse } from "node:http";
import type { Db } from "../storage/db/client.js";
import {
  collectOnboardingChecks,
  summarizeOnboarding,
  type OnboardingSeams,
} from "./onboardingStatus.js";
import type { Route } from "./routes.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

/**
 * Onboarding readiness for the /welcome flow. GET-only by construction —
 * onboarding never writes credentials or profiles server-side; the page
 * shows the documented CLI commands and this endpoint verifies what they
 * left on disk (fail-closed: can't-check reports "unknown", never "ok").
 */
export function buildOnboardingRoutes(deps: {
  db: Db;
  seams?: OnboardingSeams;
}): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/onboarding/status",
      handler: async ({ res }) => {
        const checks = await collectOnboardingChecks(deps.db, deps.seams ?? {});
        json(res, 200, summarizeOnboarding(checks));
      },
    },
  ];
}
