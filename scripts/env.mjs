// Loads .env.local (from `vercel env pull`) into process.env without printing anything.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const p = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
if (existsSync(p)) for (const line of readFileSync(p, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
