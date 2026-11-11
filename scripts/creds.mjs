// Shared credentials file used by both the box version and the live version.
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { MEMBER_IDS, member } from "../lib/members.js";
export const CREDENTIALS_PATH = process.env.FFW_CREDENTIALS || "/workspace/ff-workspace/CREDENTIALS.txt";
export function readCreds() {
  const out = {};
  if (!existsSync(CREDENTIALS_PATH)) return out;
  for (const line of readFileSync(CREDENTIALS_PATH, "utf8").split("\n")) {
    const m = line.match(/^([a-z_]+)\s*\|[^|]*\|\s*(\S+)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
export function writeCreds(map) {
  const lines = [
    "# Field&Forms Research Workspace - login PINs. KEEP PRIVATE. Never commit or share this file.",
    "# Humans: pick your name on the sign-in page and enter your PIN.",
    "# Bots: send  Authorization: Basic base64(<name>:<PIN>)  on every API call (see /api-docs).",
    "# Format: member_id | display name | PIN",
    "",
  ];
  for (const id of MEMBER_IDS) if (map[id]) lines.push(`${id} | ${member(id).name} | ${map[id]}`);
  writeFileSync(CREDENTIALS_PATH, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(CREDENTIALS_PATH, 0o600);
}
