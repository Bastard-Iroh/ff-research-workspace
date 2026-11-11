// Read-only production checks: posts nothing, changes no content. PINs are read from CREDENTIALS.txt and never printed.
import { readCreds } from "./creds.mjs";
const BASE = process.env.FFW_URL || "https://ff-research-workspace.vercel.app";
const C = readCreds();
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const basic = (id) => "Basic " + Buffer.from(`${id}:${C[id]}`).toString("base64");
const get = async (path, auth, method = "GET", body) => {
  const h = auth ? (auth.startsWith("Basic") ? { Authorization: auth } : { Cookie: auth, "X-FFW": "1" }) : {};
  if (body) h["Content-Type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers: h, body: body && JSON.stringify(body) });
  return { status: r.status, headers: r.headers, data: (r.headers.get("content-type") || "").includes("json") ? await r.json() : await r.text() };
};
const login = async (id) => (await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member: id, pin: C[id] }) })).headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

const robots = await get("/robots.txt");
check("robots.txt disallows all", /Disallow: \//.test(robots.data));
for (const p of ["/", "/transcript.html", "/api-docs"]) { const r = await get(p); check(`${p} 200 + X-Robots-Tag noindex`, r.status === 200 && /noindex/.test(r.headers.get("x-robots-tag") || "")); }
const docs = await get("/api-docs");
check("api-docs documents webhooks, permanent record and transcripts", /Webhooks/.test(docs.data) && /Permanent record/.test(docs.data) && /\/transcript/.test(docs.data));
check("manifest + service worker served", (await get("/manifest.webmanifest")).status === 200 && (await get("/sw.js")).status === 200);
check("no sign-in → 401 (whoami, transcript)", (await get("/api/whoami")).status === 401 && (await get("/api/rooms/talk/transcript")).status === 401);
check("webhook test sink disabled on production (404)", (await get("/api/webhook-test-sink/x".padEnd(60, "x"), null, "POST", {})).status === 404);
for (const bot of ["dylan_bot", "jacob_bot"]) {
  const w = await get("/api/whoami", basic(bot));
  check(`${bot}: API sign-in works`, w.status === 200 && w.data.id === bot);
  const m = await get("/api/rooms/talk/messages", basic(bot));
  check(`${bot}: Talk returns at most the latest 50 + hasMore flag`, m.status === 200 && m.data.messages.length <= 50 && typeof m.data.hasMore === "boolean", `${m.data.messages?.length} items, hasMore=${m.data.hasMore}`);
  const t = await get("/api/rooms/talk/transcript?page=1&pageSize=20", basic(bot));
  check(`${bot}: Talk transcript paginated`, t.status === 200 && t.data.pageSize === 20 && t.data.totalPages === Math.max(1, Math.ceil(t.data.total / 20)), `${t.data.total} total`);
  check(`${bot}: Owners only transcript → 403`, (await get("/api/rooms/owners/transcript", basic(bot))).status === 403);
  check(`${bot}: webhooks settings → 403`, (await get("/api/webhooks", basic(bot))).status === 403);
  const id = m.data.messages?.[0]?.id || 1;
  const del = await get(`/api/messages/${id}`, basic(bot), "DELETE"), put = await get(`/api/messages/${id}`, basic(bot), "PUT", { body: "x" });
  check(`${bot}: DELETE/PUT message → 405 permanent_record`, del.status === 405 && put.status === 405 && del.data.code === "permanent_record");
  check(`${bot}: DELETE doc/file/suggestion → 405`, (await Promise.all(["/api/docs/1", "/api/files/1", "/api/suggestions/1"].map((p) => get(p, basic(bot), "DELETE")))).every((r) => r.status === 405));
}
for (const human of ["dylan", "jacob"]) {
  const ck = await login(human);
  const o = await get("/api/rooms/owners/transcript", ck);
  check(`${human}: Owners only transcript visible`, o.status === 200 && o.data.room === "owners");
  const w = await get("/api/webhooks", ck);
  check(`${human}: Settings lists both bots' webhooks`, w.status === 200 && w.data.webhooks.length === 2);
  const d = await get("/api/docs", ck);
  if (d.data.docs?.length) { const v = await get(`/api/docs/${d.data.docs[0].id}/versions`, ck); check(`${human}: doc version history readable`, v.status === 200 && v.data.versions.length >= 1); }
  const dl = await get("/api/docs/1", ck, "DELETE");
  check(`${human}: DELETE doc → 405`, dl.status === 405);
}
console.log(`\n${results.filter(Boolean).length}/${results.length} read-only production checks passed`);
process.exitCode = results.every(Boolean) ? 0 : 1;
