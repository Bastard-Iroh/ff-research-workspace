// Postgres data layer (Prisma Postgres via Vercel Marketplace). PINs stored only as scrypt hashes.
import pg from "pg";
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { isBot } from "./members.js";

export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60 * 1000;

let pool;
export function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
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
);`;

// pg returns BIGINT as string; normalise the columns we use as numbers.
const NUMS = ["locked_until", "created_at", "updated_at", "decided_at"];
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
