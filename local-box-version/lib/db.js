import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { MEMBER_IDS, member, isBot } from "./members.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.FFW_DATA_DIR || join(ROOT, "data");
export const FILES_DIR = join(DATA_DIR, "files");
export const CREDENTIALS_PATH = process.env.FFW_CREDENTIALS || join(ROOT, "CREDENTIALS.txt");
const DB_PATH = join(DATA_DIR, "ff-workspace.db");
const SECRET_PATH = join(DATA_DIR, "session-secret.txt");

export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60 * 1000;

let db;
export function getDb() { return db; }

export function initDb() {
  mkdirSync(FILES_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      pin_hash TEXT NOT NULL,
      pin_version INTEGER NOT NULL DEFAULT 1,
      failed INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      uploader TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      stored TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      mentions TEXT NOT NULL DEFAULT '[]',
      commands TEXT NOT NULL DEFAULT '[]',
      status TEXT,
      assignee TEXT,
      file_id INTEGER REFERENCES files(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, id);
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      owner TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id),
      actor TEXT NOT NULL,
      changes TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_msg ON revisions(message_id);
    CREATE TABLE IF NOT EXISTS doc_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL REFERENCES docs(id),
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      source TEXT NOT NULL,
      suggestion_id INTEGER,
      at INTEGER NOT NULL,
      UNIQUE(doc_id, version)
    );
    CREATE TABLE IF NOT EXISTS webhooks (
      bot_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      last_status TEXT,
      last_error TEXT,
      last_type TEXT,
      last_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL REFERENCES docs(id),
      author TEXT NOT NULL,
      base_title TEXT NOT NULL,
      base_body TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT
    );
  `);
  // Permanent record: make sure every existing doc has at least its current version saved.
  db.exec(`INSERT INTO doc_versions (doc_id, version, title, body, author, source, at)
    SELECT d.id, 1, d.title, d.body, d.updated_by, 'existing', d.updated_at FROM docs d
    WHERE NOT EXISTS (SELECT 1 FROM doc_versions v WHERE v.doc_id = d.id)`);
  ensurePins();
}

export function getSessionSecret() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(SECRET_PATH)) return readFileSync(SECRET_PATH, "utf8").trim();
  const s = randomBytes(48).toString("base64url");
  writeFileSync(SECRET_PATH, s, { mode: 0o600 });
  return s;
}

// ---- PINs ----
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
  if (isBot(id)) return randomBytes(24).toString("base64url"); // 32 chars, ~192 bits
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function readCreds() {
  const out = {};
  if (!existsSync(CREDENTIALS_PATH)) return out;
  for (const line of readFileSync(CREDENTIALS_PATH, "utf8").split("\n")) {
    const m = line.match(/^([a-z_]+)\s*\|[^|]*\|\s*(\S+)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function writeCreds(map) {
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
export function refreshCredentialNames() { writeCreds(readCreds()); }

function ensurePins() {
  const creds = readCreds();
  let changed = false;
  for (const id of MEMBER_IDS) {
    const row = db.prepare("SELECT id FROM members WHERE id = ?").get(id);
    if (!row) {
      const pin = generatePin(id);
      db.prepare("INSERT INTO members (id, pin_hash) VALUES (?, ?)").run(id, hashPin(pin));
      creds[id] = pin;
      changed = true;
    }
  }
  if (changed) writeCreds(creds);
}

export function resetPin(id) {
  const pin = generatePin(id);
  db.prepare("UPDATE members SET pin_hash = ?, pin_version = pin_version + 1, failed = 0, locked_until = 0 WHERE id = ?").run(hashPin(pin), id);
  const creds = readCreds();
  creds[id] = pin;
  writeCreds(creds);
}

export function unlock(id) {
  db.prepare("UPDATE members SET failed = 0, locked_until = 0 WHERE id = ?").run(id);
}

export function memberRow(id) {
  return db.prepare("SELECT * FROM members WHERE id = ?").get(id);
}

/** Check a PIN with lockout. Returns {ok, id, pinVersion} or {ok:false, status, error}. */
export function attemptLogin(id, pin) {
  const row = memberRow(id);
  if (!row) return { ok: false, status: 401, error: "Unknown name or wrong PIN." };
  const now = Date.now();
  if (row.locked_until > now) {
    const mins = Math.ceil((row.locked_until - now) / 60000);
    return { ok: false, status: 423, error: `This name is locked after ${MAX_FAILS} wrong PINs. Try again in ${mins} minute(s).`, lockedUntil: row.locked_until };
  }
  if (row.locked_until && row.locked_until <= now) {
    db.prepare("UPDATE members SET failed = 0, locked_until = 0 WHERE id = ?").run(id);
    row.failed = 0;
  }
  if (pin && verifyPin(pin, row.pin_hash)) {
    if (row.failed) db.prepare("UPDATE members SET failed = 0 WHERE id = ?").run(id);
    return { ok: true, id, pinVersion: row.pin_version };
  }
  const failed = row.failed + 1;
  if (failed >= MAX_FAILS) {
    const until = now + LOCK_MS;
    db.prepare("UPDATE members SET failed = ?, locked_until = ? WHERE id = ?").run(failed, until, id);
    return { ok: false, status: 423, error: `Wrong PIN. This name is now locked for 15 minutes.`, lockedUntil: until };
  }
  db.prepare("UPDATE members SET failed = ? WHERE id = ?").run(failed, id);
  return { ok: false, status: 401, error: `Wrong PIN. ${MAX_FAILS - failed} attempt(s) left before a 15-minute lock.` };
}
