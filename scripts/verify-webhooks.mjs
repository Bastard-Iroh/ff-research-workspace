// Webhook checks, run separately for EACH bot. Used by scripts/verify.mjs in both versions.
import { createHmac } from "node:crypto";

const MANAGER = { dylan_bot: "dylan", jacob_bot: "jacob" };
const HANDLE = { dylan_bot: "dylans-bot", jacob_bot: "jacobs-bot" };
const OTHER_HUMAN = { dylan: "jacob", jacob: "dylan" };
const OTHER_BOT = { dylan_bot: "jacob_bot", jacob_bot: "dylan_bot" };

/**
 * ctx: { call(botId, method, path, body), human: {dylan, jacob} session objects with .fetch(method, path, body),
 *        check(name, ok, detail), sleep(ms), receiver: { url(bot), read() -> [{bot, body, sig}], clear() },
 *        badUrls: [urls that must be rejected], tag }
 */
export async function runWebhookTests(ctx) {
  const { call, human, check, sleep, receiver, tag } = ctx;
  const secrets = {};
  const results = { dylan_bot: [], jacob_bot: [] };
  const rec = (bot, name, ok, detail) => { results[bot].push({ name, ok: !!ok }); check(`[${bot}] ${name}`, ok, detail); };

  // ---------- settings flow, per bot ----------
  for (const bot of ["dylan_bot", "jacob_bot"]) {
    const mgr = MANAGER[bot], other = OTHER_HUMAN[mgr];
    const set = await human[mgr].fetch("PUT", `/api/webhooks/${bot}`, { url: receiver.url(bot) });
    secrets[bot] = set.data?.secret;
    rec(bot, `manager (${mgr}) sets webhook URL, signing secret returned once`, set.status === 200 && /^whsec_/.test(set.data.secret || "") && set.data.webhook.configured, set.data?.error);
    const otherSet = await human[other].fetch("PUT", `/api/webhooks/${bot}`, { url: receiver.url(bot) });
    const otherDel = await human[other].fetch("DELETE", `/api/webhooks/${bot}`);
    const otherTest = await human[other].fetch("POST", `/api/webhooks/${bot}/test`);
    rec(bot, `other owner (${other}) can't set, clear or test it (403)`, otherSet.status === 403 && otherDel.status === 403 && otherTest.status === 403);
    const view = await human[other].fetch("GET", "/api/webhooks");
    const v = view.data.webhooks.find((w) => w.botId === bot);
    rec(bot, "other owner sees 'set' but not the URL", v.configured === true && v.url === null && v.canEdit === false);
    const b1 = await call(bot, "PUT", `/api/webhooks/${bot}`, { url: receiver.url(bot) });
    const b2 = await call(OTHER_BOT[bot], "PUT", `/api/webhooks/${bot}`, { url: receiver.url(bot) });
    const b3 = await call(bot, "GET", "/api/webhooks");
    const b4 = await call(bot, "POST", `/api/webhooks/${bot}/test`);
    rec(bot, "bots can't view, set or test webhooks (403)", b1.status === 403 && b2.status === 403 && b3.status === 403 && b4.status === 403);
    for (const u of ctx.badUrls) {
      const r = await human[mgr].fetch("PUT", `/api/webhooks/${bot}`, { url: u });
      rec(bot, `SSRF/scheme guard rejects ${u}`, r.status === 400 && r.data.code === "bad_webhook_url", r.data?.error);
    }
    const still = (await human[mgr].fetch("GET", "/api/webhooks")).data.webhooks.find((w) => w.botId === bot);
    rec(bot, "rejected URL didn't replace the saved one", still.url === receiver.url(bot));
  }

  // ---------- delivery helpers ----------
  const verifySig = (bot, n) => n.sig === "sha256=" + createHmac("sha256", secrets[bot]).update(n.body).digest("hex");
  async function expect(action, expected, label) {
    await receiver.clear();
    const ctxv = await action();
    const want = typeof expected === "function" ? expected(ctxv) : expected;
    const deadline = Date.now() + 12000;
    let got = [];
    while (Date.now() < deadline) { got = await receiver.read(); if (got.length >= want.length) break; await sleep(700); }
    await sleep(1500); got = await receiver.read();
    for (const bot of ["dylan_bot", "jacob_bot"]) {
      const mine = got.filter((n) => n.bot === bot);
      const w = want.filter((x) => x.bot === bot);
      if (!w.length && !mine.length && !label.includes(bot)) continue;
      let ok = mine.length === w.length, detail = "";
      for (const x of w) {
        const n = mine.find((m) => JSON.parse(m.body).type === x.type);
        if (!n) { ok = false; detail = `missing ${x.type}`; continue; }
        const p = JSON.parse(n.body);
        const keys = Object.keys(p).sort().join(",");
        ok &&= keys === "author,itemId,room,time,type" && p.room === x.room && p.author === x.author && (x.itemId === undefined || p.itemId === x.itemId) && !isNaN(Date.parse(p.time)) && verifySig(bot, n);
        if (!ok) detail = `got ${n.body}`;
      }
      if (mine.length !== w.length) detail = `expected ${w.length} notice(s), got ${mine.length}: ${mine.map((m) => m.body).join(" ")}`;
      rec(bot, label + (w.length ? ` -> ${w.map((x) => x.type).join("+")}` : " -> no notice"), ok, detail);
    }
  }
  const post = (who, room, body, extra = {}) => (human[who] ? human[who].fetch("POST", `/api/rooms/${room}/messages`, { body, ...extra }) : call(who, "POST", `/api/rooms/${room}/messages`, { body, ...extra }));

  // ---------- test button ----------
  for (const bot of ["dylan_bot", "jacob_bot"]) {
    await expect(async () => { const r = await human[MANAGER[bot]].fetch("POST", `/api/webhooks/${bot}/test`); rec(bot, "Send test reports delivery OK", r.data?.result?.ok === true, JSON.stringify(r.data?.result)); },
      [{ bot, type: "test", room: null, author: MANAGER[bot], itemId: null }], `test notice to ${bot}`);
    const st = (await human[MANAGER[bot]].fetch("GET", "/api/webhooks")).data.webhooks.find((w) => w.botId === bot);
    rec(bot, "last delivery status logged in settings", st.lastDelivery && st.lastDelivery.type === "test" && /^2\d\d$/.test(st.lastDelivery.status));
  }

  // ---------- triggers, per bot ----------
  for (const bot of ["dylan_bot", "jacob_bot"]) {
    const mgr = MANAGER[bot], other = OTHER_HUMAN[mgr], xb = OTHER_BOT[bot], h = HANDLE[bot], xh = HANDLE[xb];
    let id;
    await expect(async () => { id = (await post(mgr, "talk", `@${h} summarize ${tag}`)).data.message.id; return id; },
      (i) => [{ bot, type: "mention", room: "talk", author: mgr, itemId: i }, { bot: xb, type: "owner_message", room: "talk", author: mgr, itemId: i }],
      `${mgr} @mentions ${bot} (other bot gets owner_message) [${bot}]`);
    await expect(async () => (await post(other, "talk", `@${h} also check the map ${tag}`)).data.message.id,
      (i) => [{ bot, type: "mention", room: "talk", author: other, itemId: i }, { bot: xb, type: "owner_message", room: "talk", author: other, itemId: i }],
      `${other} (other owner) @mentions ${bot} [${bot}]`);
    await expect(async () => (await post(xb, "talk", `@${h} handing off ${tag}`)).data.message.id,
      (i) => [{ bot, type: "handoff", room: "talk", author: xb, itemId: i }],
      `${xb} hands off to ${bot} (sender not notified) [${bot}]`);
    await expect(async () => (await post(mgr, "work", `@${h} map plots ${tag}`, { assignee: bot })).data.message.id,
      (i) => [{ bot, type: "assignment", room: "work", author: mgr, itemId: i }, { bot: xb, type: "owner_message", room: "work", author: mgr, itemId: i }],
      `Work post assigned to ${bot} + @mention -> one assignment notice (dedupe) [${bot}]`);
    const wp = (await post(xb, "work", `Survey prep ${tag}`)).data.message.id;
    await sleep(1500);
    await expect(async () => { await human[other].fetch("PATCH", `/api/messages/${wp}`, { assignee: bot }); return wp; },
      (i) => [{ bot, type: "assignment", room: "work", author: other, itemId: i }], `${other} reassigns a Work post to ${bot} [${bot}]`);
    await expect(async () => { await human[other].fetch("PATCH", `/api/messages/${wp}`, { status: "done" }); }, [], `status-only change on ${bot}'s task [${bot}]`);
    await expect(async () => { await call(bot, "PATCH", `/api/messages/${wp}`, { assignee: bot }); await post(bot, "talk", `Working on it ${tag}`); }, [], `${bot}'s own actions [${bot}]`);
    let docId;
    await expect(async () => {
      docId = (await call(bot, "POST", "/api/docs", { title: `Bot doc ${bot} ${tag}`, body: "line one" })).data.doc.id;
      await human[other].fetch("PUT", `/api/docs/${docId}`, { body: "line one\nline two", note: "add" });
      return docId;
    }, (i) => [{ bot, type: "suggestion", room: "docs", author: other, itemId: i }], `${other} suggests an edit on ${bot}'s doc [${bot}]`);
    const hd = (await human[mgr].fetch("POST", "/api/docs", { title: `Human doc ${mgr} ${tag}`, body: "draft" })).data.doc.id;
    const sg = (await call(bot, "PUT", `/api/docs/${hd}`, { body: "draft v2" })).data.suggestion.id;
    await sleep(1500);
    await expect(async () => { await human[mgr].fetch("POST", `/api/suggestions/${sg}/accept`); return hd; },
      (i) => [{ bot, type: "suggestion", room: "docs", author: mgr, itemId: i }], `${mgr} accepts ${bot}'s suggestion [${bot}]`);
    await expect(async () => { await post(mgr, "owners", `@${h} secret plans ${tag}`); }, [], `Owners only message mentioning ${bot} [${bot}]`);
    await expect(async () => { await post(xb, "talk", `Status report ${tag}`); }, [], `plain message from ${xb} (no @) [${bot}]`);
  }

  // ---------- clear ----------
  for (const bot of ["dylan_bot", "jacob_bot"]) {
    const r = await human[MANAGER[bot]].fetch("DELETE", `/api/webhooks/${bot}`);
    rec(bot, "manager clears webhook URL", r.status === 200 && r.data.webhook.configured === false);
  }
  await expect(async () => { await post("dylan", "talk", `@dylans-bot @jacobs-bot after clear ${tag}`); }, [], "no notices after webhooks cleared [dylan_bot jacob_bot]");
  return results;
}
