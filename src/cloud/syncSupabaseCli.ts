import { closeDatabase, migrate, openDatabase } from "../storage/db/client.js";
import { runSupabaseSync } from "./syncSupabase.js";

/**
 * `npm run cloud:sync` — one-shot, one-way status mirror to Supabase.
 * Fail-closed: refuses unless SUPABASE_SYNC_ENABLED plus all SUPABASE_*
 * settings are present in .env. One run = one bounded pass (no polling
 * loop here — schedule reruns explicitly, e.g. alongside auto:cycle).
 */
async function main(): Promise<void> {
  const db = openDatabase();
  try {
    migrate(db);
    const result = await runSupabaseSync({ db });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    closeDatabase(db);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
