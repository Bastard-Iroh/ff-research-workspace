// Bot webhooks: compute which bots to notify, and deliver a tiny JSON notice safely.
// Shared by the live (Vercel) and box versions. Payload is exactly {type, room, itemId, author, time}.
import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import http from "node:http";
import https from "node:https";

export const BOTS = { dylan_bot: "dylan", jacob_bot: "jacob" };    // bot -> human who manages its webhook
const HUMANS = new Set(["dylan", "jacob"]);
const TIMEOUT_MS = 4000;
const RETRY_DELAY_MS = 1000;

// ---------- who gets notified ----------
// Most specific type wins: assignment > handoff > mention > owner_message. Never Owners only, never the bot's own action.
export function noticesForMessage(msg) {
  if (msg.room === "owners") return [];
  const commands = Array.isArray(msg.commands) ? msg.commands : JSON.parse(msg.commands || "[]");
  const out = [];
  for (const bot of Object.keys(BOTS)) {
    if (bot === msg.author) continue;
    let type = null;
    if (msg.room === "work" && msg.assignee === bot) type = "assignment";
    else if (commands.includes(bot)) type = BOTS[msg.author] ? "handoff" : "mention";
    else if (HUMANS.has(msg.author)) type = "owner_message";
    if (type) out.push({ bot, type, room: msg.room, itemId: msg.id, author: msg.author });
  }
  return out;
}
export function noticesForReassign(msg, oldAssignee, actor) {
  if (msg.room !== "work" || !BOTS[msg.assignee] || msg.assignee === oldAssignee || msg.assignee === actor) return [];
  return [{ bot: msg.assignee, type: "assignment", room: "work", itemId: msg.id, author: actor }];
}
export function noticesForSuggestion(doc, suggestionAuthor) {
  if (!BOTS[doc.owner] || doc.owner === suggestionAuthor) return [];
  return [{ bot: doc.owner, type: "suggestion", room: "docs", itemId: doc.id, author: suggestionAuthor }];
}
export function noticesForDecision(doc, suggestionAuthor, decider) {
  if (!BOTS[suggestionAuthor] || suggestionAuthor === decider) return [];
  return [{ bot: suggestionAuthor, type: "suggestion", room: "docs", itemId: doc.id, author: decider }];
}

// ---------- URL safety (SSRF guard) ----------
const blocked = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]])
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]])
  blocked.addSubnet(net, bits, "ipv6");
const METADATA_HOSTS = new Set(["metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal", "metadata.azure.com", "kubernetes.default", "kubernetes.default.svc"]);
const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function ipBlocked(addr) {
  const fam = isIP(addr);
  if (fam === 6) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:XXXX:XXXX): check the embedded IPv4 address.
    // (A "::ffff:0:0/96" BlockList rule would also match every plain IPv4 address, so it isn't used.)
    const norm = new URL(`http://[${addr}]/`).hostname.slice(1, -1).toLowerCase();
    const m = norm.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (m) { const n = (parseInt(m[1], 16) << 16 >>> 0) + parseInt(m[2], 16); return blocked.check([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join("."), "ipv4"); }
    return blocked.check(addr, "ipv6");
  }
  return fam === 4 ? blocked.check(addr, "ipv4") : true;
}
const isLoopback = (a) => /^127\./.test(a) || a === "::1" || a === "::ffff:127.0.0.1";

/** Static checks. opts.allowLocalHttp: box version may use http://localhost. Returns {url, local} or throws. */
export function checkUrlShape(raw, opts = {}) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw new Error("Not a valid URL."); }
  if (String(raw).length > 500) throw new Error("URL is too long (500 max).");
  if (u.username || u.password) throw new Error("URLs with a username or password aren't allowed.");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = LOCAL_NAMES.has(host) || LOCAL_NAMES.has(u.hostname.toLowerCase());
  if (u.protocol === "http:") {
    if (!(opts.allowLocalHttp && local)) throw new Error(opts.allowLocalHttp ? "Use https:// (http:// is only allowed for localhost)." : "Webhook URL must use https://.");
  } else if (u.protocol !== "https:") throw new Error("Webhook URL must use https://.");
  if (METADATA_HOSTS.has(host) || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("That host isn't allowed.");
  if (local && !opts.allowLocalHttp) throw new Error("Private and loopback addresses aren't allowed.");
  if (isIP(host) && ipBlocked(host) && !(opts.allowLocalHttp && local && isLoopback(host))) throw new Error("Private, loopback and link-local addresses aren't allowed.");
  return { url: u, host, local };
}
/** Resolve and check every address (blocks private/loopback/link-local after DNS). Returns the address to connect to. */
export async function resolveSafe(host, local, opts = {}) {
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length) throw new Error("Host did not resolve.");
  for (const a of addrs) {
    if (opts.allowLocalHttp && local && isLoopback(a.address)) continue;
    if (ipBlocked(a.address)) throw new Error("Host resolves to a private, loopback or link-local address.");
  }
  return addrs[0];
}
export async function validateWebhookUrl(raw, opts = {}) {
  const { url, host, local } = checkUrlShape(raw, opts);
  await resolveSafe(host, local, opts);
  return url.toString();
}

// ---------- delivery ----------
export const newSecret = () => "whsec_" + randomBytes(24).toString("base64url");
export const sign = (secret, body) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

function postOnce(rawUrl, body, headers, opts) {
  return new Promise(async (resolve) => {
    let target;
    try {
      const { url, host, local } = checkUrlShape(rawUrl, opts);
      const addr = await resolveSafe(host, local, opts);
      target = { url, addr };
    } catch (e) { return resolve({ ok: false, status: "blocked", error: e.message, retry: false }); }
    const { url, addr } = target;
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || undefined, path: url.pathname + url.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "FieldForms-Webhook/1", ...headers },
      // Pin the connection to the address we already checked (no DNS-rebinding window).
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
      timeout: TIMEOUT_MS,
    }, (res) => {
      res.resume();
      const code = res.statusCode;
      // Redirects are never followed.
      resolve({ ok: code >= 200 && code < 300, status: String(code), error: code >= 300 && code < 400 ? "redirect not followed" : null, retry: code >= 500 });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ ok: false, status: "error", error: e.message === "timeout" ? `timed out after ${TIMEOUT_MS / 1000}s` : e.code || e.message, retry: true }));
    req.end(body);
  });
}

/** Deliver one notice (max 1 retry on network error or 5xx). Returns a status record. */
export async function deliver(hook, notice, opts = {}) {
  const payload = { type: notice.type, room: notice.room, itemId: notice.itemId, author: notice.author, time: new Date(notice.time ?? Date.now()).toISOString() };
  const body = JSON.stringify(payload);
  const headers = { "X-FFW-Event": notice.type };
  if (hook.secret) headers["X-FFW-Signature"] = sign(hook.secret, body);
  let r = await postOnce(hook.url, body, headers, opts);
  let attempts = 1;
  if (!r.ok && r.retry) { await new Promise((s) => setTimeout(s, RETRY_DELAY_MS)); r = await postOnce(hook.url, body, headers, opts); attempts = 2; }
  return { ok: r.ok, status: r.status, error: r.error || null, type: notice.type, at: Date.now(), attempts, payload };
}
