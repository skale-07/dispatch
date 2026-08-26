// U3: registry components (shadcn/KokonutUI/Bklit) are VENDOR code —
// authored and type-checked upstream against a laxer tsconfig than
// Dispatch's (exactOptionalPropertyTypes in particular). Hand-patching
// dozens of strictness mismatches would diverge every file from its
// registry source and make future `shadcn add --overwrite` pulls a
// merge chore. Instead, this script stamps @ts-nocheck on vendored
// files, the same stance skipLibCheck takes for node_modules: their
// EXPORTED types still check at every first-party call site; only the
// vendor file bodies are exempt. Run after any `npx shadcn add`.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "src", "components");
const VENDOR_DIRS = ["charts", "ui"];
const PRAGMA =
  "// @ts-nocheck -- vendored registry code (see frontend/scripts/vendor-pragma.mjs)\n";

let stamped = 0;
for (const dir of VENDOR_DIRS) {
  const base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) continue;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const src = fs.readFileSync(full, "utf8");
        if (!src.startsWith("// @ts-nocheck")) {
          fs.writeFileSync(full, PRAGMA + src);
          stamped += 1;
        }
      }
    }
  };
  walk(base);
}
console.log(`vendor-pragma: ${stamped} file(s) stamped`);
