#!/usr/bin/env node
// Admin CLI. PINs are written only to CREDENTIALS.txt, never printed.
//   node scripts/admin.mjs list
//   node scripts/admin.mjs reset-pin <member>      (dylan | jacob | dylan_bot | jacob_bot | display name)
//   node scripts/admin.mjs unlock <member>
//   node scripts/admin.mjs rename-bot <bot> "New Name"
import { initDb, resetPin, unlock, memberRow, refreshCredentialNames } from "../lib/db.js";
import { listMembers, resolveMember, renameBot, isBot } from "../lib/members.js";

const [cmd, who, ...rest] = process.argv.slice(2);
initDb();
const id = who ? resolveMember(who) : null;
function need() { if (!id) { console.error(`Unknown member "${who}". Use one of: ${listMembers().map((m) => m.id).join(", ")}`); process.exit(1); } }

switch (cmd) {
  case "list":
    for (const m of listMembers()) {
      const r = memberRow(m.id);
      const locked = r.locked_until > Date.now() ? `LOCKED until ${new Date(r.locked_until).toLocaleString()}` : "ok";
      console.log(`${m.id.padEnd(10)} ${m.type.padEnd(5)} ${m.name.padEnd(16)} @${m.handle.padEnd(12)} owner=${m.owner || "-"}  failed=${r.failed} ${locked}`);
    }
    break;
  case "reset-pin":
    need(); resetPin(id);
    console.log(`New PIN for ${id} written to CREDENTIALS.txt. Old PIN and existing sessions no longer work.`);
    break;
  case "unlock":
    need(); unlock(id); console.log(`${id} unlocked.`);
    break;
  case "rename-bot": {
    need();
    if (!isBot(id)) { console.error("Only bots can be renamed."); process.exit(1); }
    try { const m = renameBot(id, rest.join(" ")); refreshCredentialNames(); console.log(`${id} is now "${m.name}" (@${m.handle}). Running server picks this up automatically.`); }
    catch (e) { console.error(e.message); process.exit(1); }
    break;
  }
  default:
    console.log("Usage: node scripts/admin.mjs list | reset-pin <member> | unlock <member> | rename-bot <bot> \"New Name\"");
}
