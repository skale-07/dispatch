/**
 * PDF → resume lines, in the browser (M23 "Fill from resume").
 *
 * pdf.js is bundled (pdfjs-dist) rather than loaded from a CDN because
 * the deployed CSP is `script-src 'self'` (frontend/vercel.json); the
 * worker ships as a same-origin asset through Vite's `?url` import. Both
 * modules are imported lazily so the wizard's bundle does not pay for
 * pdf.js until someone actually clicks the button.
 *
 * The one thing this file adds over pdf.js's own text extraction is
 * LINE reconstruction: text items are grouped by baseline (y) and joined
 * left to right, with a wide horizontal gap rendered as two spaces so a
 * right-aligned date or city becomes a separate column the reader
 * (resumeParse.ts) can split on. A scanned PDF has no text layer and
 * comes back as zero lines; the caller says so instead of guessing.
 */

type TextItemLike = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
};

const MAX_PAGES = 6;

export async function extractPdfLines(data: ArrayBuffer): Promise<string[]> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  try {
    const lines: string[] = [];
    const pages = Math.min(doc.numPages, MAX_PAGES);
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items = (content.items as unknown[]).filter(
        (it): it is TextItemLike =>
          typeof it === "object" && it !== null && typeof (it as TextItemLike).str === "string" && Array.isArray((it as TextItemLike).transform),
      );
      lines.push(...linesFromItems(items));
      page.cleanup();
    }
    return lines;
  } finally {
    await task.destroy();
  }
}

/**
 * Group items into baselines, sort each left to right, and join with a
 * gap-aware separator. Pure so it can be reasoned about without a PDF.
 */
export function linesFromItems(items: TextItemLike[]): string[] {
  type Placed = { x: number; y: number; w: number; h: number; str: string };
  const placed: Placed[] = items
    .filter((it) => it.str.trim().length > 0)
    .map((it) => ({
      x: it.transform[4] ?? 0,
      y: it.transform[5] ?? 0,
      w: it.width,
      h: Math.abs(it.height || it.transform[3] || 10),
      str: it.str,
    }));
  // Baselines: items within ~half a line height of each other share a row.
  const rows: Placed[][] = [];
  for (const it of [...placed].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    const tolerance = Math.max(2, it.h * 0.5);
    if (row && Math.abs(row[0]!.y - it.y) <= tolerance) row.push(it);
    else rows.push([it]);
  }
  const out: string[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let text = "";
    let cursor = 0;
    let prevCharW = 0;
    for (const it of row) {
      const charW = it.w > 0 && it.str.length > 0 ? it.w / it.str.length : prevCharW || it.h * 0.5;
      const gap = it.x - cursor;
      if (text.length > 0) {
        if (gap > Math.max(8, charW * 2.5)) text += "  ";
        else if (gap > charW * 0.2 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
      }
      text += it.str;
      cursor = it.x + it.w;
      prevCharW = charW;
    }
    const line = text.replace(/ /g, " ").replace(/\s+$/g, "");
    if (line.trim()) out.push(line);
  }
  return out;
}

/** A .txt / .md resume: one line per line. */
export async function extractTextLines(file: File): Promise<string[]> {
  const text = await file.text();
  return text.split(/\r?\n/);
}
