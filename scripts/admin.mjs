#!/usr/bin/env node
// Admin CLI for the LIVE app (talks to /api/admin with the operator secret in .admin-secret).
// PINs are generated/hashed here and go only to CREDENTIALS.txt; only hashes are sent. Nothing secret is printed.
//   node scripts/admin.mjs setup                      create tables + seed 4 members from EXISTING CREDENTIALS.txt PINs
//   node scripts/admin.mjs list | unlock <member> | rename-bot <bot> "New Name" | reset-pin <member>
//   node scripts/admin.mjs archive <dir>              save a copy of all content + files to <dir> (nothing is removed: posts are permanent)
//   node scripts/admin.mjs reset-test-db              clear a PREVIEW/TEST database only (the server refuses on production)
// Env: FFW_URL, FFW_ADMIN_SECRET_FILE, FFW_BYPASS_FILE (Vercel protection bypass for previews), FFW_CREDENTIALS, FFW_SYNC_BOX_DB=0
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPin, generatePin } from "../lib/db.js";
import { MEMBER_IDS, configNames, slugify, member } from "../lib/members.js";
import { readCreds, writeCreds } from "./creds.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.FFW_URL || "https://ff-research-workspace.vercel.app";
const SECRET = readFileSync(process.env.FFW_ADMIN_SECRET_FILE || join(ROOT, ".admin-secret"), "utf8").trim();
const BYPASS = process.env.FFW_BYPASS_FILE ? { "x-vercel-protection-bypass": readFileSync(process.env.FFW_BYPASS_FILE, "utf8").trim() } : {};
const LOCAL_DB = process.env.FFW_SYNC_BOX_DB === "0" ? null : "/workspace/ff-workspace/data/ff-workspace.db";
const resolve = (s) => { const x = String(s || "").toLowerCase(); return MEMBER_IDS.find((id) => id === x || member(id).name.toLowerCase() === x || member(id).handle === x); };

async function admin(body, raw = false) {
  const r = await fetch(`${BASE}/api/admin`, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Secret": SECRET, ...BYPASS }, body: JSON.stringify(body) });
  if (raw) { if (!r.ok) throw new Error(`HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

const [cmd, who, ...rest] = process.argv.slice(2);
const id = who ? resolve(who) : null;
const need = () => { if (!id) { console.error(`Unknown member "${who}". Use one of: ${MEMBER_IDS.join(", ")}`); process.exit(1); } };
try {
  switch (cmd) {
    case "setup": {
      const creds = readCreds(), cfg = configNames();
      const members = MEMBER_IDS.map((m) => {
        if (!creds[m]) throw new Error(`No PIN for ${m} in CREDENTIALS.txt`);
        const name = cfg[m]?.name || null;
        return { id: m, name, handle: m.endsWith("_bot") ? cfg[m]?.handle || (name && slugify(name)) : null, pinHash: hashPin(creds[m]) };
      });
      const r = await admin({ action: "setup", members });
      console.log(`Schema ready. Seeded ${r.seeded} new member(s) from the existing PINs (hashed).`);
      break;
    }
    case "list":
      for (const m of (await admin({ action: "list" })).members)
        console.log(`${m.id.padEnd(10)} ${String(m.name || "").padEnd(14)} @${String(m.handle || m.id).padEnd(12)} pinVersion=${m.pin_version} failed=${m.failed} ${m.locked_until > Date.now() ? "LOCKED until " + new Date(m.locked_until).toLocaleString() : "ok"}`);
      break;
    case "unlock": need(); await admin({ action: "unlock", id }); console.log(`${id} unlocked.`); break;
    case "rename-bot": { need(); const r = await admin({ action: "rename-bot", id, name: rest.join(" ") }); console.log(`${id} is now "${r.name}" (@${r.handle}). Live within 30 seconds.`); break; }
    case "reset-pin": {
      need();
      const pin = generatePin(id), h = hashPin(pin);
      await admin({ action: "set-pin-hash", id, pinHash: h });
      if (LOCAL_DB && existsSync(LOCAL_DB)) {
        const { DatabaseSync } = await import("node:sqlite");
        new DatabaseSync(LOCAL_DB).prepare("UPDATE members SET pin_hash = ?, pin_version = pin_version + 1, failed = 0, locked_until = 0 WHERE id = ?").run(h, id);
      }
      const c = readCreds(); c[id] = pin; writeCreds(c);
      console.log(`New PIN for ${id} written to CREDENTIALS.txt (live and box databases updated).`);
      break;
    }
    case "archive": {
      const dir = who; if (!dir) throw new Error("Give an archive directory.");
      mkdirSync(join(dir, "files"), { recursive: true, mode: 0o700 });
      const data = await admin({ action: "export" });
      writeFileSync(join(dir, "content.json"), JSON.stringify(data, null, 1), { mode: 0o600 });
      for (const f of data.files) writeFileSync(join(dir, "files", `${f.id}-${f.name.replace(/[^\w.-]/g, "_")}`), await admin({ action: "export-file", id: f.id }, true), { mode: 0o600 });
      console.log(`Archived a copy of ${data.messages.length} messages, ${data.docs.length} docs, ${data.suggestions.length} suggestions, ${data.files.length} files to ${dir}. Nothing was removed.`);
      break;
    }
    case "reset-test-db": {
      if (!process.env.FFW_URL || /ff-research-workspace\.vercel\.app/.test(BASE)) throw new Error("reset-test-db only runs against a preview/test URL (set FFW_URL). Production content is permanent.");
      const r = await admin({ action: "clear-content" });
      console.log(`Test database cleared (${r.blobsRemoved} test blobs).`);
      break;
    }
    default:
      console.log('Usage: node scripts/admin.mjs setup | list | unlock <m> | rename-bot <bot> "Name" | reset-pin <m> | archive <dir> | reset-test-db');
  }
} catch (e) { console.error("Error:", e.message); process.exitCode = 1; }
