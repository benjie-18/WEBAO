// Restores binary images committed as base64 text (.b64) back into public/.
// Runs automatically via the `prebuild` npm script, including in CI.
// Idempotent: skips files that already exist with matching size.
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".b64")) out.push(p);
  }
  return out;
}

let restored = 0;
let skipped = 0;
for (const b64path of walk(root)) {
  const dest = b64path.slice(0, -4);
  const b64 = readFileSync(b64path, "utf8").replace(/\s+/g, "");
  const expected = Buffer.byteLength(b64, "base64");
  try {
    if (statSync(dest).size === expected) {
      skipped++;
      continue;
    }
  } catch {}
  writeFileSync(dest, Buffer.from(b64, "base64"));
  restored++;
}
console.log(`[restore-images] restored ${restored}, skipped ${skipped}`);
