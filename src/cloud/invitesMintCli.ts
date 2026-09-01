import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import { closeDatabase, migrate, openDatabase } from "../storage/db/client.js";
import {
  DEFAULT_QUOTA,
  invitesToCsv,
  invitesToSupabaseSql,
  mintInvites,
  persistInvites,
} from "./invites.js";

/**
 * `npm run invites:mint -- --count N [--quota M] [--base-url URL]
 *    [--issuer NAME] [--note TEXT]`
 *
 * Mints invite codes + shareable links, records them in the local
 * `cloud_invites` table, and writes SQL + CSV exports under
 * `private/cloud/invites/` (gitignored — codes are secrets until
 * redeemed) for loading into Supabase. Local-only: no network, no
 * capability flag. Base URL comes from --base-url or CLOUD_BASE_URL.
 */

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const count = Number(flags["count"] ?? "");
  const quota = flags["quota"] !== undefined ? Number(flags["quota"]) : DEFAULT_QUOTA;
  const baseUrl = flags["base-url"] ?? process.env["CLOUD_BASE_URL"];

  if (!Number.isFinite(count)) {
    console.error(
      "usage: npm run invites:mint -- --count N [--quota M] [--base-url https://your-domain.example]",
    );
    process.exit(2);
  }
  if (baseUrl === undefined || baseUrl.trim() === "") {
    console.error(
      "No base URL. Pass --base-url https://<your-domain> (or set CLOUD_BASE_URL in .env).\n" +
        "Invite links embed it: <base-url>/redeem?code=<CODE>",
    );
    process.exit(2);
  }

  const minted = mintInvites({
    count,
    quota,
    baseUrl,
    ...(flags["issuer"] !== undefined ? { issuer: flags["issuer"] } : {}),
    ...(flags["note"] !== undefined ? { note: flags["note"] } : {}),
  });

  const db = openDatabase();
  try {
    migrate(db);
    persistInvites(db, minted);
  } finally {
    closeDatabase(db);
  }

  const outDir = path.join(getConfig().privateDir, "cloud", "invites");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sqlPath = path.join(outDir, `invites-${stamp}.sql`);
  const csvPath = path.join(outDir, `invites-${stamp}.csv`);
  fs.writeFileSync(sqlPath, invitesToSupabaseSql(minted), "utf8");
  fs.writeFileSync(csvPath, invitesToCsv(minted), "utf8");

  console.log(
    `Minted ${minted.length} invite(s), quota ${minted[0]?.maxCompletedApplications} completed application(s) each.`,
  );
  console.log(`Local ledger: cloud_invites table (${getConfig().databasePath})`);
  console.log(`Supabase SQL: ${sqlPath}`);
  console.log(`CSV:          ${csvPath}`);
  console.log("");
  for (const inv of minted) {
    console.log(`  ${inv.code}  ${inv.link}`);
  }
  console.log("");
  console.log(
    "Load the SQL into Supabase (SQL editor or psql). Links are shareable as-is.",
  );
}

main();
