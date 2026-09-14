import { toOutreachDraftRow, type OutreachDraftRow } from "../cloud/engineQueue.js";
import type { Db } from "../storage/db/client.js";

/**
 * What the dashboard may know about a tenant's referral drafts (plan
 * M19): THAT a draft exists, for which application, company and contact,
 * with its subject and a draft id to link to — never a body. Read from
 * the tenant's own gmail_drafts (status DRAFTED) after a run.
 *
 * The id is the engine's draft row id; when the drafts-only API transport
 * records Gmail's own draft id in metadata_json.gmail_draft_id, that one
 * is preferred so the dashboard can deep-link into Gmail.
 */
export function selectOutreachDraftRows(db: Db, userId: string, limit = 200): OutreachDraftRow[] {
  const rows = db
    .prepare(
      `SELECT g.id AS row_id, g.application_id, g.subject, g.metadata_json,
              c.name AS contact_name, j.company
       FROM gmail_drafts g
       JOIN contacts c ON c.id = g.contact_id
       JOIN applications a ON a.id = g.application_id
       JOIN jobs j ON j.id = a.job_id
       WHERE g.status = 'DRAFTED'
       ORDER BY g.created_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 1000))) as Array<{
    row_id: string;
    application_id: string;
    subject: string | null;
    metadata_json: string;
    contact_name: string | null;
    company: string | null;
  }>;
  return rows.map((r) => {
    let gmailDraftId: string | null = null;
    try {
      const meta = JSON.parse(r.metadata_json) as { gmail_draft_id?: unknown };
      gmailDraftId = typeof meta.gmail_draft_id === "string" && meta.gmail_draft_id ? meta.gmail_draft_id : null;
    } catch {
      gmailDraftId = null;
    }
    return toOutreachDraftRow({
      userId,
      engineApplicationId: r.application_id,
      company: r.company,
      contactName: r.contact_name,
      subject: r.subject,
      gmailDraftId: gmailDraftId ?? r.row_id,
    });
  });
}
