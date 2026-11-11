// The four members are hard-coded. Display names and bot handles live in the members table
// (seeded from config/members.json) so they can be renamed with scripts/admin.mjs.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXED = {
  dylan: { type: "human", owner: null, defaultName: "Dylan", defaultHandle: "dylan" },
  jacob: { type: "human", owner: null, defaultName: "Jacob", defaultHandle: "jacob" },
  dylan_bot: { type: "bot", owner: "dylan", defaultName: "Dylan's Bot", defaultHandle: "dylans-bot" },
  jacob_bot: { type: "bot", owner: "jacob", defaultName: "Jacob's Bot", defaultHandle: "jacobs-bot" },
};
export const MEMBER_IDS = Object.keys(FIXED);

export function slugify(name) {
  return String(name).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
export function configNames() {
  try { return JSON.parse(readFileSync(join(ROOT, "config", "members.json"), "utf8")); } catch { return {}; }
}

let names = {};      // id -> {name, handle}
let loadedAt = 0;
const TTL = 30_000;

function build(id) {
  const f = FIXED[id];
  const n = names[id] || {};
  const name = n.name || f.defaultName;
  const handle = f.type === "human" ? f.defaultHandle : n.handle || slugify(name) || f.defaultHandle;
  return { id, name, handle, type: f.type, owner: f.owner };
}
/** Refresh names from DB rows (cached per instance for 30s). */
export async function refreshNames(q, force = false) {
  if (!force && Date.now() - loadedAt < TTL) return;
  const rows = await q("SELECT id, name, handle FROM members");
  const next = {};
  for (const r of rows) next[r.id] = { name: r.name, handle: r.handle };
  names = next; loadedAt = Date.now();
}
export function member(id) { return FIXED[id] ? build(id) : null; }
export function listMembers() { return MEMBER_IDS.map(build); }
export function isBot(id) { return FIXED[id]?.type === "bot"; }
export function isHuman(id) { return FIXED[id]?.type === "human"; }
export function botOf(ownerId) { return MEMBER_IDS.find((id) => FIXED[id].owner === ownerId) || null; }

export function resolveMember(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  for (const m of listMembers()) if (s === m.id || s === m.name.toLowerCase() || s === m.handle) return m.id;
  return null;
}
export function validateBotName(id, newName) {
  if (!isBot(id)) throw new Error("Only bots can be renamed.");
  const name = String(newName || "").trim();
  if (!name || name.length > 40 || /[:|\n\r]/.test(name)) throw new Error("Name must be 1-40 chars, no colons, pipes or newlines.");
  const handle = slugify(name);
  if (!handle) throw new Error("Name needs at least one letter or digit.");
  const clash = listMembers().find((m) => m.id !== id && (m.handle === handle || m.name.toLowerCase() === name.toLowerCase()));
  if (clash) throw new Error("That name is already used by another member.");
  return { name, handle };
}
