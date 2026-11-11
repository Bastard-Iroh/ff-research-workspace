// Postgres data layer (Prisma Postgres via Vercel Marketplace). PINs stored only as scrypt hashes.
import pg from "pg";
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { isBot, isHuman, botOf, validateBotName, member, aliasesOf, refreshNames } from "./members.js";

export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60 * 1000;

let pool;
export function getPool() {
  if (!pool) {
    // Preview/test deployments must use their own database so tests never touch the permanent record.
    const isProd = process.env.VERCEL_ENV === "production";
    const url = process.env.VERCEL_ENV && !isProd
      ? process.env.TEST_DATABASE_URL_POOLED || process.env.TEST_DATABASE_URL
      : process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error(process.env.VERCEL_ENV && !isProd ? "Preview deployments need TEST_DATABASE_URL (a separate test database)." : "DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000, ssl: url.includes("sslmode=disable") ? false : { rejectUnauthorized: false } });
  }
  return pool;
}
export async function q(text, params = []) { return (await getPool().query(text, params)).rows; }
export async function one(text, params = []) { return (await q(text, params))[0] || null; }

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT,
  handle TEXT,
  pin_hash TEXT NOT NULL,
  pin_version INTEGER NOT NULL DEFAULT 1,
  failed INTEGER NOT NULL DEFAULT 0,
  locked_until BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS files (
  id SERIAL PRIMARY KEY,
  room TEXT NOT NULL,
  uploader TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  room TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  commands TEXT NOT NULL DEFAULT '[]',
  status TEXT,
  assignee TEXT,
  file_id INTEGER REFERENCES files(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, id);
CREATE INDEX IF NOT EXISTS idx_messages_updated ON messages(room, updated_at);
CREATE TABLE IF NOT EXISTS docs (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  actor TEXT NOT NULL,
  changes TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_msg ON revisions(message_id);
CREATE TABLE IF NOT EXISTS doc_versions (
  id SERIAL PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES docs(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  source TEXT NOT NULL,
  suggestion_id INTEGER,
  at BIGINT NOT NULL,
  UNIQUE (doc_id, version)
);
INSERT INTO doc_versions (doc_id, version, title, body, author, source, at)
  SELECT d.id, 1, d.title, d.body, d.updated_by, 'existing', d.updated_at FROM docs d
  WHERE NOT EXISTS (SELECT 1 FROM doc_versions v WHERE v.doc_id = d.id);
CREATE TABLE IF NOT EXISTS webhooks (
  bot_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_status TEXT,
  last_error TEXT,
  last_type TEXT,
  last_at BIGINT,
  auth_header_name TEXT,
  auth_header_value TEXT
);
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS auth_header_name TEXT;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS auth_header_value TEXT;
CREATE TABLE IF NOT EXISTS webhook_test_inbox (
  id SERIAL PRIMARY KEY,
  received_at BIGINT NOT NULL,
  signature TEXT,
  event TEXT,
  tag TEXT,
  body TEXT NOT NULL,
  headers TEXT
);
ALTER TABLE webhook_test_inbox ADD COLUMN IF NOT EXISTS headers TEXT;
CREATE TABLE IF NOT EXISTS suggestions (
  id SERIAL PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES docs(id),
  author TEXT NOT NULL,
  base_title TEXT NOT NULL,
  base_body TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  decided_at BIGINT,
  decided_by TEXT
);
CREATE TABLE IF NOT EXISTS audit_events (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  subject TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_type_subject ON audit_events(type, subject, id);
CREATE TABLE IF NOT EXISTS name_aliases (
  member_id TEXT NOT NULL,
  value TEXT NOT NULL,
  at BIGINT NOT NULL,
  PRIMARY KEY (member_id, value)
);
CREATE INDEX IF NOT EXISTS idx_alias_value ON name_aliases(value);
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS detail TEXT;`;

// pg returns BIGINT as string; normalise the columns we use as numbers.
const NUMS = ["locked_until", "created_at", "updated_at", "decided_at", "last_at", "received_at", "at"];
export function nums(row) {
  if (!row) return row;
  for (const k of NUMS) if (row[k] != null) row[k] = Number(row[k]);
  return row;
}

export function hashPin(pin) {
  const salt = randomBytes(16);
  const key = scryptSync(pin, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString("base64")}$${key.toString("base64")}`;
}
export function verifyPin(pin, stored) {
  const [alg, n, saltB64, keyB64] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const key = Buffer.from(keyB64, "base64");
  const got = scryptSync(String(pin), Buffer.from(saltB64, "base64"), key.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(key, got);
}
export function generatePin(id) {
  if (isBot(id)) return randomBytes(24).toString("base64url");
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function memberRow(id) { return nums(await one("SELECT * FROM members WHERE id = $1", [id])); }

/** Check a PIN with lockout. Returns {ok, id, pinVersion} or {ok:false, status, error}. */
export async function attemptLogin(id, pin) {
  const row = await memberRow(id);
  if (!row) return { ok: false, status: 401, error: "Unknown name or wrong PIN." };
  const now = Date.now();
  if (row.locked_until > now) {
    const mins = Math.ceil((row.locked_until - now) / 60000);
    return { ok: false, status: 423, error: `This name is locked after ${MAX_FAILS} wrong PINs. Try again in ${mins} minute(s).`, lockedUntil: row.locked_until };
  }
  if (pin && verifyPin(pin, row.pin_hash)) {
    if (row.failed || row.locked_until) await q("UPDATE members SET failed = 0, locked_until = 0 WHERE id = $1", [id]);
    return { ok: true, id, pinVersion: row.pin_version };
  }
  // Atomic increment; an expired lock starts the count over.
  const r = nums(await one(
    `UPDATE members SET failed = CASE WHEN locked_until > 0 AND locked_until <= $2 THEN 1 ELSE failed + 1 END,
       locked_until = CASE WHEN locked_until > 0 AND locked_until <= $2 THEN 0 ELSE locked_until END
     WHERE id = $1 RETURNING failed`, [id, now]));
  if (r.failed >= MAX_FAILS) {
    await q("UPDATE members SET locked_until = $2 WHERE id = $1", [id, now + LOCK_MS]);
    return { ok: false, status: 423, error: `Wrong PIN. This name is now locked for 15 minutes.`, lockedUntil: now + LOCK_MS };
  }
  return { ok: false, status: 401, error: `Wrong PIN. ${MAX_FAILS - r.failed} attempt(s) left before a 15-minute lock.` };
}

export async function ensureHookCols() {
  await q(`ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS auth_header_name TEXT;
    ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS auth_header_value TEXT;
    ALTER TABLE webhook_test_inbox ADD COLUMN IF NOT EXISTS headers TEXT;`);
}

let auditReady = false;
export async function ensureAudit() {
  if (auditReady) return;
  await q(`CREATE TABLE IF NOT EXISTS audit_events (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    subject TEXT NOT NULL,
    at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_type_subject ON audit_events(type, subject, id);
  CREATE TABLE IF NOT EXISTS name_aliases (
    member_id TEXT NOT NULL,
    value TEXT NOT NULL,
    at BIGINT NOT NULL,
    PRIMARY KEY (member_id, value)
  );
  CREATE INDEX IF NOT EXISTS idx_alias_value ON name_aliases(value);
  ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS detail TEXT;`);
  auditReady = true;
}

/** Rotate the signed-in owner's own bot PIN. Returns the new PIN to the caller only; never writes it to disk or logs. */
export async function resetOwnedBotPin(actorId) {
  const bot = botOf(actorId);
  if (!isHuman(actorId) || !bot) return { ok: false, status: 403, error: "Only an owner can reset their own bot's PIN." };
  await ensureAudit();
  const pin = generatePin(bot);
  const now = Date.now();
  await q("UPDATE members SET pin_hash = $1, pin_version = pin_version + 1, failed = 0, locked_until = 0 WHERE id = $2", [hashPin(pin), bot]);
  await q("INSERT INTO audit_events (type, actor, subject, at) VALUES ('bot_pin_reset', $1, $2, $3)", [actorId, bot, now]);
  return { ok: true, pin, bot, at: now };
}

export async function lastBotPinReset(botId) {
  await ensureAudit();
  return nums(await one("SELECT actor, subject, at FROM audit_events WHERE type = 'bot_pin_reset' AND subject = $1 ORDER BY id DESC LIMIT 1", [botId]));
}

export async function ensureRenameSupport() {
  await ensureAudit();
}

function parseDetail(row) {
  if (!row) return null;
  row = nums(row);
  let detail = null;
  try { detail = row.detail ? JSON.parse(row.detail) : null; } catch {}
  return { actor: row.actor, subject: row.subject, at: row.at, source: detail?.source || null, oldName: detail?.oldName, oldHandle: detail?.oldHandle, name: detail?.name, handle: detail?.handle };
}

export async function lastBotRename(botId) {
  await ensureRenameSupport();
  return parseDetail(await one("SELECT actor, subject, at, detail FROM audit_events WHERE type = 'bot_rename' AND subject = $1 ORDER BY id DESC LIMIT 1", [botId]));
}

/** Apply a validated bot rename, keep previous names as aliases, and write an audit row (no secrets). */
export async function applyBotRename(id, newName, { actor, source } = {}) {
  if (!isBot(id)) return { ok: false, status: 400, error: "Only bots can be renamed." };
  await ensureRenameSupport();
  await refreshNames(q, true);
  const current = member(id);
  let v;
  try { v = validateBotName(id, newName); }
  catch (e) {
    return { ok: false, status: /already used/.test(e.message) ? 409 : 400, error: e.message };
  }
  if (current.name === v.name && current.handle === v.handle) {
    return { ok: true, unchanged: true, name: v.name, handle: v.handle, aliases: aliasesOf(id), previous: { name: current.name, handle: current.handle } };
  }
  const now = Date.now();
  await q("UPDATE members SET name = $1, handle = $2 WHERE id = $3", [v.name, v.handle, id]);
  for (const val of [current.name, current.handle]) {
    const s = String(val).toLowerCase();
    if (s && s !== v.name.toLowerCase() && s !== v.handle) {
      await q("INSERT INTO name_aliases (member_id, value, at) VALUES ($1,$2,$3) ON CONFLICT (member_id, value) DO NOTHING", [id, s, now]);
    }
  }
  await q("DELETE FROM name_aliases WHERE member_id = $1 AND (value = $2 OR value = $3)", [id, v.name.toLowerCase(), v.handle]);
  const detail = JSON.stringify({ source: source || "unknown", oldName: current.name, oldHandle: current.handle, name: v.name, handle: v.handle });
  await q("INSERT INTO audit_events (type, actor, subject, at, detail) VALUES ('bot_rename', $1, $2, $3, $4)", [actor || "unknown", id, now, detail]);
  await refreshNames(q, true);
  return { ok: true, unchanged: false, name: v.name, handle: v.handle, aliases: aliasesOf(id), previous: { name: current.name, handle: current.handle }, audit: { actor: actor || "unknown", subject: id, at: now, source: source || "unknown" } };
}
