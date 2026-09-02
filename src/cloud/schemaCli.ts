import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../config/index.js";
import {
  applyMigrations,
  listMigrationFiles,
  probeSchema,
  projectRefFromUrl,
} from "./schema.js";

/**
 * `npm run cloud:schema -- verify`   read back which expected tables /
 *                                    views / RPCs / buckets exist (read-only;
 *                                    needs SUPABASE_URL + service key).
 * `npm run cloud:schema -- apply`    run supabase/migrations/ through the
 *                                    Management API, then verify. Cloud DDL
 *                                    is a mutation ⇒ SUPABASE_SYNC_ENABLED
 *                                    must be true AND SUPABASE_ACCESS_TOKEN
 *                                    (personal access token) must be set.
 *
 * Prints one JSON document; exit 1 when verification is incomplete or an
 * apply step failed. Never prints a key or token.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "supabase",
  "migrations",
);

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "verify" && mode !== "apply") {
    console.error("usage: npm run cloud:schema -- verify | apply");
    process.exit(2);
  }
  const config = getConfig();
  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) {
    console.error(`cloud:schema needs ${missing.join(", ")} in .env`);
    process.exit(2);
  }
  const url = config.supabaseUrl!;
  const serviceRoleKey = config.supabaseServiceRoleKey!;

  let apply;
  if (mode === "apply") {
    if (!config.supabaseSyncEnabled) {
      console.error(
        "SUPABASE_SYNC_ENABLED is false (fail-closed default). Applying schema mutates the cloud project; set it in .env for this run.",
      );
      process.exit(1);
    }
    if (!config.supabaseAccessToken) {
      console.error(
        "SUPABASE_ACCESS_TOKEN is not set. Create one at supabase.com → Account → Access Tokens and put it in the engine .env (never in the repo).\n" +
          "Alternative without a token: paste each supabase/migrations/*.sql into the dashboard SQL Editor in filename order.",
      );
      process.exit(1);
    }
    const ref = projectRefFromUrl(url);
    if (ref === null) {
      console.error(`SUPABASE_URL does not look like https://<ref>.supabase.co (got ${url})`);
      process.exit(2);
    }
    const migrations = listMigrationFiles(MIGRATIONS_DIR);
    apply = await applyMigrations({
      projectRef: ref,
      accessToken: config.supabaseAccessToken,
      migrations,
    });
  }

  const probe = await probeSchema({ url, serviceRoleKey });
  console.log(
    JSON.stringify(
      {
        project_url: url,
        migrations_dir: MIGRATIONS_DIR,
        ...(apply !== undefined ? { apply } : {}),
        read_back: probe,
        validation_level: probe.complete
          ? apply !== undefined
            ? "LIVE_MUTATION_CONFIRMED"
            : "LIVE_READ_ONLY_CONFIRMED"
          : "INCOMPLETE",
      },
      null,
      2,
    ),
  );
  if (!probe.complete || (apply !== undefined && apply.failed !== null)) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
