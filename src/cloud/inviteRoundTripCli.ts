import { getConfig } from "../config/index.js";
import { mintInvites } from "./invites.js";
import { assertCloudWriteConfigured, runInviteRoundTrip } from "./inviteRoundTrip.js";

/**
 * `npm run invites:roundtrip [-- --quota N]`
 *
 * Live proof of the invite lifecycle on the real Supabase project:
 * load -> redeem (as a throwaway user's real JWT) -> quota decrements per
 * COMPLETED mirror row -> exhausted clamps at 0 -> second account refused
 * -> RLS hides other users' rows. Creates and then DELETES one invite and
 * two `invite-roundtrip-*@example.com` auth users. Never touches the local
 * SQLite database. Fail-closed behind SUPABASE_SYNC_ENABLED + SUPABASE_URL
 * + SUPABASE_SERVICE_ROLE_KEY (refuses by name). Prints JSON with a
 * `validation_level`; exit 1 unless every read-back matched.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const qi = argv.indexOf("--quota");
  const quota = qi >= 0 ? Number(argv[qi + 1]) : 2;
  let target;
  try {
    target = assertCloudWriteConfigured(getConfig());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const [invite] = mintInvites({
    count: 1,
    quota,
    baseUrl: "https://roundtrip.invalid",
    issuer: "invites:roundtrip",
    note: "throwaway — deleted by the round-trip proof",
  });
  const result = await runInviteRoundTrip({ target, invite: invite! });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
