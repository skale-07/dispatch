/**
 * Posting-age policy (#199, operator directive 2026-09-08): "if the
 * application was published over 24hrs ago it's not worth applying to; if
 * an app in the queue is older than 24hrs then don't apply."
 *
 * JobRight carries no structured posted-at. Its card/detail text shows a
 * relative age ("5 hours ago", "2 days ago") that the detail reader keeps
 * in `description_text`; the job row's `created_at` is when that text was
 * read. posted_at ≈ created_at − age. Everything here is pure and
 * deterministic; the callers decide what the verdict gates.
 */

export const MAX_POSTING_AGE_HOURS = 24;

const AGO_RE =
  /\b(\d{1,3}|a|an|one)\s+(minute|min|hour|hr|day|week|month)s?\s+ago\b/i;

const UNIT_MINUTES: Record<string, number> = {
  minute: 1,
  min: 1,
  hour: 60,
  hr: 60,
  day: 24 * 60,
  week: 7 * 24 * 60,
  month: 30 * 24 * 60,
};

/** "5 hours ago" → 300; "just now"/"today" and absent text → null (unknown, never stale). */
export function parsePostedAgoMinutes(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = AGO_RE.exec(text);
  if (!m) return null;
  const n = /^(a|an|one)$/i.test(m[1]!) ? 1 : Number(m[1]);
  const unit = UNIT_MINUTES[m[2]!.toLowerCase()];
  if (!Number.isFinite(n) || unit === undefined) return null;
  return n * unit;
}

export type PostingAgeVerdict = {
  stale: boolean;
  /** Hours since the posting was published, when derivable. */
  posting_age_hours: number | null;
  /** Hours since the application row was enqueued, when supplied. */
  queue_age_hours: number | null;
  reason: string;
};

/**
 * Stale when EITHER the posting was published more than the cap ago OR
 * the application has sat in the queue longer than the cap. Unknown
 * posting age is not stale on its own (fail-open on evidence the feed
 * did not give us; the queue-age half still applies).
 */
export function judgePostingAge(input: {
  descriptionText: string | null | undefined;
  jobCreatedAt: string | Date | null | undefined;
  appCreatedAt?: string | Date | null | undefined;
  now?: Date;
  maxAgeHours?: number;
}): PostingAgeVerdict {
  const now = input.now ?? new Date();
  const cap = input.maxAgeHours ?? MAX_POSTING_AGE_HOURS;
  const toDate = (v: string | Date | null | undefined): Date | null => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const hoursSince = (d: Date | null): number | null =>
    d ? Math.round(((now.getTime() - d.getTime()) / 36e5) * 10) / 10 : null;

  const agoMin = parsePostedAgoMinutes(input.descriptionText);
  const seenAt = toDate(input.jobCreatedAt);
  const postedAt =
    agoMin !== null && seenAt ? new Date(seenAt.getTime() - agoMin * 60_000) : null;
  const postingAge = hoursSince(postedAt);
  const queueAge = hoursSince(toDate(input.appCreatedAt));

  if (postingAge !== null && postingAge > cap) {
    return {
      stale: true,
      posting_age_hours: postingAge,
      queue_age_hours: queueAge,
      reason: `posting published ${postingAge}h ago (> ${cap}h; operator policy 2026-09-08)`,
    };
  }
  if (queueAge !== null && queueAge > cap) {
    return {
      stale: true,
      posting_age_hours: postingAge,
      queue_age_hours: queueAge,
      reason: `queued ${queueAge}h ago (> ${cap}h; operator policy 2026-09-08)`,
    };
  }
  return {
    stale: false,
    posting_age_hours: postingAge,
    queue_age_hours: queueAge,
    reason:
      postingAge === null
        ? "posting age unknown (no relative time in the posting text)"
        : `posting published ${postingAge}h ago`,
  };
}
