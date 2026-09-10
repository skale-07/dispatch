#!/usr/bin/env node
/**
 * #224 diagnosis helper: what does PLAN-TIME discovery see in a saved form
 * snapshot?
 *
 * Compare its output to that run's `unanswered` payload (the review item
 * the submit gate wrote). A required control the LIVE page has and this
 * does NOT list is a control that rendered after the snapshot was taken —
 * which is the whole of #224. Night29 evidence: Crest Industries' bare
 * "Name" + "Date" acknowledgement block is absent from a 725 KB full-page
 * snapshot while the live scan finds both, so discovery and the mapper are
 * fine and the input they were given was stale.
 *
 * Read-only, offline, no browser.
 *
 * Usage:
 *   npx tsx scripts/discover-from-snapshot.ts artifacts/ats-fill/<ats>/form-snapshot-<ts>.html
 */
import "dotenv/config";
import fs from "node:fs";
import { discoverFieldsFromHtml } from "../src/applications/fieldDiscovery.js";

const file = process.argv[2];
if (!file) {
  console.error(
    "Usage: npx tsx scripts/discover-from-snapshot.ts <form-snapshot.html>",
  );
  process.exit(2);
}

const html = fs.readFileSync(file, "utf8");
const fields = discoverFieldsFromHtml(html);
console.log(`discovered ${fields.length} field(s) in ${html.length} bytes\n`);
for (const f of fields) {
  console.log(
    "  ",
    f.type.padEnd(10),
    (f.label || "(no label)").slice(0, 50).padEnd(52),
    (f.id || "").slice(0, 46),
    f.required ? "REQUIRED" : "",
  );
}
