// Field&Forms Research Workspace — Vercel edition (Express as one Vercel Function, Postgres, private Blob).
import express from "express";
import cookieSession from "cookie-session";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { put, get as blobGet, del as blobDel } from "@vercel/blob";
import { q, one, nums, attemptLogin, memberRow, SCHEMA } from "./lib/db.js";
import { member, listMembers, resolveMember, isBot, isHuman, refreshNames, validateBotName, MEMBER_IDS } from "./lib/members.js";
import { checkSensitive } from "./lib/filter.js";
import { waitUntil } from "@vercel/functions";
import { BOTS, deliver, newSecret, validateWebhookUrl, noticesForMessage, noticesForReassign, noticesForSuggestion, noticesForDecision } from "./lib/webhooks.js";

const MAX_FILE = 4 * 1024 * 1024;
const MAX_BODY = 8000;
const MAX_DOC = 200_000;
export const HANDOFF_LIMIT = 10;

const ROOMS = {
  talk: { id: "talk", name: "Talk", kind: "chat", humansOnly: false, description: "Shared chat for all four members." },
  work: { id: "work", name: "Work", kind: "work", humansOnly: false, description: "Tasks and updates with status and assignee." },
  docs: { id: "docs", name: "Documents", kind: "docs", humansOnly: false, description: "Shared docs. Non-owner edits become suggestions." },
  owners: { id: "owners", name: "Owners only", kind: "chat", humansOnly: true, description: "Private room for Dylan and Jacob. Bots cannot access it." },
};
const MESSAGE_ROOMS = ["talk", "work", "owners"];
const STATUSES = { todo: "To do", in_progress: "In progress", done: "Done" };

if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET is not set");
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.set({
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Cache-Control": "no-store",
  });
  next();
});
// "/" isn't routed to the CDN copy of index.html for Express projects, so serve it here.
let indexHtml = null;
app.get(["/", "/index.html"], (_req, res) => {
  indexHtml ??= readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  res.type("html").set("Cache-Control", "no-cache").send(indexHtml);
});
app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));
app.use(cookieSession({
  name: "ffw", keys: [process.env.SESSION_SECRET || "dev-only-secret"], maxAge: 14 * 24 * 60 * 60 * 1000,
  httpOnly: true, sameSite: "strict", secure: !!process.env.VERCEL,
}));

// ---------- auth ----------
const headerCache = new Map(); // sha256(header) -> {id, pv, exp}
// Member rows are read fresh on every request so lockouts and PIN resets take effect immediately.
const cachedRow = (id) => memberRow(id);
function parseAuthHeader(h) {
  let raw = null;
  const basic = h.match(/^Basic\s+(.+)$/i);
  if (basic) { try { raw = Buffer.from(basic[1], "base64").toString("utf8"); } catch { return null; } }
  const pin = h.match(/^Pin\s+(.+)$/i);
  if (pin) raw = pin[1];
  if (!raw) return null;
  const i = raw.indexOf(":");
  if (i < 1) return null;
  return { name: raw.slice(0, i), pin: raw.slice(i + 1) };
}
async function authenticate(req) {
  await refreshNames(q);
  const h = req.headers.authorization;
  if (h) {
    const key = createHash("sha256").update(h).digest("hex");
    const hit = headerCache.get(key);
    if (hit && hit.exp > Date.now()) {
      const row = await cachedRow(hit.id);
      if (row && row.pin_version === hit.pv && row.locked_until <= Date.now()) return { user: member(hit.id), via: "pin" };
      headerCache.delete(key);
    }
    const creds = parseAuthHeader(h);
    if (!creds) return { status: 401, error: "Bad Authorization header. Use Basic base64(Name:PIN) or 'Pin Name:PIN'." };
    const id = resolveMember(creds.name);
    if (!id) return { status: 401, error: "Unknown name or wrong PIN." };
    const r = await attemptLogin(id, creds.pin);
    if (!r.ok) return { status: r.status, error: r.error };
    headerCache.set(key, { id, pv: r.pinVersion, exp: Date.now() + 60_000 });
    return { user: member(id), via: "pin" };
  }
  const s = req.session;
  if (s?.mid) {
    const row = await cachedRow(s.mid);
    if (row && row.pin_version === s.pv) return { user: member(s.mid), via: "session" };
    req.session = null;
  }
  return null;
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const requireAuth = wrap(async (req, res, next) => {
  const a = await authenticate(req);
  if (!a) return res.status(401).json({ error: "Sign in required." });
  if (!a.user) return res.status(a.status).json({ error: a.error });
  if (a.via === "session" && req.method !== "GET" && req.method !== "HEAD" && req.get("X-FFW") !== "1")
    return res.status(403).json({ error: "Missing X-FFW header." });
  req.user = a.user;
  next();
});
function roomAccess(req, res, roomId) {
  const room = ROOMS[roomId];
  if (!room) { res.status(404).json({ error: "No such room." }); return null; }
  if (room.humansOnly && !isHuman(req.user.id)) { res.status(403).json({ error: "Bots cannot access the Owners only room." }); return null; }
  return room;
}
function blocked(res, ...texts) {
  const why = checkSensitive(...texts);
  if (!why) return false;
  res.status(422).json({ error: `Blocked: ${why}. Passwords, account numbers and home addresses can't be posted here.`, code: "sensitive_content" });
  return true;
}

// ---------- serializers ----------
const parseJson = (s) => { try { return JSON.parse(s); } catch { return []; } };
const MSG_SELECT = `SELECT m.*, f.name AS f_name, f.mime AS f_mime, f.size AS f_size FROM messages m LEFT JOIN files f ON f.id = m.file_id`;
function messageOut(row, viewer) {
  nums(row);
  const commands = parseJson(row.commands);
  const out = {
    id: row.id, room: row.room, author: row.author, authorName: member(row.author)?.name,
    body: row.body, mentions: parseJson(row.mentions), commands,
    commandKind: commands.length ? (isBot(row.author) ? "handoff" : "command") : null,
    file: row.file_id ? { id: row.file_id, name: row.f_name, mime: row.f_mime, size: row.f_size, url: `/api/files/${row.file_id}` } : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (row.room === "work") { out.status = row.status; out.statusLabel = STATUSES[row.status]; out.assignee = row.assignee; }
  if (viewer && isBot(viewer.id)) out.isCommandForMe = commands.includes(viewer.id);
  return out;
}
function docSummary(d) {
  nums(d);
  return { id: d.id, title: d.title, owner: d.owner, ownerName: member(d.owner)?.name, createdAt: d.created_at, updatedAt: d.updated_at, updatedBy: d.updated_by, pendingSuggestions: Number(d.pending || 0) };
}
function suggestionOut(s) {
  nums(s);
  return { id: s.id, docId: s.doc_id, author: s.author, authorName: member(s.author)?.name, status: s.status, note: s.note,
    before: { title: s.base_title, body: s.base_body }, after: { title: s.title, body: s.body },
    createdAt: s.created_at, decidedAt: s.decided_at, decidedBy: s.decided_by };
}
const DOC_SELECT = `SELECT d.*, (SELECT COUNT(*) FROM suggestions s WHERE s.doc_id = d.id AND s.status = 'pending') AS pending FROM docs d`;

// ---------- mentions & command rules ----------
function parseMentions(body) {
  const ids = new Set();
  for (const m of String(body).matchAll(/(^|[^\w@])@([a-z0-9][a-z0-9_-]*)/gi)) {
    const handle = m[2].toLowerCase().replace(/[-_]+$/, "");
    const id = listMembers().find((x) => x.handle === handle || x.id === handle)?.id;
    if (id) ids.add(id);
  }
  return [...ids];
}
/**
 * - Either owner @mentioning either bot = "command" for that bot.
 * - A bot @mentioning the other bot = "handoff" for the receiver.
 * - Loop guard: at most HANDOFF_LIMIT bot-to-bot handoffs per room since the last human message there.
 */
async function commandRules(author, mentions, roomId) {
  const me = member(author);
  const targets = mentions.filter((m) => isBot(m) && m !== author);
  if (me.type === "bot" && targets.length) {
    const r = await one(
      `SELECT COUNT(*)::int AS n FROM messages WHERE room = $1 AND author IN ('dylan_bot','jacob_bot') AND commands <> '[]'
         AND id > COALESCE((SELECT MAX(id) FROM messages WHERE room = $1 AND author IN ('dylan','jacob')), 0)`, [roomId]);
    if (r.n >= HANDOFF_LIMIT)
      return { status: 429, code: "handoff_limit", error: `Loop guard: ${HANDOFF_LIMIT} bot-to-bot handoffs in a row in this room with no human message. Wait for Dylan or Jacob to post here before handing off again (plain messages without @ still work).` };
  }
  return { commands: targets };
}

// ---------- routes ----------
const api = express.Router();
app.use("/api", api);
const jsonParser = express.json({ limit: "512kb" });
api.use((req, res, next) => (/\/files$|^\/webhook-test-sink\//.test(req.path) ? next() : jsonParser(req, res, next)));

api.get("/session", wrap(async (req, res) => {
  const a = await authenticate(req);
  res.json({ user: a?.user || null, members: listMembers().map(({ id, name, type }) => ({ id, name, type })) });
}));
api.post("/login", wrap(async (req, res) => {
  await refreshNames(q);
  const id = resolveMember(req.body?.member);
  const pin = String(req.body?.pin ?? "");
  if (!id) return res.status(401).json({ error: "Pick your name." });
  const r = await attemptLogin(id, pin);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  req.session = { mid: id, pv: r.pinVersion, n: randomBytes(4).toString("hex") };
  res.json({ user: member(id) });
}));
api.post("/logout", (req, res) => { req.session = null; res.json({ ok: true }); });

// ---------- webhook test sink (verification only) ----------
// Active only while WEBHOOK_TEST_SINK_TOKEN is set; stores the raw notice so scripts/verify.mjs can read it via /api/admin.
api.post("/webhook-test-sink/:token", express.text({ type: () => true, limit: "8kb" }), wrap(async (req, res) => {
  const want = process.env.WEBHOOK_TEST_SINK_TOKEN || "";
  const a = createHash("sha256").update(want).digest(), b = createHash("sha256").update(req.params.token || "").digest();
  if (want.length < 24 || !timingSafeEqual(a, b)) return res.status(404).json({ error: "Not found." });
  await q("INSERT INTO webhook_test_inbox (received_at, signature, event, tag, body) VALUES ($1,$2,$3,$4,$5)", [Date.now(), req.get("X-FFW-Signature") || null, req.get("X-FFW-Event") || null, String(req.query.bot || "").slice(0, 40), String(req.body || "")]);
  res.status(204).end();
}));

// ---------- operator endpoint (box admin CLI only) ----------
// The box can't open Postgres connections directly, so scripts/admin.mjs calls this with ADMIN_SECRET.
// It never receives or returns PINs: only scrypt hashes go in. Disabled (404) if ADMIN_SECRET is unset.
function adminOk(req) {
  const want = process.env.ADMIN_SECRET, got = req.get("X-Admin-Secret") || "";
  if (!want || want.length < 32) return false;
  const a = createHash("sha256").update(want).digest(), b = createHash("sha256").update(got).digest();
  return timingSafeEqual(a, b);
}
api.post("/admin", wrap(async (req, res) => {
  if (!adminOk(req)) return res.status(404).json({ error: "Not found." });
  const { action, id, name, pinHash, members } = req.body || {};
  const known = (x) => MEMBER_IDS.includes(x);
  switch (action) {
    case "setup": {
      await q(SCHEMA);
      let seeded = 0;
      for (const m of members || []) {
        if (!known(m.id) || !/^scrypt\$/.test(m.pinHash)) return res.status(400).json({ error: "bad member" });
        seeded += (await q("INSERT INTO members (id, name, handle, pin_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id", [m.id, m.name || null, m.handle || null, m.pinHash])).length;
      }
      return res.json({ ok: true, seeded });
    }
    case "resolve": { // operator diagnostics for the webhook SSRF guard
      try { return res.json({ addresses: await dnsLookup(String(req.body.host || ""), { all: true, verbatim: true }) }); }
      catch (e) { return res.json({ error: e.code || e.message }); }
    }
    case "sink-read":
      return res.json({ inbox: (await q("SELECT * FROM webhook_test_inbox ORDER BY id")).map(nums) });
    case "sink-clear":
      await q("DELETE FROM webhook_test_inbox");
      return res.json({ ok: true });
    case "webhooks-clear":
      await q("DELETE FROM webhooks");
      return res.json({ ok: true });
    case "list":
      return res.json({ members: (await q("SELECT id, name, handle, pin_version, failed, locked_until FROM members ORDER BY id")).map(nums) });
    case "unlock":
      if (!known(id)) return res.status(400).json({ error: "unknown member" });
      await q("UPDATE members SET failed = 0, locked_until = 0 WHERE id = $1", [id]);
      return res.json({ ok: true });
    case "set-pin-hash":
      if (!known(id) || !/^scrypt\$/.test(pinHash || "")) return res.status(400).json({ error: "bad request" });
      await q("UPDATE members SET pin_hash = $1, pin_version = pin_version + 1, failed = 0, locked_until = 0 WHERE id = $2", [pinHash, id]);
      return res.json({ ok: true });
    case "rename-bot": {
      await refreshNames(q, true);
      const v = validateBotName(id, name);
      await q("UPDATE members SET name = $1, handle = $2 WHERE id = $3", [v.name, v.handle, id]);
      await refreshNames(q, true);
      return res.json({ ok: true, ...v });
    }
    case "export":
      return res.json({ messages: await q("SELECT * FROM messages ORDER BY id"), files: await q("SELECT * FROM files ORDER BY id"),
        docs: await q("SELECT * FROM docs ORDER BY id"), suggestions: await q("SELECT * FROM suggestions ORDER BY id") });
    case "export-file": {
      const f = await one("SELECT * FROM files WHERE id = $1", [Number(id) || 0]);
      const b = f && await blobGet(f.stored, { access: "private" });
      if (!b?.stream) return res.status(404).json({ error: "missing" });
      res.set("Content-Type", "application/octet-stream");
      return Readable.fromWeb(b.stream).pipe(res);
    }
    case "clear-content": {
      // Permanent record: production content can never be cleared. Only preview/test databases can be reset.
      if (process.env.VERCEL_ENV === "production") return res.status(405).json({ error: "Production content is permanent.", code: "permanent_record" });
      const files = await q("SELECT stored FROM files");
      if (files.length) await blobDel(files.map((f) => f.stored));
      await q("DELETE FROM revisions; DELETE FROM doc_versions; DELETE FROM suggestions; DELETE FROM docs; DELETE FROM messages; DELETE FROM files; DELETE FROM webhook_test_inbox;");
      return res.json({ ok: true, blobsRemoved: files.length });
    }
    default:
      return res.status(400).json({ error: "unknown action" });
  }
}));

api.use(requireAuth);

// ---------- bot webhooks ----------
// Live version: https only. Delivery runs after the response via waitUntil (fire-and-forget).
const HOOK_OPTS = { allowLocalHttp: false };
const hookRow = async (bot) => nums(await one("SELECT * FROM webhooks WHERE bot_id = $1", [bot]));
const saveHookStatus = (bot, r) => q("UPDATE webhooks SET last_status = $1, last_error = $2, last_type = $3, last_at = $4 WHERE bot_id = $5", [r.status, r.error, r.type, r.at, bot]);
function notify(notices) {
  if (!notices.length) return;
  const time = Date.now();
  waitUntil((async () => {
    const hooks = await q("SELECT * FROM webhooks WHERE bot_id = ANY($1)", [notices.map((n) => n.bot)]);
    await Promise.all(notices.map(async (n) => {
      const h = hooks.find((x) => x.bot_id === n.bot);
      if (!h?.url) return;
      const r = await deliver(h, { ...n, time }, HOOK_OPTS);
      await saveHookStatus(n.bot, r);
    }));
  })().catch((e) => console.error("webhook", e.message)));
}
async function hookOut(bot, viewer, h) {
  h ??= (await hookRow(bot)) || {};
  const canEdit = BOTS[bot] === viewer.id;
  return { botId: bot, botName: member(bot).name, managedBy: BOTS[bot], managedByName: member(BOTS[bot]).name, canEdit, configured: !!h.url,
    url: canEdit ? h.url || null : null, lastDelivery: h.last_at ? { status: h.last_status, error: h.last_error, type: h.last_type, at: h.last_at } : null };
}
function hookGuard(req, res, write) {
  if (!isHuman(req.user.id)) { res.status(403).json({ error: "Bots can't view or change webhooks." }); return null; }
  if (!write) return true;
  const bot = resolveMember(req.params.bot);
  if (!BOTS[bot]) { res.status(404).json({ error: "No such bot." }); return null; }
  if (BOTS[bot] !== req.user.id) { res.status(403).json({ error: `Only ${member(BOTS[bot]).name} can change ${member(bot).name}'s webhook.` }); return null; }
  return bot;
}
api.get("/webhooks", wrap(async (req, res) => {
  if (!hookGuard(req, res, false)) return;
  const rows = (await q("SELECT * FROM webhooks")).map(nums);
  res.json({ webhooks: await Promise.all(Object.keys(BOTS).map((b) => hookOut(b, req.user, rows.find((r) => r.bot_id === b) || {}))) });
}));
api.put("/webhooks/:bot", wrap(async (req, res) => {
  const bot = hookGuard(req, res, true); if (!bot) return;
  let url;
  try { url = await validateWebhookUrl(req.body?.url, HOOK_OPTS); } catch (e) { return res.status(400).json({ error: e.message, code: "bad_webhook_url" }); }
  const secret = newSecret();
  await q(`INSERT INTO webhooks (bot_id, url, secret, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (bot_id) DO UPDATE SET url = EXCLUDED.url, secret = EXCLUDED.secret, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at,
    last_status = NULL, last_error = NULL, last_type = NULL, last_at = NULL`, [bot, url, secret, req.user.id, Date.now()]);
  res.json({ webhook: await hookOut(bot, req.user), secret, secretNote: "Shown once. Use it to check the X-FFW-Signature header (HMAC-SHA256 of the raw body)." });
}));
api.delete("/webhooks/:bot", wrap(async (req, res) => {
  const bot = hookGuard(req, res, true); if (!bot) return;
  await q("DELETE FROM webhooks WHERE bot_id = $1", [bot]);
  res.json({ webhook: await hookOut(bot, req.user, {}) });
}));
api.post("/webhooks/:bot/test", wrap(async (req, res) => {
  const bot = hookGuard(req, res, true); if (!bot) return;
  const h = await hookRow(bot);
  if (!h?.url) return res.status(400).json({ error: "Set a webhook URL first." });
  const r = await deliver(h, { type: "test", room: null, itemId: null, author: req.user.id, time: Date.now() }, HOOK_OPTS);
  await saveHookStatus(bot, r);
  res.json({ result: { ok: r.ok, status: r.status, error: r.error, attempts: r.attempts }, webhook: await hookOut(bot, req.user) });
}));

api.get("/whoami", (req, res) => {
  const u = req.user;
  res.json({ ...u, ownerName: u.owner ? member(u.owner).name : null, canAccessOwnersRoom: isHuman(u.id), takesCommandsFrom: u.type === "bot" ? ["dylan", "jacob", u.id === "dylan_bot" ? "jacob_bot" : "dylan_bot"] : null });
});
api.get("/members", (_req, res) => res.json({ members: listMembers() }));
api.get("/rooms", (req, res) => res.json({ rooms: Object.values(ROOMS).filter((r) => !r.humansOnly || isHuman(req.user.id)) }));

api.get("/rooms/:room/messages", wrap(async (req, res) => {
  const room = roomAccess(req, res, req.params.room); if (!room) return;
  if (!MESSAGE_ROOMS.includes(room.id)) return res.status(400).json({ error: "Documents has no messages; use /api/docs." });
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const where = ["m.room = $1"]; const args = [room.id];
  const add = (sql, v) => { args.push(v); where.push(sql.replace("?", `$${args.length}`)); };
  if (req.query.after) add("m.id > ?", Number(req.query.after));
  if (req.query.before) add("m.id < ?", Number(req.query.before));
  if (req.query.since) add("m.updated_at > ?", Number(req.query.since));
  if (req.query.author) { const a = resolveMember(req.query.author); if (!a) return res.status(400).json({ error: "Unknown author." }); add("m.author = ?", a); }
  if (req.query.status && room.id === "work") add("m.status = ?", String(req.query.status));
  const asc = req.query.after || req.query.since;
  args.push(limit + 1);
  let rows = await q(`${MSG_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.id ${asc ? "ASC" : "DESC"} LIMIT $${args.length}`, args);
  const hasMore = rows.length > limit;
  rows = rows.slice(0, limit);
  if (!asc) rows = rows.reverse();
  res.json({ room: room.id, messages: rows.map((r) => messageOut(r, req.user)), hasMore, serverTime: Date.now() });
}));

// Full transcript: every message in a room, oldest first, paginated. Owners only stays 403 for bots.
const revisionOut = (v) => ({ id: v.id, actor: v.actor, actorName: member(v.actor)?.name, changes: JSON.parse(v.changes), at: Number(v.at) });
api.get("/rooms/:room/transcript", wrap(async (req, res) => {
  const room = roomAccess(req, res, req.params.room); if (!room) return;
  if (!MESSAGE_ROOMS.includes(room.id)) return res.status(400).json({ error: "Documents has no transcript; see /api/docs/:id/versions." });
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 100, 1), 200);
  const total = (await one("SELECT COUNT(*)::int AS c FROM messages WHERE room = $1", [room.id])).c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), totalPages);
  const rows = await q(`${MSG_SELECT} WHERE m.room = $1 ORDER BY m.id ASC LIMIT $2 OFFSET $3`, [room.id, pageSize, (page - 1) * pageSize]);
  const ids = rows.filter((r) => r.room === "work").map((r) => r.id);
  const revs = ids.length ? await q("SELECT * FROM revisions WHERE message_id = ANY($1) ORDER BY id", [ids]) : [];
  res.json({ room: room.id, roomName: room.name, page, pageSize, total, totalPages,
    messages: rows.map((r) => ({ ...messageOut(r, req.user), history: revs.filter((v) => v.message_id === r.id).map(revisionOut) })) });
}));
api.get("/messages/:id/history", wrap(async (req, res) => {
  const row = await one(`${MSG_SELECT} WHERE m.id = $1`, [Number(req.params.id) || 0]);
  if (!row) return res.status(404).json({ error: "No such message." });
  if (!roomAccess(req, res, row.room)) return;
  res.json({ message: messageOut(row, req.user), history: (await q("SELECT * FROM revisions WHERE message_id = $1 ORDER BY id", [row.id])).map(revisionOut) });
}));

async function createMessage(req, res, roomId, body, extra = {}) {
  const now = Date.now();
  const mentions = parseMentions(body);
  const rules = await commandRules(req.user.id, mentions, roomId);
  if (rules.error) { res.status(rules.status).json({ error: rules.error, code: rules.code }); return null; }
  let status = null, assignee = null;
  if (roomId === "work") {
    status = extra.status ?? "todo";
    if (!STATUSES[status]) { res.status(400).json({ error: "status must be todo, in_progress or done." }); return null; }
    if (extra.assignee) { assignee = resolveMember(extra.assignee); if (!assignee) { res.status(400).json({ error: "Unknown assignee." }); return null; } }
  }
  const ins = await one(`INSERT INTO messages (room, author, body, mentions, commands, status, assignee, file_id, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
    [roomId, req.user.id, body, JSON.stringify(mentions), JSON.stringify(rules.commands), status, assignee, extra.fileId ?? null, now]);
  const row = await one(`${MSG_SELECT} WHERE m.id = $1`, [ins.id]);
  notify(noticesForMessage(row));
  return row;
}

api.post("/rooms/:room/messages", wrap(async (req, res) => {
  const room = roomAccess(req, res, req.params.room); if (!room) return;
  if (!MESSAGE_ROOMS.includes(room.id)) return res.status(400).json({ error: "Use /api/docs for Documents." });
  const body = String(req.body?.body ?? "").trim();
  if (!body) return res.status(400).json({ error: "Message body is required." });
  if (body.length > MAX_BODY) return res.status(400).json({ error: `Message is longer than ${MAX_BODY} characters.` });
  if (blocked(res, body)) return;
  const row = await createMessage(req, res, room.id, body, { status: req.body?.status, assignee: req.body?.assignee });
  if (row) res.status(201).json({ message: messageOut(row, req.user) });
}));

api.patch("/messages/:id", wrap(async (req, res) => {
  const row = await one(`${MSG_SELECT} WHERE m.id = $1`, [Number(req.params.id) || 0]);
  if (!row) return res.status(404).json({ error: "No such message." });
  if (!roomAccess(req, res, row.room)) return;
  if (row.room !== "work") return res.status(400).json({ error: "Only Work posts have a status and assignee." });
  let { status, assignee } = row;
  if (req.body?.status !== undefined) { if (!STATUSES[req.body.status]) return res.status(400).json({ error: "status must be todo, in_progress or done." }); status = req.body.status; }
  if (req.body?.assignee !== undefined) {
    if (req.body.assignee === null || req.body.assignee === "") assignee = null;
    else { assignee = resolveMember(req.body.assignee); if (!assignee) return res.status(400).json({ error: "Unknown assignee." }); }
  }
  await q("UPDATE messages SET status = $1, assignee = $2, updated_at = $3 WHERE id = $4", [status, assignee, Date.now(), row.id]);
  const changes = {};
  if (status !== row.status) changes.status = [row.status, status];
  if (assignee !== row.assignee) changes.assignee = [row.assignee, assignee];
  if (Object.keys(changes).length) await q("INSERT INTO revisions (message_id, actor, changes, at) VALUES ($1,$2,$3,$4)", [row.id, req.user.id, JSON.stringify(changes), Date.now()]);
  const updated = await one(`${MSG_SELECT} WHERE m.id = $1`, [row.id]);
  notify(noticesForReassign(updated, row.assignee, req.user.id));
  res.json({ message: messageOut(updated, req.user) });
}));

// ---------- files (private Vercel Blob) ----------
api.post("/rooms/:room/files", express.raw({ type: () => true, limit: MAX_FILE }), wrap(async (req, res) => {
  const room = roomAccess(req, res, req.params.room); if (!room) return;
  if (!MESSAGE_ROOMS.includes(room.id)) return res.status(400).json({ error: "Upload files to talk, work or owners." });
  const name = String(req.query.name || req.get("X-Filename") || "").replace(/[\/\\\0\r\n]/g, "_").trim().slice(0, 200);
  if (!name) return res.status(400).json({ error: "Give a file name with ?name=..." });
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) return res.status(400).json({ error: "Empty file." });
  if (buf.length > MAX_FILE) return res.status(413).json({ error: "File is over the 4 MB limit." });
  const caption = String(req.query.caption || "").trim().slice(0, MAX_BODY);
  if (blocked(res, name, caption)) return;
  const rules = await commandRules(req.user.id, parseMentions(caption), room.id);
  if (rules.error) return res.status(rules.status).json({ error: rules.error, code: rules.code });
  const mime = String(req.get("Content-Type") || "application/octet-stream").split(";")[0].slice(0, 100);
  const pathname = `${process.env.VERCEL_ENV === "production" ? "" : "test/"}files/${room.id}/${randomBytes(16).toString("hex")}`;
  await put(pathname, buf, { access: "private", contentType: "application/octet-stream", addRandomSuffix: false });
  const f = await one("INSERT INTO files (room, uploader, name, mime, size, stored, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [room.id, req.user.id, name, mime, buf.length, pathname, Date.now()]);
  const row = await createMessage(req, res, room.id, caption || `Uploaded ${name}`, { fileId: f.id, status: req.query.status, assignee: req.query.assignee });
  if (row) res.status(201).json({ file: { id: f.id, name, mime, size: buf.length, url: `/api/files/${f.id}` }, message: messageOut(row, req.user) });
}));

api.get("/files/:id", wrap(async (req, res) => {
  const f = await one("SELECT * FROM files WHERE id = $1", [Number(req.params.id) || 0]);
  if (!f) return res.status(404).json({ error: "No such file." });
  if (!roomAccess(req, res, f.room)) return;
  const b = await blobGet(f.stored, { access: "private" });
  if (!b || b.statusCode !== 200 || !b.stream) return res.status(410).json({ error: "File data missing." });
  res.set({ "Content-Type": "application/octet-stream", "Content-Length": f.size,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, "X-Original-Content-Type": f.mime });
  Readable.fromWeb(b.stream).pipe(res);
}));

// ---------- documents ----------
// Permanent record: every saved state of a doc is kept as a numbered version.
const saveVersion = (docId, title, body, author, source, suggestionId, at) => q(
  `INSERT INTO doc_versions (doc_id, version, title, body, author, source, suggestion_id, at)
   SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5, $6, $7 FROM doc_versions WHERE doc_id = $1`, [docId, title, body, author, source, suggestionId, at]);
api.get("/docs/:id/versions", wrap(async (req, res) => {
  const d = await one("SELECT id FROM docs WHERE id = $1", [Number(req.params.id) || 0]);
  if (!d) return res.status(404).json({ error: "No such document." });
  res.json({ versions: (await q("SELECT * FROM doc_versions WHERE doc_id = $1 ORDER BY version DESC", [d.id]))
    .map((v) => ({ version: v.version, title: v.title, body: v.body, author: v.author, authorName: member(v.author)?.name, source: v.source, suggestionId: v.suggestion_id, at: Number(v.at) })) });
}));
api.get("/docs", wrap(async (req, res) => {
  const o = req.query.owner ? resolveMember(req.query.owner) : null;
  const rows = o ? await q(`${DOC_SELECT} WHERE d.owner = $1 ORDER BY d.updated_at DESC`, [o]) : await q(`${DOC_SELECT} ORDER BY d.updated_at DESC`);
  res.json({ docs: rows.map(docSummary), serverTime: Date.now() });
}));
api.post("/docs", wrap(async (req, res) => {
  const title = String(req.body?.title ?? "").trim().slice(0, 200);
  const body = String(req.body?.body ?? "");
  if (!title) return res.status(400).json({ error: "Title is required." });
  if (body.length > MAX_DOC) return res.status(400).json({ error: "Document is too long." });
  if (blocked(res, title, body)) return;
  const now = Date.now();
  const d = await one("INSERT INTO docs (title, body, owner, created_at, updated_at, updated_by) VALUES ($1,$2,$3,$4,$4,$3) RETURNING *, 0 AS pending", [title, body, req.user.id, now]);
  await saveVersion(d.id, title, body, req.user.id, "create", null, now);
  res.status(201).json({ doc: { ...docSummary(d), body: d.body } });
}));
async function getDocOr404(req, res) {
  const d = await one(`${DOC_SELECT} WHERE d.id = $1`, [Number(req.params.id) || 0]);
  if (!d) res.status(404).json({ error: "No such document." });
  return d;
}
api.get("/docs/:id", wrap(async (req, res) => {
  const d = await getDocOr404(req, res); if (!d) return;
  const sug = (await q("SELECT * FROM suggestions WHERE doc_id = $1 ORDER BY id DESC", [d.id])).map(suggestionOut);
  res.json({ doc: { ...docSummary(d), body: d.body }, suggestions: sug, youAreOwner: d.owner === req.user.id });
}));
async function makeSuggestion(req, res, d) {
  const title = String(req.body?.title ?? d.title).trim().slice(0, 200) || d.title;
  const body = String(req.body?.body ?? "");
  const note = String(req.body?.note ?? "").trim().slice(0, 1000);
  if (body.length > MAX_DOC) return res.status(400).json({ error: "Document is too long." });
  if (title === d.title && body === d.body) return res.status(400).json({ error: "No changes to suggest." });
  if (blocked(res, title, body, note)) return;
  const s = await one(`INSERT INTO suggestions (doc_id, author, base_title, base_body, title, body, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [d.id, req.user.id, d.title, d.body, title, body, note, Date.now()]);
  notify(noticesForSuggestion(d, req.user.id));
  res.status(202).json({ suggested: true, suggestion: suggestionOut(s), message: `You don't own this doc, so your edit was saved as a suggestion for ${member(d.owner).name} to accept or reject.` });
}
api.put("/docs/:id", wrap(async (req, res) => {
  const d = await getDocOr404(req, res); if (!d) return;
  if (d.owner !== req.user.id) return makeSuggestion(req, res, d);
  const title = String(req.body?.title ?? d.title).trim().slice(0, 200) || d.title;
  const body = String(req.body?.body ?? d.body);
  if (body.length > MAX_DOC) return res.status(400).json({ error: "Document is too long." });
  if (blocked(res, title, body)) return;
  const at = Date.now();
  await q("UPDATE docs SET title = $1, body = $2, updated_at = $3, updated_by = $4 WHERE id = $5", [title, body, at, req.user.id, d.id]);
  await saveVersion(d.id, title, body, req.user.id, "edit", null, at);
  const nd = await one(`${DOC_SELECT} WHERE d.id = $1`, [d.id]);
  res.json({ suggested: false, doc: { ...docSummary(nd), body: nd.body } });
}));
api.post("/docs/:id/suggestions", wrap(async (req, res) => {
  const d = await getDocOr404(req, res); if (!d) return;
  if (d.owner === req.user.id) return res.status(400).json({ error: "You own this doc; edit it directly with PUT /api/docs/:id." });
  return makeSuggestion(req, res, d);
}));
api.get("/docs/:id/suggestions", wrap(async (req, res) => {
  const d = await getDocOr404(req, res); if (!d) return;
  res.json({ suggestions: (await q("SELECT * FROM suggestions WHERE doc_id = $1 ORDER BY id DESC", [d.id])).map(suggestionOut) });
}));
api.post("/suggestions/:id/:action", wrap(async (req, res) => {
  const { action } = req.params;
  if (action !== "accept" && action !== "reject") return res.status(404).json({ error: "Use accept or reject." });
  const s = await one("SELECT * FROM suggestions WHERE id = $1", [Number(req.params.id) || 0]);
  if (!s) return res.status(404).json({ error: "No such suggestion." });
  const d = await one("SELECT * FROM docs WHERE id = $1", [s.doc_id]);
  if (d.owner !== req.user.id) return res.status(403).json({ error: `Only the doc owner (${member(d.owner).name}) can ${action} suggestions.` });
  const now = Date.now();
  const upd = await one("UPDATE suggestions SET status = $1, decided_at = $2, decided_by = $3 WHERE id = $4 AND status = 'pending' RETURNING *",
    [action === "accept" ? "accepted" : "rejected", now, req.user.id, s.id]);
  if (!upd) return res.status(409).json({ error: `Suggestion is already ${s.status}.` });
  notify(noticesForDecision(d, s.author, req.user.id));
  if (action === "accept") {
    await q("UPDATE docs SET title = $1, body = $2, updated_at = $3, updated_by = $4 WHERE id = $5", [s.title, s.body, now, s.author, d.id]);
    await saveVersion(d.id, s.title, s.body, s.author, "suggestion", s.id, now);
  }
  const nd = await one(`${DOC_SELECT} WHERE d.id = $1`, [d.id]);
  res.json({ suggestion: suggestionOut(upd), doc: { ...docSummary(nd), body: nd.body }, staleBase: s.base_body !== d.body || s.base_title !== d.title });
}));

// Permanent record: nothing posted can be deleted, and message text can't be edited.
const PERMANENT = (_req, res) => res.status(405).set("Allow", "GET, POST, PATCH").json({ error: "Everything posted here is permanent. Messages, work posts, documents, suggestions and files can't be deleted.", code: "permanent_record" });
api.delete(/^\/(rooms|messages|docs|suggestions|files)(\/.*)?$/, PERMANENT);
api.put(/^\/messages(\/.*)?$/, PERMANENT);
api.use((_req, res) => res.status(404).json({ error: "Not found." }));
api.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Upload is over the 4 MB limit." });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  console.error(err);
  res.status(500).json({ error: "Server error." });
});
app.use((_req, res) => res.status(404).type("text/plain").send("Not found"));

export default app;

if (!process.env.VERCEL && process.argv[1]?.endsWith("server.js")) {
  const PORT = Number(process.env.PORT) || 3490;
  app.listen(PORT, () => console.log(`Field&Forms (Vercel edition, local) on http://127.0.0.1:${PORT}`));
}
