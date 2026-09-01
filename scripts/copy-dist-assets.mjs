// Post-tsc step of `npm run build`: tsc only emits .ts sources, but the
// migration runner reads its .sql files from a path relative to the
// compiled module (src/storage/db/client.ts -> dist/storage/db/migrations).
// Plain Node on purpose — the build must not need tsx.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "src", "storage", "db", "migrations");
const to = path.join(root, "dist", "storage", "db", "migrations");

fs.cpSync(from, to, { recursive: true });
console.log(`copied migrations -> ${path.relative(root, to)}`);
