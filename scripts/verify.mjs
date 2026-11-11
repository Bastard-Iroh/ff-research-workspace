// End-to-end verification. Reads PINs from CREDENTIALS.txt and never prints them.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { runWebhookTests } from "./verify-webhooks.mjs";
import { runPermanentTests } from "./verify-permanent.mjs";
import { runBotPinTests } from "./verify-bot-pin.mjs";
import { runJacobWebhookUiTests } from "./verify-jacob-webhook-ui.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.FFW_URL || "https://ff-research-workspace.vercel.app";
const SHOTS = join(ROOT, "screenshots");
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const BYPASS = process.env.FFW_BYPASS_FILE ? readFileSync(process.env.FFW_BYPASS_FILE, "utf8").trim() : "";
if (BYPASS) { // protected preview deployment: add the automation bypass header to every request
  const f0 = globalThis.fetch;
  globalThis.fetch = (u, o = {}) => f0(u, { ...o, headers: { ...(o.headers || {}), "x-vercel-protection-bypass": BYPASS } });
}
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const clickJs = (page, sel) => page.$eval(sel, (e) => e.click());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CRED_PATH = process.env.FFW_CREDENTIALS || "/workspace/ff-workspace/CREDENTIALS.txt";
function creds() { const o = {}; for (const l of readFileSync(CRED_PATH, "utf8").split("\n")) { const m = l.match(/^([a-z_]+)\s*\|[^|]*\|\s*(\S+)\s*$/); if (m) o[m[1]] = m[2]; } return o; }
let C = creds();
const admin = (...a) => execFileSync("node", [join(ROOT, "scripts/admin.mjs"), ...a], { encoding: "utf8" });
const basic = (id, pin = C[id]) => "Basic " + Buffer.from(`${id}:${pin}`).toString("base64");
async function call(id, method, path, body, extraHeaders = {}) {
  const headers = { Authorization: typeof id === "string" && C[id] ? basic(id) : id, ...extraHeaders };
  let payload = body;
  if (body && !(body instanceof Buffer) && typeof body !== "string") { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, headers: r.headers, data: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const tag = Date.now().toString(36);

// ---------- public / indexing / PWA ----------
{
  const robots = await (await fetch(BASE + "/robots.txt")).text();
  check("robots.txt disallows all", /User-agent: \*\s*\nDisallow: \/\s*$/.test(robots));
  const home = await fetch(BASE + "/");
  const html = await home.text();
  check("X-Robots-Tag noindex header", /noindex/.test(home.headers.get("x-robots-tag")));
  check("meta robots noindex in HTML", /<meta name="robots" content="noindex/.test(html));
  const docs = await fetch(BASE + "/api-docs"); const dt = await docs.text();
  check("/api-docs page", docs.status === 200 && dt.includes("Field&amp;Forms Bot API") && dt.includes("isCommandForMe") && /noindex/.test(docs.headers.get("x-robots-tag")));
  const man = await (await fetch(BASE + "/manifest.webmanifest")).json();
  const i192 = await fetch(BASE + "/icons/icon-192.png"), i512 = await fetch(BASE + "/icons/icon-512.png"), sw = await fetch(BASE + "/sw.js");
  check("PWA manifest + icons + service worker", man.display === "standalone" && man.icons.length === 2 && i192.status === 200 && i512.status === 200 && sw.status === 200, `name="${man.name}"`);
  const signup = await fetch(BASE + "/api/signup", { method: "POST" });
  check("no sign-up endpoint", signup.status === 401 || signup.status === 404, `status ${signup.status}`);
}

// ---------- bot API ----------
{
  const w = await call("dylan_bot", "GET", "/api/whoami");
  check("bot whoami (Basic auth)", w.status === 200 && w.data.id === "dylan_bot" && w.data.owner === "dylan" && w.data.canAccessOwnersRoom === false);
  const w2 = await call(`Pin Dylan's Bot:${C.dylan_bot}`, "GET", "/api/whoami");
  check("bot whoami ('Pin Name:PIN' header, display name)", w2.status === 200 && w2.data.id === "dylan_bot");
  const noauth = await fetch(BASE + "/api/whoami");
  check("API without credentials -> 401", noauth.status === 401);
  const rooms = await call("dylan_bot", "GET", "/api/rooms");
  check("bot room list hides Owners only", rooms.status === 200 && rooms.data.rooms.map((r) => r.id).join(",") === "talk,work,docs");
  const mem = await call("dylan_bot", "GET", "/api/members");
  check("exactly 4 members", mem.data.members.length === 4);
  for (const [m, p, b] of [["GET", "/api/rooms/owners/messages"], ["POST", "/api/rooms/owners/messages", { body: "hi" }], ["POST", "/api/rooms/owners/files?name=a.txt", Buffer.from("x")]]) {
    const r = await call("jacob_bot", m, p, b);
    check(`bot ${m} ${p.split("?")[0]} -> 403`, r.status === 403, r.data.error);
  }
}

// ---------- human session via API (to seed owners content) ----------
async function sessionFor(id) {
  const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member: id, pin: C[id] }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { cookie, fetch: (method, path, body, h = {}) => fetch(BASE + path, { method, headers: { Cookie: cookie, "X-FFW": "1", ...(body && !(body instanceof Buffer) ? { "Content-Type": "application/json" } : {}), ...h }, body: body instanceof Buffer ? body : body && JSON.stringify(body) }).then(async (x) => ({ status: x.status, data: await x.json().catch(() => null) })) };
}
const dylanS = await sessionFor("dylan");
const jacobS = await sessionFor("jacob");
{
  const csrf = await fetch(BASE + "/api/rooms/talk/messages", { method: "POST", headers: { Cookie: dylanS.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ body: "x" }) });
  check("cookie session write without X-FFW header rejected (CSRF guard)", csrf.status === 403);
  // polling: bots never get Owners-only content
  const o = await dylanS.fetch("POST", "/api/rooms/owners/messages", { body: `Owners-only note ${tag}: budget review Friday.` });
  const t = await dylanS.fetch("POST", "/api/rooms/talk/messages", { body: `Welcome to the workspace ${tag}. @dylans-bot please summarize the field notes.` });
  check("human posts in Owners only", o.status === 201);
  const pollT = await call("dylan_bot", "GET", `/api/rooms/talk/messages?since=${t.data.message.createdAt - 5000}`);
  const pollO = await call("dylan_bot", "GET", `/api/rooms/owners/messages?since=0`);
  check("bot polling (since=) sees new Talk message", pollT.data.messages.some((m) => m.id === t.data.message.id));
  check("bot polling never returns Owners-only messages (403)", pollO.status === 403 && !pollT.data.messages.some((m) => m.room === "owners"));
  // owners file not readable by bot
  const f = await dylanS.fetch("POST", "/api/rooms/owners/files?name=private.txt", Buffer.from("owners only"), { "Content-Type": "text/plain" });
  const bf = await call("dylan_bot", "GET", `/api/files/${f.data.file.id}`);
  check("bot download of Owners-only file -> 403", f.status === 201 && bf.status === 403);

  // ---------- command rules ----------
  const latest = async (bot, id) => (await call(bot, "GET", `/api/rooms/talk/messages?after=${id - 1}`)).data.messages.find((m) => m.id === id);
  const mD = await latest("dylan_bot", t.data.message.id), mJ = await latest("jacob_bot", t.data.message.id);
  check("Dylan commands Dylan's Bot (isCommandForMe true, kind command)", mD.isCommandForMe === true && mD.commandKind === "command");
  check("message to Dylan's Bot is not a command for Jacob's Bot", mJ.isCommandForMe === false);
  const jm = await jacobS.fetch("POST", "/api/rooms/talk/messages", { body: "@dylans-bot can you also check the map?" });
  const jmD = await latest("dylan_bot", jm.data.message.id);
  check("Jacob commands Dylan's Bot", jm.status === 201 && jmD.isCommandForMe === true && jmD.commandKind === "command");
  const dm = await dylanS.fetch("POST", "/api/rooms/talk/messages", { body: "@jacobs-bot please pull the soil sample list." });
  const dmJ = await latest("jacob_bot", dm.data.message.id);
  check("Dylan commands Jacob's Bot", dm.status === 201 && dmJ.isCommandForMe === true && dmJ.commandKind === "command");
  const both = await jacobS.fetch("POST", "/api/rooms/talk/messages", { body: "@dylans-bot and @jacobs-bot sync up on the map." });
  check("one owner message can command both bots", both.data.message.commands.length === 2);
  const ho = await call("dylan_bot", "POST", "/api/rooms/talk/messages", { body: "@jacobs-bot handing off: run the export now" });
  const hoJ = ho.status === 201 && await latest("jacob_bot", ho.data.message.id);
  const hoD = ho.status === 201 && await latest("dylan_bot", ho.data.message.id);
  check("bot-to-bot handoff accepted (receiver isCommandForMe true, kind handoff)", ho.status === 201 && hoJ.isCommandForMe === true && hoJ.commandKind === "handoff" && hoD.isCommandForMe === false, ho.data.error || "");
  const self = await call("dylan_bot", "POST", "/api/rooms/talk/messages", { body: "@dylans-bot note to self" });
  check("bot mentioning itself is not a command", self.status === 201 && self.data.message.commands.length === 0);
  // loop guard: fresh human message, then 10 handoffs OK, 11th rejected, plain message OK, human resets
  await dylanS.fetch("POST", "/api/rooms/talk/messages", { body: "Bots, coordinate the survey between you." });
  let okCount = 0;
  for (let i = 0; i < 10; i++) {
    const [from, to] = i % 2 ? ["jacob_bot", "dylans-bot"] : ["dylan_bot", "jacobs-bot"];
    const r = await call(from, "POST", "/api/rooms/talk/messages", { body: `@${to} handoff step ${i + 1}` });
    if (r.status === 201) okCount++;
  }
  const eleventh = await call("dylan_bot", "POST", "/api/rooms/talk/messages", { body: "@jacobs-bot handoff step 11" });
  check("loop guard: 10 handoffs allowed, 11th rejected (429 handoff_limit)", okCount === 10 && eleventh.status === 429 && eleventh.data.code === "handoff_limit", eleventh.data.error);
  const plain = await call("dylan_bot", "POST", "/api/rooms/talk/messages", { body: "Jacob's Bot, pausing until a human checks in." });
  check("loop guard: plain bot message (no @) still allowed", plain.status === 201);
  const wr = await call("jacob_bot", "POST", "/api/rooms/work/messages", { body: "@dylans-bot take the north plots" });
  check("loop guard is per room (Work handoff still allowed)", wr.status === 201 && wr.data.message.commandKind === "handoff");
  await jacobS.fetch("POST", "/api/rooms/talk/messages", { body: "Checked in. Carry on." });
  const resumed = await call("dylan_bot", "POST", "/api/rooms/talk/messages", { body: "@jacobs-bot resuming handoff" });
  check("loop guard: human message resets the chain", resumed.status === 201);
  const ownersCmd = await call("jacob_bot", "POST", "/api/rooms/owners/messages", { body: "@dylans-bot hi" });
  check("bot handoff into Owners only still 403", ownersCmd.status === 403);
  await call("jacob_bot", "POST", "/api/rooms/talk/messages", { body: "Thanks Dylan's Bot. I'm reviewing the survey responses for Jacob." });

  // ---------- work ----------
  const wp = await call("dylan_bot", "POST", "/api/rooms/work/messages", { body: `Compile site survey results ${tag}`, status: "in_progress", assignee: "dylan_bot" });
  check("bot creates Work post with status + assignee", wp.status === 201 && wp.data.message.status === "in_progress" && wp.data.message.assignee === "dylan_bot");
  const pp = await call("jacob_bot", "PATCH", `/api/messages/${wp.data.message.id}`, { status: "done", assignee: "jacob" });
  check("Work status/assignee editable", pp.status === 200 && pp.data.message.status === "done" && pp.data.message.assignee === "jacob");
  const bad = await call("jacob_bot", "PATCH", `/api/messages/${wp.data.message.id}`, { status: "maybe" });
  check("invalid status rejected", bad.status === 400);
  const filt = await call("jacob_bot", "GET", "/api/rooms/talk/messages?author=dylan_bot");
  check("people filter (author=) returns only that member", filt.data.messages.length > 0 && filt.data.messages.every((m) => m.author === "dylan_bot"));

  // ---------- documents ----------
  const d = await call("jacob_bot", "POST", "/api/docs", { title: `Survey method ${tag}`, body: "Step 1: walk the site.\nStep 2: take photos." });
  check("bot creates document (becomes owner)", d.status === 201 && d.data.doc.owner === "jacob_bot");
  const s1 = await call("dylan_bot", "PUT", `/api/docs/${d.data.doc.id}`, { body: "Step 1: walk the site.\nStep 2: take photos.\nStep 3: log GPS points.", note: "add GPS" });
  check("non-owner edit becomes suggestion", s1.status === 202 && s1.data.suggested === true);
  const still = await call("dylan_bot", "GET", `/api/docs/${d.data.doc.id}`);
  check("doc unchanged until owner decides", !still.data.doc.body.includes("GPS"));
  const notOwner = await call("dylan_bot", "POST", `/api/suggestions/${s1.data.suggestion.id}/accept`);
  check("non-owner cannot accept", notOwner.status === 403);
  const acc = await call("jacob_bot", "POST", `/api/suggestions/${s1.data.suggestion.id}/accept`);
  check("owner accepts suggestion -> doc updated", acc.status === 200 && acc.data.doc.body.includes("GPS"));
  const s2 = await dylanS.fetch("POST", `/api/docs/${d.data.doc.id}/suggestions`, { body: "Totally different", note: "rewrite" });
  const rej = await call("jacob_bot", "POST", `/api/suggestions/${s2.data.suggestion.id}/reject`);
  const after = await call("jacob_bot", "GET", `/api/docs/${d.data.doc.id}`);
  check("owner rejects suggestion -> doc unchanged", rej.status === 200 && rej.data.suggestion.status === "rejected" && after.data.doc.body.includes("GPS"));
  const own = await call("jacob_bot", "PUT", `/api/docs/${d.data.doc.id}`, { body: after.data.doc.body + "\nStep 4: upload." });
  check("owner edits directly", own.status === 200 && own.data.suggested === false);

  // ---------- files ----------
  const oneMB = Buffer.alloc(1024 * 1024, 7);
  const up = await call("dylan_bot", "POST", "/api/rooms/work/files?name=site-photos.bin&caption=Raw%20photo%20batch", oneMB, { "Content-Type": "application/octet-stream" });
  const down = await call("jacob_bot", "GET", `/api/files/${up.data.file?.id}`);
  check("bot upload 1 MB + other bot downloads identical bytes", up.status === 201 && Buffer.compare(down.data, oneMB) === 0);
  const exact = await call("dylan_bot", "POST", "/api/rooms/talk/files?name=exact-4mb.bin", Buffer.alloc(4 * 1024 * 1024, 1), { "Content-Type": "application/octet-stream" });
  check("upload exactly 4 MB accepted", exact.status === 201);
  const over = await call("dylan_bot", "POST", "/api/rooms/talk/files?name=too-big.bin", Buffer.alloc(4 * 1024 * 1024 + 1, 1), { "Content-Type": "application/octet-stream" });
  check("upload 4 MB + 1 byte rejected (413)", over.status === 413, over.data.error);

  // ---------- sensitive content ----------
  const samples = { password: "login password: Hunter22!", card: "card 4111 1111 1111 1111", account: "account number 12345678", routing: "routing 021000021", address: "Ship it to 742 Evergreen Terrace" };
  for (const [k, text] of Object.entries(samples)) {
    const r = await call("jacob_bot", "POST", "/api/rooms/talk/messages", { body: text });
    check(`blocked (${k}) for bot`, r.status === 422 && r.data.code === "sensitive_content", r.data.error);
  }
  const hb = await dylanS.fetch("POST", "/api/rooms/work/messages", { body: "Meet at 1600 Pennsylvania Ave" });
  check("blocked for human too (work post)", hb.status === 422);
  const db2 = await call("dylan_bot", "POST", "/api/docs", { title: "Keys", body: "pin: 991122" });
  check("blocked in documents", db2.status === 422);
  const ds = await call("dylan_bot", "PUT", `/api/docs/${d.data.doc.id}`, { body: "IBAN GB82 WEST 1234 5698 7654 32" });
  check("blocked in suggestions", ds.status === 422);
  const okmsg = await call("jacob_bot", "POST", "/api/rooms/talk/messages", { body: "Phase 2 starts in 3 days; 12 sites left." });
  check("normal message with small numbers allowed", okmsg.status === 201);
}

// ---------- bot lockout via API ----------
{
  for (let i = 0; i < 5; i++) await call(basic("jacob_bot", "wrong-" + i), "GET", "/api/whoami");
  const locked = await call("jacob_bot", "GET", "/api/whoami");
  check("bot locked after 5 wrong PINs (correct PIN -> 423)", locked.status === 423, locked.data.error);
  admin("unlock", "jacob_bot");
  const ok = await call("jacob_bot", "GET", "/api/whoami");
  check("admin unlock restores access", ok.status === 200);
}

// ---------- admin CLI: rename + reset ----------
{
  const out = admin("rename-bot", "dylan_bot", "Scout");
  let w; for (let i = 0; i < 25; i++) { w = await call(`Pin Scout:${C.dylan_bot}`, "GET", "/api/whoami"); if (w.status === 200 && w.data.name === "Scout") break; await sleep(2000); }
  check("rename-bot via CLI picked up live", w.status === 200 && w.data.name === "Scout" && w.data.handle === "scout" && !out.match(/[A-Za-z0-9_-]{32}/));
  admin("rename-bot", "dylan_bot", "Dylan's Bot");
  for (let i = 0; i < 25; i++) { const r = await call("dylan_bot", "GET", "/api/whoami"); if (r.data.name === "Dylan's Bot") break; await sleep(2000); }
  const oldPin = C.jacob_bot;
  const rout = admin("reset-pin", "jacob_bot");
  C = creds();
  const oldR = await call(basic("jacob_bot", oldPin), "GET", "/api/whoami");
  const newR = await call("jacob_bot", "GET", "/api/whoami");
  check("reset-pin: old PIN fails, new PIN from CREDENTIALS.txt works, PIN not printed", oldR.status === 401 && newR.status === 200 && !rout.includes(C.jacob_bot));
}


// ---------- permanent record, revisions, doc versions, recent window, transcripts ----------
await runPermanentTests({ call, dylanS, jacobS, check, tag });

// ---------- webhooks (HTTPS receiver: this app's own test sink, enabled by WEBHOOK_TEST_SINK_TOKEN) ----------
{
  const SINK = readFileSync(process.env.FFW_SINK_FILE || join(ROOT, ".sink-token"), "utf8").trim();
  const ADMIN = readFileSync(process.env.FFW_ADMIN_SECRET_FILE || join(ROOT, ".admin-secret"), "utf8").trim();
  const adminCall = async (action) => (await fetch(BASE + "/api/admin", { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Secret": ADMIN }, body: JSON.stringify({ action }) })).json();
  const receiver = {
    url: (bot) => `${BASE}/api/webhook-test-sink/${SINK}?bot=${bot}${BYPASS ? "&x-vercel-protection-bypass=" + BYPASS : ""}`,
    read: async () => (await adminCall("sink-read")).inbox.map((r) => ({ bot: r.tag, body: r.body, sig: r.signature, headers: typeof r.headers === "string" ? JSON.parse(r.headers || "{}") : (r.headers || {}) })),
    clear: async () => { await adminCall("sink-clear"); },
  };
  const badUrls = ["https://10.0.0.1/hook", "https://192.168.1.10/hook", "https://169.254.169.254/latest/meta-data", "https://metadata.google.internal/", "http://example.com/hook", "http://localhost:3480/hook", "https://127.0.0.1/hook", "https://[::1]/hook", "https://[::ffff:7f00:1]/hook"];
  globalThis.webhookResults = await runWebhookTests({ call, human: { dylan: dylanS, jacob: jacobS }, check, sleep, receiver, badUrls, tag });
  await adminCall("sink-clear");
}


// ---------- in-app bot PIN reset (each owner, own bot only) ----------
{
  const sessionForWithPin = async (id, pin) => {
    const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member: id, pin }) });
    const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return { fetch: (method, path, body, h = {}) => fetch(BASE + path, { method, headers: { Cookie: cookie, "X-FFW": "1", ...(body && !(body instanceof Buffer) ? { "Content-Type": "application/json" } : {}), ...h }, body: body instanceof Buffer ? body : body && JSON.stringify(body) }).then(async (x) => ({ status: x.status, data: await x.json().catch(() => null) })) };
  };
  const credsRef = { C };
  await runBotPinTests({ call, human: { dylan: dylanS, jacob: jacobS }, check, credsRef, basic, sessionLogin: sessionForWithPin });
  C = credsRef.C;
}

// ---------- browser UI ----------
const browser = await puppeteer.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
if (BYPASS) {
  const mk = browser.createBrowserContext.bind(browser);
  browser.createBrowserContext = async (...a) => { const c = await mk(...a); const np = c.newPage.bind(c); c.newPage = async () => { const p = await np(); await p.setExtraHTTPHeaders({ "x-vercel-protection-bypass": BYPASS }); await p.goto(`${BASE}/robots.txt?x-vercel-set-bypass-cookie=samesitenone&x-vercel-protection-bypass=${BYPASS}`); return p; }; return c; };
}
async function uiLogin(page, id, pin) {
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await page.waitForSelector(`#name-picker button[data-id="${id}"]`);
  await page.click(`#name-picker button[data-id="${id}"]`);
  await page.type("#pin", pin);
  await page.click("#login-btn");
}
try {
  // lockout in UI (Jacob)
  const ctxJ = await browser.createBrowserContext();
  const pj = await ctxJ.newPage(); await pj.setViewport({ width: 1280, height: 820 });
  await pj.goto(BASE + "/", { waitUntil: "networkidle0" });
  await pj.screenshot({ path: join(SHOTS, "desktop-login.png") });
  for (let i = 0; i < 5; i++) { await uiLogin(pj, "jacob", "000000x"); await pj.waitForFunction(() => document.querySelector("#login-error").textContent.length > 0); }
  const lockMsg = await pj.$eval("#login-error", (e) => e.textContent);
  await uiLogin(pj, "jacob", C.jacob); await sleep(400);
  const lockMsg2 = await pj.$eval("#login-error", (e) => e.textContent);
  check("UI: human locked after 5 wrong PINs, correct PIN refused while locked", /locked/i.test(lockMsg) && /locked/i.test(lockMsg2) && await pj.$eval("#app", (e) => e.classList.contains("hidden")), lockMsg2);
  await pj.screenshot({ path: join(SHOTS, "desktop-lockout.png") });
  admin("unlock", "jacob");

  // Dylan desktop
  const ctxD = await browser.createBrowserContext();
  const pd = await ctxD.newPage(); await pd.setViewport({ width: 1280, height: 820 });
  await uiLogin(pd, "dylan", C.dylan);
  await pd.waitForSelector("#feed");
  check("UI: human sign-in (pick name + PIN)", (await pd.$eval("#me-name", (e) => e.textContent)) === "Dylan");
  const navD = await pd.$$eval("#rooms button", (b) => b.map((x) => x.textContent.trim()));
  check("UI: human sidebar has 4 rooms + Settings", navD.join("|") === "Talk|Work|Documents|Owners only|Settings", navD.join(", "));
  await pd.type("#body", `@dylans-bot draft the weekly field summary ${tag}`); await pd.keyboard.press("Enter");
  await pd.waitForFunction((t) => [...document.querySelectorAll(".msg")].some((m) => m.innerText.includes(t) && m.innerText.includes("command → Dylan")), {}, `weekly field summary ${tag}`);
  check("UI: Talk message appears with author, time and command badge", true);
  await pd.type("#body", "Mail it to 221 Baker Street"); await pd.keyboard.press("Enter");
  await pd.waitForFunction(() => !document.querySelector("#toast").classList.contains("hidden") && /Blocked/.test(document.querySelector("#toast").textContent));
  check("UI: sensitive content blocked with clear error", true, await pd.$eval("#toast", (e) => e.textContent));
  await pd.$eval("#body", (e) => (e.value = "")); await sleep(300);
  await pd.screenshot({ path: join(SHOTS, "desktop-talk.png") });

  // people filter
  await pd.select("#people-filter", "dylan_bot"); await sleep(500);
  const authors = await pd.$$eval(".msg .who", (w) => [...new Set(w.map((x) => x.textContent))]);
  check("UI: people filter shows only that member", authors.length === 1 && authors[0] === "Dylan's Bot", authors.join(","));
  await pd.screenshot({ path: join(SHOTS, "desktop-people-filter.png") });
  await pd.select("#people-filter", "");

  // work
  await pd.click('#rooms button[data-room="work"]'); await pd.waitForSelector("#new-assignee");
  await pd.type("#body", `Map the north field plots ${tag}`); await pd.select("#new-assignee", "jacob");
  await pd.click("#composer button[type=submit]");
  await pd.waitForFunction((t) => [...document.querySelectorAll(".msg")].some((m) => m.innerText.includes(t)), {}, `north field plots ${tag}`);
  const wid = await pd.evaluate((t) => [...document.querySelectorAll(".msg")].find((m) => m.innerText.includes(t)).dataset.id, `north field plots ${tag}`);
  await pd.select(`.msg[data-id="${wid}"] select[data-act=status]`, "in_progress"); await sleep(500);
  const wchk = (await call("dylan_bot", "GET", `/api/rooms/work/messages?after=${wid - 1}`)).data.messages[0];
  check("UI: Work post created with assignee, status changed to In progress", wchk.status === "in_progress" && wchk.assignee === "jacob");
  await pd.screenshot({ path: join(SHOTS, "desktop-work.png") });

  // permanent record UI: change history, recent-50 window, Load older, Full transcript page
  const histOk = await pd.waitForSelector(`.msg[data-id="${wid}"] [data-hist]`, { timeout: 15000 }).then(() => true).catch(() => false);
  if (histOk) { await clickJs(pd, `.msg[data-id="${wid}"] [data-hist]`); await pd.waitForFunction((i) => /In progress/.test(document.querySelector(`.msg[data-id="${i}"] .hist`)?.textContent || ""), { timeout: 8000 }, wid).catch(() => {}); }
  check("UI: work post History shows the status change", histOk && /To do → In progress/.test(await pd.$eval(`.msg[data-id="${wid}"] .hist`, (e) => e.textContent).catch(() => "")));
  await pd.click('#rooms button[data-room="talk"]'); await pd.waitForSelector("#load-older", { timeout: 10000 }).catch(() => {});
  const n0 = await pd.$$eval("#feed .msg", (m) => m.length);
  const tlink = await pd.$eval("#transcript-link", (e) => ({ href: e.getAttribute("href"), hidden: e.classList.contains("hidden") }));
  check("UI: Talk opens with only the recent 50 + Load older + Full transcript link", n0 >= 50 && n0 <= 53 && !!(await pd.$("#load-older")) && !tlink.hidden && tlink.href === "/transcript.html?room=talk", `${n0} shown`);
  await clickJs(pd, "#load-older"); await pd.waitForFunction((n) => document.querySelectorAll("#feed .msg").length > n, { timeout: 10000 }, n0).catch(() => {});
  const n1 = await pd.$$eval("#feed .msg", (m) => m.length);
  check("UI: Load older prepends earlier messages", n1 > n0, `${n0} → ${n1}`);
  await pd.goto(BASE + "/transcript.html?room=talk&pageSize=20", { waitUntil: "networkidle0" });
  await pd.waitForSelector("#t-feed .msg", { timeout: 10000 }).catch(() => {});
  const tp = await pd.$eval("#t-page", (e) => e.textContent).catch(() => "");
  const latest = (await call("dylan_bot", "GET", "/api/rooms/talk/messages?limit=1")).data.messages[0];
  const lastOk = await pd.$$eval("#t-feed .msg .body", (b, t) => b.at(-1)?.textContent === t, latest.body).catch(() => false);
  check("UI: Full transcript page opens on the latest page, paginated", /^Page (\d+) of \1$/.test(tp) && !tp.startsWith("Page 1 ") && lastOk, tp);
  await pd.screenshot({ path: join(SHOTS, "desktop-transcript.png") });
  await clickJs(pd, "#t-first"); await pd.waitForFunction(() => /^Page 1 of/.test(document.querySelector("#t-page").textContent), { timeout: 8000 }).catch(() => {});
  check("UI: transcript paging to the first page", /^Page 1 of/.test(await pd.$eval("#t-page", (e) => e.textContent)));
  await pd.goto(BASE + "/transcript.html?room=owners", { waitUntil: "networkidle0" }); await pd.waitForSelector("#t-feed .msg", { timeout: 8000 }).catch(() => {});
  check("UI: Owners only transcript visible to an owner", (await pd.$eval("#t-title", (e) => e.textContent)).startsWith("Owners only"));
  await pd.goto(BASE + "/", { waitUntil: "networkidle0" }); await pd.waitForSelector("#feed");

  // owners
  await pd.click('#rooms button[data-room="owners"]'); await pd.waitForSelector("#feed"); await sleep(300);
  await pd.screenshot({ path: join(SHOTS, "desktop-owners.png") });

  // docs: Dylan creates, Jacob suggests (UI), Dylan accepts/rejects (UI)
  await pd.click('#rooms button[data-room="docs"]'); await pd.waitForSelector("#new-doc");
  await pd.click("#new-doc"); await pd.type("#doc-title", `Field protocol ${tag}`);
  await pd.type("#doc-body", "Arrive by 8am.\nBring the drone.\nLog weather."); await pd.click("#save-doc");
  await pd.waitForFunction((t) => document.querySelector("#docpane h3")?.textContent.includes(t), {}, `Field protocol ${tag}`);
  const docId = (await dylanS.fetch("GET", "/api/docs")).data.docs.find((x) => x.title === `Field protocol ${tag}`).id;

  await uiLogin(pj, "jacob", C.jacob); await pj.waitForSelector("#feed");
  check("UI: Jacob signs in after admin unlock", (await pj.$eval("#me-name", (e) => e.textContent)) === "Jacob");
  await jacobS.fetch("POST", "/api/rooms/talk/messages", { body: `Polling check ${tag}` });
  await pj.waitForFunction((t) => [...document.querySelectorAll(".msg")].some((m) => m.innerText.includes(t)), { timeout: 15000 }, `Polling check ${tag}`)
    .then(() => check("UI: message posted elsewhere appears via polling (<15s)", true)).catch(() => check("UI: message posted elsewhere appears via polling (<15s)", false));
  await pj.click('#rooms button[data-room="docs"]'); await pj.waitForSelector(`.doclist .item[data-id="${docId}"]`);
  await clickJs(pj, `.doclist .item[data-id="${docId}"]`); await pj.waitForFunction((t) => document.querySelector("#docpane h3")?.textContent.includes(t), {}, tag);
  await clickJs(pj, "#edit-doc"); await pj.waitForSelector("#doc-body");
  await pj.$eval("#doc-body", (e) => (e.value = "Arrive by 7:30am.\nBring the drone and spare batteries.\nLog weather."));
  await pj.type("#doc-note", "Earlier start, batteries"); await pj.click("#save-doc");
  await pj.waitForFunction(() => /suggestion/.test(document.querySelector("#toast").textContent));
  await sleep(500);
  await pj.screenshot({ path: join(SHOTS, "desktop-doc-suggestion-jacob.png") });

  await clickJs(pd, `.doclist .item[data-id="${docId}"]`);
  await pd.waitForSelector(".sugg.pending [data-act=accept]");
  check("UI: owner sees diff of pending suggestion", await pd.$eval(".sugg.pending .diff", (e) => e.querySelector(".add") && e.querySelector(".del") ? true : false));
  await pd.screenshot({ path: join(SHOTS, "desktop-doc-diff.png") });
  await clickJs(pd, ".sugg.pending [data-act=accept]");
  await pd.waitForFunction(() => document.querySelector(".docbody")?.textContent.includes("7:30am"));
  check("UI: owner accepts -> document updated", true);
  // second suggestion rejected
  await jacobS.fetch("PUT", `/api/docs/${docId}`, { body: "Skip the drone.", note: "maybe?" });
  await sleep(500); await clickJs(pd, `.doclist .item[data-id="${docId}"]`);
  await pd.waitForSelector(".sugg.pending [data-act=reject]"); await clickJs(pd, ".sugg.pending [data-act=reject]");
  await pd.waitForFunction(() => !document.querySelector(".sugg.pending") && document.querySelector(".docbody").textContent.includes("7:30am"));
  check("UI: owner rejects -> document unchanged", true);
  await pd.screenshot({ path: join(SHOTS, "desktop-docs.png") });

  // bot in UI: no owners room
  const ctxB = await browser.createBrowserContext();
  const pb = await ctxB.newPage(); await pb.setViewport({ width: 1280, height: 820 });
  await uiLogin(pb, "dylan_bot", C.dylan_bot); await pb.waitForSelector("#feed");
  const navB = await pb.$$eval("#rooms button", (b) => b.map((x) => x.textContent.trim()));
  check("UI: bot sign-in has no Owners only room", !navB.includes("Owners only") && navB.length === 3, navB.join(", "));
  await pb.screenshot({ path: join(SHOTS, "desktop-bot-view.png") });
  await clickJs(pd, '#rooms button[data-room="settings"]'); await pd.waitForSelector("#settings");
  const editable = await pd.$$eval("#settings .hook-url", (e) => e.length);
  const dylanCard = await pd.$eval('#settings [data-bot="dylan_bot"]', (e) => !!e.querySelector(".hook-url"));
  const jacobCard = await pd.$eval('#settings [data-bot="jacob_bot"]', (e) => e.innerText);
  check("UI: Settings shows Dylan an editable webhook for Dylan's Bot only", editable === 1 && dylanCard && /Only Jacob can change this/.test(jacobCard));
  const pinBtn = await pd.$("#reset-bot-pin");
  const pinLabel = pinBtn && await pd.$eval("#bot-pin", (e) => e.innerText);
  check("UI: Settings shows Dylan a Reset my bot's PIN button for Dylan's Bot", !!pinBtn && /Dylan's Bot/.test(pinLabel || "") && /Reset my bot's PIN/.test(pinLabel || ""));
  await pd.click("#reset-bot-pin");
  const confirmLabel = await pd.$eval("#reset-bot-pin", (e) => e.textContent);
  const cancelVisible = await pd.$eval("#cancel-bot-pin", (e) => !e.classList.contains("hidden"));
  check("UI: Reset my bot's PIN asks for confirm before changing anything", /Confirm reset/.test(confirmLabel) && cancelVisible);
  await pd.click("#cancel-bot-pin");
  const afterCancel = await pd.$eval("#reset-bot-pin", (e) => e.textContent);
  const pinRevealed = await pd.$("#bot-pin-value");
  check("UI: cancel leaves the current bot PIN unchanged (no PIN shown)", afterCancel === "Reset my bot's PIN" && !pinRevealed);
  await pd.screenshot({ path: join(SHOTS, "desktop-settings.png") });

  // Jacob sets up his own bot's webhook entirely in Settings (URL, auth header, test, clear)
  {
    const SINK = readFileSync(process.env.FFW_SINK_FILE || join(ROOT, ".sink-token"), "utf8").trim();
    const ADMIN = readFileSync(process.env.FFW_ADMIN_SECRET_FILE || join(ROOT, ".admin-secret"), "utf8").trim();
    const adminCall = async (action) => (await fetch(BASE + "/api/admin", { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Secret": ADMIN }, body: JSON.stringify({ action }) })).json();
    const parseHdrs = (h) => (typeof h === "string" ? JSON.parse(h || "{}") : (h || {}));
    await runJacobWebhookUiTests({
      page: pj, check, clickJs, sleep, tag,
      receiverUrl: `${BASE}/api/webhook-test-sink/${SINK}?bot=jacob_bot${BYPASS ? "&x-vercel-protection-bypass=" + BYPASS : ""}`,
      readInbox: async () => ((await adminCall("sink-read")).inbox || []).map((r) => ({ bot: r.tag, body: r.body, sig: r.signature, headers: parseHdrs(r.headers) })),
      clearInbox: async () => { await adminCall("sink-clear"); },
    });
    await pj.screenshot({ path: join(SHOTS, "desktop-settings-jacob.png") });
    await adminCall("sink-clear");
  }

  // mobile
  const pm = await ctxD.newPage();
  await pm.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await pm.goto(BASE + "/", { waitUntil: "networkidle0" }); await pm.waitForSelector("#feed"); await sleep(300);
  await pm.screenshot({ path: join(SHOTS, "mobile-talk.png") });
  await pm.click('#rooms button[data-room="work"]'); await pm.waitForSelector("#new-assignee"); await sleep(300);
  await pm.screenshot({ path: join(SHOTS, "mobile-work.png") });
  await pm.click('#rooms button[data-room="docs"]'); await pm.waitForSelector("#new-doc"); await sleep(400);
  await pm.screenshot({ path: join(SHOTS, "mobile-docs.png") });
  const pml = await (await browser.createBrowserContext()).newPage();
  await pml.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await pml.goto(BASE + "/", { waitUntil: "networkidle0" }); await pml.screenshot({ path: join(SHOTS, "mobile-login.png") });
  const swOk = await pm.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
  check("UI: service worker registered (PWA installable)", swOk);
} catch (e) {
  check("browser flow", false, e.message);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
if (globalThis.webhookResults) for (const [bot, r] of Object.entries(globalThis.webhookResults)) console.log(`webhooks ${bot}: ${r.filter((x) => x.ok).length}/${r.length} passed`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
