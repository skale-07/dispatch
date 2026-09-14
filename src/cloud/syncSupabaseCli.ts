import { closeDatabase, migrate, openDatabase } from "../storage/db/client.js";
import { runFieldSignalsPush } from "./fieldSignals.js";
import {
  runProfilesPull,
  runReceiptsPush,
  runSupabaseSync,
} from "./syncSupabase.js";

/**
 * `npm run cloud:sync [-- --pull] [--no-receipts] [--no-signals]`
 *
 * One bounded pass, fail-closed behind SUPABASE_SYNC_ENABLED + the three
 * SUPABASE_* settings (refuses loudly by name otherwise). Default: push
 * status mirror + push submission receipts + push field signals (which
 * questions forms asked and how often they went unanswered — never an
 * answer; plan M21, `--no-signals` opts out). `--pull` additionally pulls
 * onboarded users' wizard profiles into a snapshot under
 * private/cloud/users/ (PII of users who submitted it — private/, never
 * artifacts/). No polling loop here — schedule reruns explicitly.
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const db = openDatabase();
  try {
    migrate(db);
    const status = await runSupabaseSync({ db });
    const receipts = args.has("--no-receipts")
      ? undefined
      : await runReceiptsPush({ db });
    const signals = args.has("--no-signals") ? undefined : await runFieldSignalsPush({ db });
    let pull;
    if (args.has("--pull")) {
      const { users: _users, ...summary } = await runProfilesPull({});
      pull = summary; // print counts + snapshot path, never profile contents
    }
    console.log(
      JSON.stringify(
        {
          status_push: status,
          ...(receipts !== undefined ? { receipts_push: receipts } : {}),
          ...(signals !== undefined ? { signals_push: signals } : {}),
          ...(pull !== undefined ? { profiles_pull: pull } : {}),
        },
        null,
        2,
      ),
    );
  } finally {
    closeDatabase(db);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
