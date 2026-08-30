/**
 * JobRight lists Greenhouse jobs with a token-only embed anchor:
 *   https://boards.greenhouse.io/embed/job_app?token=<jobId>&utm_source=jobright&jr_id=…
 * No `?for=<board>` — so the strict validator rejects it, phase A finds no
 * Apply control, and the AGENT phase burns its budget looking for a page
 * Greenhouse would have served directly (night19 2026-08-30: Zipline 83s,
 * Neuralink 54s, Old Mission 195s + budget wall). Greenhouse resolves the
 * board itself: the token-only URL returns the application page whose
 * <form action="/embed/job_app?for=<board>&token=<id>"> names the board.
 *
 * ONE read-only GET (no browser, no mutation, bounded timeout). Returns the
 * canonical `?for=<board>&token=<id>` URL or null; never guesses a board.
 */

export type EmbedFetcher = (url: string) => Promise<{ ok: boolean; text: string } | null>;

const EMBED_HOST_RE = /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/i;

export function tokenOnlyGreenhouseEmbed(href: string): { jobId: string; base: string } | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!EMBED_HOST_RE.test(u.hostname)) return null;
  if (!/\/embed\/job_app\/?$/i.test(u.pathname)) return null;
  const forParam = (u.searchParams.get("for") ?? "").trim();
  if (forParam) return null; // already canonical
  const token = (u.searchParams.get("token") ?? u.searchParams.get("gh_jid") ?? "").trim();
  if (!/^\d+$/.test(token)) return null;
  return { jobId: token, base: `${u.protocol}//${u.hostname}` };
}

/** Board token named by the served embed page (form action / any for= param). */
export function boardTokenFromEmbedHtml(html: string): string | null {
  const action = html.match(/action=["'][^"']*\/embed\/job_app\?[^"']*?\bfor=([a-z0-9][a-z0-9_-]*)/i);
  if (action?.[1]) return action[1].toLowerCase();
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/[?&;]for=([a-z0-9][a-z0-9_-]*)/gi)) {
    const b = m[1]!.toLowerCase();
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [b, n] of counts) {
    if (n > bestN) {
      best = b;
      bestN = n;
    }
  }
  return best;
}

const defaultFetcher: EmbedFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const text = res.ok ? (await res.text()).slice(0, 400_000) : "";
    return { ok: res.ok, text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export async function resolveTokenOnlyGreenhouseEmbed(
  href: string,
  fetcher: EmbedFetcher = defaultFetcher,
): Promise<{ url: string; board: string; note: string } | null> {
  const parsed = tokenOnlyGreenhouseEmbed(href);
  if (!parsed) return null;
  const probeUrl = `https://boards.greenhouse.io/embed/job_app?token=${encodeURIComponent(parsed.jobId)}`;
  const res = await fetcher(probeUrl);
  if (!res || !res.ok) {
    return null;
  }
  const board = boardTokenFromEmbedHtml(res.text);
  if (!board) return null;
  return {
    url: `https://boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${encodeURIComponent(parsed.jobId)}`,
    board,
    note: `phase A: token-only greenhouse embed anchor resolved to board "${board}" (job ${parsed.jobId}) via one read-only GET`,
  };
}
