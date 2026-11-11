import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import cookieSession from "cookie-session";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, createReadStream, existsSync } from "node:fs";
import { initDb, getDb, getSessionSecret, attemptLogin, memberRow, ROOT, FILES_DIR } from "./lib/db.js";
import { member, listMembers, resolveMember, isBot, isHuman } from "./lib/members.js";
import { checkSensitive } from "./lib/filter.js";

const PORT = Number(process.env.PORT) || 3480;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_FILE = 4 * 1024 * 1024;
const MAX_BODY = 8000;
const MAX_DOC = 200_000;

const ROOMS = {
  talk: { id: "talk", name: "Talk", kind: "chat", humansOnly: false, description: "Shared chat for all four members." },
  work: { id: "work", name: "Work", kind: "work", humansOnly: false, description: "Tasks and updates with status and assignee." },
  docs: { id: "docs", name: "Documents", kind: "docs", humansOnly: false, description: "Shared docs. Non-owner edits become suggestions." },
  owners: { id: "owners", name: "Owners only", kind: "chat", humansOnly: true, description: "Private room for Dylan and Jacob. Bots cannot access it." },
};
const MESSAGE_ROOMS = ["talk", "work", "owners"];
const STATUSES = { todo: "To do", in_progress: "In progress", done: "Done" };

initDb();
const db = getDb();
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const httpServer = createServer(app);
const io = new Server(httpServer, { serveClient: true });

const session = cookieSession({
  name: "ffw",
  keys: [getSessionSecret()],
  maxAge: 14 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: "strict",
});

// ---------- headers: never indexed ----------
app.use((req, res, next) => {
  res.set({
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  next();
});
app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));
app.use(session);

// ---------- auth ----------
const headerCache = new Map(); // sha256(header) -> {id, pv, exp}

function parseAuthHeader(h) {
  if (!h) return null;
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

/** Returns {user} or {status, error} or null (no credentials). */
function authenticate(req) {
  const h = req.headers.authorization;
  if (h) {
    const key = createHash("sha256").update(h).digest("hex");
    const hit = headerCache.get(key);
    if (hit && hit.exp > Date.now()) {
      const row = memberRow(hit.id);
      if (row && row.pin_version === hit.pv && row.locked_until <= Date.now()) return { user: member(hit.id), via: "pin" };
      headerCache.delete(key);
    }
    const creds = parseAuthHeader(h);
    if (!creds) return { status: 401, error: "Bad Authorization header. Use Basic base64(Name:PIN) or 'Pin Name:PIN'." };
    const id = resolveMember(creds.name);
    if (!id) return { status: 401, error: "Unknown name or wrong PIN." };
    const r = attemptLogin(id, creds.pin);
    if (!r.ok) return { status: r.status, error: r.error };
    headerCache.set(key, { id, pv: r.pinVersion, exp: Date.now() + 60_000 });
    return { user: member(id), via: "pin" };
  }
  const s = req.session;
  if (s?.mid) {
    const row = memberRow(s.mid);
    if (row && row.pin_version === s.pv) return { user: member(s.mid), via: "session" };
    req.session = null;
  }
  return null;
}

function requireAuth(req, res, next) {
  const a = authenticate(req);
  if (!a) return res.status(401).json({ error: "Sign in required." });
  if (!a.user) return res.status(a.status).json({ error: a.error });
  // CSRF guard for cookie sessions: browsers can't add this header cross-site without CORS.
  if (a.via === "session" && req.method !== "GET" && req.method !== "HEAD" && req.get("X-FFW") !== "1")
    return res.status(403).json({ error: "Missing X-FFW header." });
  req.user = a.user;
  next();
}

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
function fileOut(id) {
  if (!id) return null;
  const f = db.prepare("SELECT id, name, mime, size FROM files WHERE id = ?").get(id);
  return f ? { id: f.id, name: f.name, mime: f.mime, size: f.size, url: `/api/files/${f.id}` } : null;
}
function messageOut(row, viewer) {
  const commands = parseJson(row.commands);
  const out = {
    id: row.id, room: row.room, author: row.author, authorName: member(row.author)?.name,
    body: row.body, mentions: parseJson(row.mentions), commands,
    commandKind: commands.length ? (isBot(row.author) ? "handoff" : "command") : null,
    file: fileOut(row.file_id), createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (row.room === "work") { out.status = row.status; out.statusLabel = STATUSES[row.status]; out.assignee = row.assignee; }
  if (viewer && isBot(viewer.id)) out.isCommandForMe = commands.includes(viewer.id);
  return out;
}
function docSummary(d) {
  const pending = db.prepare("SELECT COUNT(*) c FROM suggestions WHERE doc_id = ? AND status = 'pending'").get(d.id).c;
  return { id: d.id, title: d.title, owner: d.owner, ownerName: member(d.owner)?.name, createdAt: d.created_at, updatedAt: d.updated_at, updatedBy: d.updated_by, pendingSuggestions: pending };
}
function suggestionOut(s) {
  return { id: s.id, docId: s.doc_id, author: s.author, authorName: member(s.author)?.name, status: s.status, note: s.note,
    before: { title: s.base_title, body: s.base_body }, after: { title: s.title, body: s.body },
    createdAt: s.created_at, decidedAt: s.decided_at, decidedBy: s.decided_by };
}

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
export const HANDOFF_LIMIT = 10;
/**
 * Command rules:
 * - Either owner (Dylan or Jacob) @mentioning either bot = a valid "command" for that bot.
 * - A bot @mentioning the other bot = a valid "handoff" (command from a bot) for the receiver.
 * - Loop guard: at most HANDOFF_LIMIT bot-to-bot handoffs in a room since the last human message there.
 */
function commandRules(author, mentions, roomId) {
  const me = member(author);
  const targets = mentions.filter((m) => isBot(m) && m !== author);
  if (me.type === "bot" && targets.length) {
    const lastHuman = db.prepare("SELECT COALESCE(MAX(id), 0) id FROM messages WHERE room = ? AND author IN ('dylan','jacob')").get(roomId).id;
    const chain = db.prepare("SELECT author, commands FROM messages WHERE room = ? AND id > ? AND author IN ('dylan_bot','jacob_bot')").all(roomId, lastHuman)
      .filter((r) => parseJson(r.commands).length).length;
    if (chain >= HANDOFF_LIMIT)
      return { status: 429, code: "handoff_limit", error: `Loop guard: ${HANDOFF_LIMIT} bot-to-bot handoffs in a row in this room with no human message. Wait for Dylan or Jacob to post here before handing off again (plain messages without @ still work).` };
  }
  return { commands: targets, kind: targets.length ? (me.type === "bot" ? "handoff" : "command") : null };
}

// ---------- routes ----------
const api = express.Router();
app.use("/api", api);
const jsonParser = express.json({ limit: "512kb" });
api.use((req, res, next) => (/\/files$/.test(req.path) ? next() : jsonParser(req, res, next)));

api.get("/session", (req, res) => {
  const a = authenticate(req);
  res.json({ user: a?.user || null, members: listMembers().map(({ id, name, type }) => ({ id, name, type })) });
});

api.post("/login", (req, res) => {
  const id = resolveMember(req.body?.member);
  const pin = String(req.body?.pin ?? "");
  if (!id) return res.status(401).json({ error: "Pick your name." });
  const r = attemptLogin(id, pin);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  req.session = { mid: id, pv: r.pinVersion, n: randomBytes(4).toString("hex") };
  res.json({ user: member(id) });
});
api.post("/logout", (req, res) => { req.session = null; res.json({ ok: true }); });

api.use(requireAuth);

api.get("/whoami", (req, res) => {
  const u = req.user;
  res.json({ ...u, ownerName: u.owner ? member(u.owner).name : null,
    canAccessOwnersRoom: isHuman(u.id),
    takesCommandsFrom: u.type === "bot" ? u.owner : null });
});
api.get("/members", (_req, res) => res.json({ members: listMembers() }));
api.get("/rooms", (req, res) => {
  res.json({ rooms: Object.values(ROOMS).filter((r) => !r.humansOnly || isHuman(req.user.id)) });
});

api.get("/rooms/:room/messages", (req, res) => {
  const room = roomAccess(req, res, req.params.room); if (!room) return;
  if (!MESSAGE_ROOMS.includes(room.id)) return res.status(400).json({ error: "Documents has no messages; use /api/docs." });
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const where = ["room = ?"]; const args = [room.id];
  if (req.query.after) { where.push("id > ?"); args.push(Number(req.query.after)); }
  if (req.query.before) { where.push("id < ?"); args.push(Number(req.query.before)); }
  if (req.query.author) { const a = resolveMember(req.query.author); if (!a) return res.status(400).json({ error: "Unknown author." }); where.push("author = ?"); args.push(a); }
  if (req.query.status && room.id === "work") { where.push("status = ?"); args.push(String(req.query.status)); }
  const order = req.query.after ? "ASC" : "DESC";
  let rows = db.prepare(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY id ${order} LIMIT ?`).all(...args, limit);
  if (order === "DESC") rows = rows.reverse();
  res.json({ room: room.id, messages: rows.map((r) => messageOut(r, req.user)) });
});

function createMessage(req, res, roomId, body, extra = {}) {
  const now = Date.now();
  const mentions = parseMentions(body);
  const rules = commandRules(req.user.id, mentions, roomId);
  if (rules.error) { res.status(rules.status).json({ error: rules.error, code: rules.code }); return null; }
  let status = null, assignee = null;
  if (roomId === "work") {
    status = extra.status ?? "todo";
    if (!STATUSES[status]) { res.status(400).json({ error: "status must be todo, in_progress or done." }); return null; }
    if (extra.assignee) { assignee = resolveMember(extra.assignee); if (!assignee) { res.status(400).json({ error: "Unknown assignee." }); return null; } }
  }
  const r = db.prepare("INSERT INTO messages (room, author, body, mentions, commands, status, assignee, file_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(roomId, req.user.id, body, JSON.stringify(mentions), JSON.stringify(rules.commands), status, assignee, extra.fileId ?? null, now, now);
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(r.lastInsertRowid);
  broadcastMessage("message:new", row);
  return row;
}

function broadcastMessage(event, row) {
  for (const [, sock] of io.of("/").sockets) {
    const u = sock.data.user;
    if (!u) continue;
    if (ROOMS[row.room].humansOnly && !isHuman(u.id)) continue;
    sock.emit(event, messageOut(row, u));
  }
}

api.post("/rooms/:room/messages", (req, res) => {
  const room = roomAccess(req, res, req.params.room); if (!room) return;
  if (!MESSAGE_ROOMS.includes(room.id)) return res.status(400).json({ error: "Use /api/docs for Documents." });
  const body = String(req.body?.body ?? "").trim();
  if (!body) return res.status(400).json({ error: "Message body is required." });
  if (body.length > MAX_BODY) return res.status(400).json({ error: `Message is longer than ${MAX_BODY} characters.` });
  if (blocked(res, body)) return;
  const row = createMessage(req, res, room.id, body, { status: req.body?.status, assignee: req.body?.assignee });
  if (row) res.status(201).json({ message: messageOut(row, req.user) });
});

api.patch("/messages/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "No such message." });
  if (!roomAccess(req, res, row.room)) return;
  if (row.room !== "work") return res.status(400).json({ error: "Only Work posts have a status and assignee." });
  let { status, assignee } = row;
  if (req.body?.status !== undefined) { if (!STATUSES[req.body.status]) return res.status(400).json({ error: "status must be todo, in_progress or done." }); status = req.body.status; }
  if (req.body?.assignee !== undefined) {
    if (req.body.assignee === null || req.body.assignee === "") assignee = null;
    else { assignee = resolveMember(req.body.assignee); if (!assignee) return res.status(400).json({ error: "Unknown assignee." }); }
  }
  db.prepare("UPDATE messages SET status = ?, assignee = ?, updated_at = ? WHERE id = ?").run(status, assignee, Date.now(), row.id);
  const updated = db.prepare("SELECT * FROM messages WHERE id = ?").get(row.id);
  broadcastMessage("message:update", updated);
  res.json({ message: messageOut(updated, req.user) });
});

// ---------- files ----------
api.post("/rooms/:room/files", express.raw({ type: () => true, limit: MAX_FILE }), (req, res) => {
  const room = roomAccess(req, res, req.params.room); if (!room) return;
  if (!MESSAGE_ROOMS.includes(room.id)) return res.status(400).json({ error: "Upload files to talk, work or owners." });
  const name = String(req.query.name || req.get("X-Filename") || "").replace(/[\/\\\0\r\n]/g, "_").trim().slice(0, 200);
  if (!name) return res.status(400).json({ error: "Give a file name with ?name=..." });
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) return res.status(400).json({ error: "Empty file." });
  if (buf.length > MAX_FILE) return res.status(413).json({ error: "File is over the 4 MB limit." });
  const caption = String(req.query.caption || "").trim().slice(0, MAX_BODY);
  if (blocked(res, name, caption)) return;
  const mentions = parseMentions(caption);
  const rules = commandRules(req.user.id, mentions, room.id);
  if (rules.error) return res.status(rules.status).json({ error: rules.error, code: rules.code });
  const stored = randomBytes(16).toString("hex");
  writeFileSync(join(FILES_DIR, stored), buf, { mode: 0o600 });
  const mime = String(req.get("Content-Type") || "application/octet-stream").split(";")[0].slice(0, 100);
  const f = db.prepare("INSERT INTO files (room, uploader, name, mime, size, stored, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(room.id, req.user.id, name, mime, buf.length, stored, Date.now());
  const row = createMessage(req, res, room.id, caption || `Uploaded ${name}`, { fileId: Number(f.lastInsertRowid), status: req.query.status, assignee: req.query.assignee });
  if (row) res.status(201).json({ file: fileOut(Number(f.lastInsertRowid)), message: messageOut(row, req.user) });
});

api.get("/files/:id", (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE id = ?").get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: "No such file." });
  if (!roomAccess(req, res, f.room)) return;
  const p = join(FILES_DIR, f.stored);
  if (!existsSync(p)) return res.status(410).json({ error: "File data missing." });
  res.set({ "Content-Type": "application/octet-stream", "Content-Length": f.size,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, "X-Original-Content-Type": f.mime });
  createReadStream(p).pipe(res);
});

// ---------- documents ----------
api.get("/docs", (req, res) => {
  let rows = db.prepare("SELECT * FROM docs ORDER BY updated_at DESC").all();
  if (req.query.owner) { const o = resolveMember(req.query.owner); rows = rows.filter((d) => d.owner === o); }
  res.json({ docs: rows.map(docSummary) });
});
api.post("/docs", (req, res) => {
  const title = String(req.body?.title ?? "").trim().slice(0, 200);
  const body = String(req.body?.body ?? "");
  if (!title) return res.status(400).json({ error: "Title is required." });
  if (body.length > MAX_DOC) return res.status(400).json({ error: "Document is too long." });
  if (blocked(res, title, body)) return;
  const now = Date.now();
  const r = db.prepare("INSERT INTO docs (title, body, owner, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?)").run(title, body, req.user.id, now, now, req.user.id);
  const d = db.prepare("SELECT * FROM docs WHERE id = ?").get(r.lastInsertRowid);
  io.emit("doc:update", { id: d.id });
  res.status(201).json({ doc: { ...docSummary(d), body: d.body } });
});
function getDocOr404(req, res) {
  const d = db.prepare("SELECT * FROM docs WHERE id = ?").get(Number(req.params.id));
  if (!d) res.status(404).json({ error: "No such document." });
  return d;
}
api.get("/docs/:id", (req, res) => {
  const d = getDocOr404(req, res); if (!d) return;
  const sug = db.prepare("SELECT * FROM suggestions WHERE doc_id = ? ORDER BY id DESC").all(d.id).map(suggestionOut);
  res.json({ doc: { ...docSummary(d), body: d.body }, suggestions: sug, youAreOwner: d.owner === req.user.id });
});
function makeSuggestion(req, res, d) {
  const title = String(req.body?.title ?? d.title).trim().slice(0, 200) || d.title;
  const body = String(req.body?.body ?? "");
  const note = String(req.body?.note ?? "").trim().slice(0, 1000);
  if (body.length > MAX_DOC) return res.status(400).json({ error: "Document is too long." });
  if (title === d.title && body === d.body) return res.status(400).json({ error: "No changes to suggest." });
  if (blocked(res, title, body, note)) return;
  const r = db.prepare("INSERT INTO suggestions (doc_id, author, base_title, base_body, title, body, note, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(d.id, req.user.id, d.title, d.body, title, body, note, Date.now());
  const s = db.prepare("SELECT * FROM suggestions WHERE id = ?").get(r.lastInsertRowid);
  io.emit("doc:update", { id: d.id });
  res.status(202).json({ suggested: true, suggestion: suggestionOut(s), message: `You don't own this doc, so your edit was saved as a suggestion for ${member(d.owner).name} to accept or reject.` });
}
api.put("/docs/:id", (req, res) => {
  const d = getDocOr404(req, res); if (!d) return;
  if (d.owner !== req.user.id) return makeSuggestion(req, res, d);
  const title = String(req.body?.title ?? d.title).trim().slice(0, 200) || d.title;
  const body = String(req.body?.body ?? d.body);
  if (body.length > MAX_DOC) return res.status(400).json({ error: "Document is too long." });
  if (blocked(res, title, body)) return;
  db.prepare("UPDATE docs SET title = ?, body = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(title, body, Date.now(), req.user.id, d.id);
  io.emit("doc:update", { id: d.id });
  const nd = db.prepare("SELECT * FROM docs WHERE id = ?").get(d.id);
  res.json({ suggested: false, doc: { ...docSummary(nd), body: nd.body } });
});
api.post("/docs/:id/suggestions", (req, res) => {
  const d = getDocOr404(req, res); if (!d) return;
  if (d.owner === req.user.id) return res.status(400).json({ error: "You own this doc; edit it directly with PUT /api/docs/:id." });
  makeSuggestion(req, res, d);
});
api.get("/docs/:id/suggestions", (req, res) => {
  const d = getDocOr404(req, res); if (!d) return;
  res.json({ suggestions: db.prepare("SELECT * FROM suggestions WHERE doc_id = ? ORDER BY id DESC").all(d.id).map(suggestionOut) });
});
api.post("/suggestions/:id/:action", (req, res) => {
  const { action } = req.params;
  if (action !== "accept" && action !== "reject") return res.status(404).json({ error: "Use accept or reject." });
  const s = db.prepare("SELECT * FROM suggestions WHERE id = ?").get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: "No such suggestion." });
  const d = db.prepare("SELECT * FROM docs WHERE id = ?").get(s.doc_id);
  if (d.owner !== req.user.id) return res.status(403).json({ error: `Only the doc owner (${member(d.owner).name}) can ${action} suggestions.` });
  if (s.status !== "pending") return res.status(409).json({ error: `Suggestion is already ${s.status}.` });
  const now = Date.now();
  if (action === "accept") db.prepare("UPDATE docs SET title = ?, body = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(s.title, s.body, now, s.author, d.id);
  db.prepare("UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?").run(action === "accept" ? "accepted" : "rejected", now, req.user.id, s.id);
  io.emit("doc:update", { id: d.id });
  const nd = db.prepare("SELECT * FROM docs WHERE id = ?").get(d.id);
  res.json({ suggestion: suggestionOut(db.prepare("SELECT * FROM suggestions WHERE id = ?").get(s.id)), doc: { ...docSummary(nd), body: nd.body },
    staleBase: s.base_body !== d.body || s.base_title !== d.title });
});

api.use((_req, res) => res.status(404).json({ error: "Not found." }));
api.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Upload is over the 4 MB limit." });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

// ---------- pages ----------
const PUB = join(ROOT, "public");
app.get("/api-docs", (_req, res) => res.sendFile(join(PUB, "api-docs.html")));
app.get("/sw.js", (_req, res) => { res.set("Service-Worker-Allowed", "/"); res.set("Cache-Control", "no-cache"); res.sendFile(join(PUB, "sw.js")); });
app.use(express.static(PUB, { index: "index.html", extensions: ["html"] }));
app.use((_req, res) => res.status(404).type("text/plain").send("Not found"));

// ---------- websocket ----------
io.engine.use(session);
io.use((socket, next) => {
  const req = socket.request;
  const a = authenticate(req);
  if (!a?.user) return next(new Error("unauthorized"));
  socket.data.user = a.user;
  next();
});
io.on("connection", (socket) => {
  socket.emit("hello", { user: socket.data.user });
});

httpServer.listen(PORT, HOST, () => console.log(`Field&Forms Research Workspace on http://${HOST}:${PORT}`));
