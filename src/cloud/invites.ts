import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";

/**
 * Invite minting (cloud plane v0, docs/roadmap/cloud-deploy.md).
 *
 * Codes are minted HERE, on the engine machine, recorded in the local
 * `cloud_invites` table (the ledger), and exported as plain SQL/CSV the
 * operator loads into Supabase until service keys exist. Redemption and
 * quota accounting happen cloud-side (supabase/migrations —
 * `redeem_invite` RPC + `user_quota_status` view); the quota unit is
 * COMPLETED applications counted against the invite.
 *
 * Everything in this module is local: no network, no capability flag
 * needed. Exports go under `private/cloud/invites/` — never `artifacts/`,
 * which ARTIFACT_AUTOPUSH_ENABLED may push to a remote; unredeemed codes
 * are secrets.
 */

/** Crockford-ish base32 without lookalikes (0/O, 1/I/L) or U. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_PREFIX = "JRA";
const CODE_GROUPS = 2;
const CODE_GROUP_LEN = 4;

export const DEFAULT_QUOTA = 5;
/** Matches the CHECK constraint in supabase/migrations (1..100). */
export const QUOTA_MIN = 1;
export const QUOTA_MAX = 100;
export const MAX_MINT_COUNT = 200;

export type MintedInvite = {
  id: string;
  code: string;
  issuer: string;
  maxCompletedApplications: number;
  baseUrl: string;
  link: string;
  note: string | null;
  createdAt: string;
};

export function generateInviteCode(
  random: (bytes: number) => Buffer = randomBytes,
): string {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g += 1) {
    const buf = random(CODE_GROUP_LEN);
    let group = "";
    for (let i = 0; i < CODE_GROUP_LEN; i += 1) {
      group += CODE_ALPHABET[(buf[i] ?? 0) % CODE_ALPHABET.length];
    }
    groups.push(group);
  }
  return [CODE_PREFIX, ...groups].join("-");
}

/** `<base>/redeem?code=<CODE>` — the shape the frontend contract documents. */
export function buildInviteLink(baseUrl: string, code: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(trimmed)) {
    throw new Error(
      `base URL must be an absolute http(s) URL (got: ${baseUrl})`,
    );
  }
  return `${trimmed}/redeem?code=${encodeURIComponent(code)}`;
}

export function mintInvites(options: {
  count: number;
  quota?: number;
  baseUrl: string;
  issuer?: string;
  note?: string;
  now?: () => Date;
  random?: (bytes: number) => Buffer;
}): MintedInvite[] {
  const quota = options.quota ?? DEFAULT_QUOTA;
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > MAX_MINT_COUNT) {
    throw new Error(`--count must be an integer 1..${MAX_MINT_COUNT}`);
  }
  if (!Number.isInteger(quota) || quota < QUOTA_MIN || quota > QUOTA_MAX) {
    throw new Error(`--quota must be an integer ${QUOTA_MIN}..${QUOTA_MAX}`);
  }
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const issuer = options.issuer?.trim() || "operator";
  const invites: MintedInvite[] = [];
  const seen = new Set<string>();
  while (invites.length < options.count) {
    const code = generateInviteCode(options.random);
    if (seen.has(code)) continue; // astronomically unlikely; bounded by count
    seen.add(code);
    invites.push({
      id: randomUUID(),
      code,
      issuer,
      maxCompletedApplications: quota,
      baseUrl: options.baseUrl,
      link: buildInviteLink(options.baseUrl, code),
      note: options.note ?? null,
      createdAt,
    });
  }
  return invites;
}

export function persistInvites(db: Db, invites: MintedInvite[]): void {
  const insert = db.prepare(
    `INSERT INTO cloud_invites
       (id, code, issuer, max_completed_applications, base_url, link, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const run = db.transaction(() => {
    for (const inv of invites) {
      insert.run(
        inv.id,
        inv.code,
        inv.issuer,
        inv.maxCompletedApplications,
        inv.baseUrl,
        inv.link,
        inv.note,
        inv.createdAt,
      );
    }
  });
  run();
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Plain INSERTs against `public.invites` (supabase/migrations schema),
 * pasteable into the dashboard SQL editor. ON CONFLICT keeps a re-paste
 * harmless.
 */
export function invitesToSupabaseSql(invites: MintedInvite[]): string {
  const lines = [
    "-- Minted on the engine machine by `npm run invites:mint`.",
    "-- Paste into the Supabase SQL editor (or psql) to load these invites.",
  ];
  for (const inv of invites) {
    const note = inv.note === null ? "null" : sqlString(inv.note);
    lines.push(
      `insert into public.invites (code, issuer, max_completed_applications, note)` +
        ` values (${sqlString(inv.code)}, ${sqlString(inv.issuer)}, ` +
        `${inv.maxCompletedApplications}, ${note}) on conflict (code) do nothing;`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function invitesToCsv(invites: MintedInvite[]): string {
  const rows = [
    "code,issuer,max_completed_applications,link,created_at",
    ...invites.map((inv) =>
      [
        inv.code,
        inv.issuer,
        String(inv.maxCompletedApplications),
        inv.link,
        inv.createdAt,
      ]
        .map(csvField)
        .join(","),
    ),
  ];
  return `${rows.join("\n")}\n`;
}
