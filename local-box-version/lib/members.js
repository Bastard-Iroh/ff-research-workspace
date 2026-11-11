// The four members are hard-coded. Only display names (and bot handles) come from config.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = process.env.FFW_CONFIG || join(ROOT, "config", "members.json");

const FIXED = {
  dylan: { type: "human", owner: null, defaultName: "Dylan", defaultHandle: "dylan" },
  jacob: { type: "human", owner: null, defaultName: "Jacob", defaultHandle: "jacob" },
  dylan_bot: { type: "bot", owner: "dylan", defaultName: "Dylan's Bot", defaultHandle: "dylans-bot" },
  jacob_bot: { type: "bot", owner: "jacob", defaultName: "Jacob's Bot", defaultHandle: "jacobs-bot" },
};
export const MEMBER_IDS = Object.keys(FIXED);

let cache = null;
let cacheMtime = 0;
let aliasLookup = () => [];

export function slugify(name) {
  return String(name).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function setAliasLookup(fn) { aliasLookup = fn || (() => []); }
export function listStoredAliases() { return aliasLookup() || []; }

function readConfig() {
  let mtime = 0;
  try { mtime = statSync(CONFIG_PATH).mtimeMs; } catch {}
  if (cache && mtime === cacheMtime) return cache;
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
  const out = {};
  for (const id of MEMBER_IDS) {
    const f = FIXED[id];
    const c = cfg[id] || {};
    const name = typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, 40) : f.defaultName;
    const handle = f.type === "human" ? f.defaultHandle : slugify(c.handle || name) || f.defaultHandle;
    out[id] = { id, name, handle, type: f.type, owner: f.owner };
  }
  cache = out;
  cacheMtime = mtime;
  return out;
}

export function members() { return readConfig(); }
export function member(id) { return readConfig()[id] || null; }
export function listMembers() { return MEMBER_IDS.map((id) => readConfig()[id]); }
export function isBot(id) { return FIXED[id]?.type === "bot"; }
export function isHuman(id) { return FIXED[id]?.type === "human"; }
export function botOf(ownerId) { return MEMBER_IDS.find((id) => FIXED[id].owner === ownerId) || null; }

export function reservedLabels(exceptId) {
  const out = new Set();
  for (const id of MEMBER_IDS) {
    if (id === exceptId) continue;
    const m = member(id);
    const f = FIXED[id];
    out.add(id);
    out.add(m.name.toLowerCase());
    out.add(m.handle);
    out.add(f.defaultName.toLowerCase());
    out.add(f.defaultHandle);
  }
  return out;
}

export function aliasesOf(id) {
  const m = member(id);
  if (!m) return [];
  const cur = new Set([m.id, m.name.toLowerCase(), m.handle]);
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (!s || cur.has(s) || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  const f = FIXED[id];
  if (f) { add(f.defaultName); add(f.defaultHandle); }
  for (const a of listStoredAliases()) if (a.member_id === id) add(a.value);
  return out;
}

export function publicMember(id) {
  const m = member(id);
  return m ? { ...m, aliases: aliasesOf(id) } : null;
}

/** Resolve current name/handle/id, the member's original name/handle, or a stored alias -> member id. */
export function resolveMember(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  for (const m of listMembers()) {
    const f = FIXED[m.id];
    if (s === m.id || s === m.name.toLowerCase() || s === m.handle) return m.id;
    if (f && (s === f.defaultName.toLowerCase() || s === f.defaultHandle)) return m.id;
  }
  for (const a of listStoredAliases()) if (a.value === s) return a.member_id;
  return null;
}

export function validateBotName(id, newName) {
  if (!isBot(id)) throw new Error("Only bots can be renamed.");
  const name = String(newName || "").trim();
  if (!name || name.length > 40 || /[:|\n\r]/.test(name)) throw new Error("Name must be 1-40 chars, no colons, pipes or newlines.");
  const handle = slugify(name);
  if (!handle) throw new Error("Name needs at least one letter or digit.");
  const reserved = reservedLabels(id);
  for (const a of listStoredAliases()) if (a.member_id !== id) reserved.add(a.value);
  if (reserved.has(name.toLowerCase()) || reserved.has(handle)) throw new Error("That name is already used by another member.");
  return { name, handle };
}

export function renameBot(id, newName) {
  const { name, handle } = validateBotName(id, newName);
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
  cfg[id] = { ...(cfg[id] || {}), name, handle };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  cache = null;
  return member(id);
}
