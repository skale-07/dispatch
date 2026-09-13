import { defineConfig } from "vitest/config";
import { heavyTestFiles } from "./scripts/testSplit";

// Two projects, one suite (scripts/testSplit.ts explains the split):
//   fast   pure tests — runs on every commit (npm run test:fast)
//   heavy  browser / CDP / spawned-process / end-to-end files — ~10 min,
//          solo only (npm run test:heavy); a generous timeout so load on
//          this box cannot fake a failure.
// `npm run test` still runs both; `npm run test:gate` picks per change.
const heavy = heavyTestFiles();

export default defineConfig({
  test: {
    environment: "node",
    clearMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "fast",
          include: ["tests/unit/**/*.test.ts"],
          exclude: ["**/node_modules/**", ...heavy],
          // A cold `await import()` of the engine graph or a first DPAPI
          // call can take 5–8 s on this box; at 5 s (vitest's default)
          // that read as a failure. 15 s still catches a real hang.
          testTimeout: 15_000,
        },
      },
      {
        extends: true,
        test: {
          name: "heavy",
          include: heavy,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
