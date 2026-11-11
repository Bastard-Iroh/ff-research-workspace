// Owner-only in-app bot PIN reset checks. Never prints PINs.
// The server picks the bot from the signed-in owner; a client-supplied target for the other bot is 403.
import { readFileSync, writeFileSync } from "node:fs";

const REAL_CREDS = new Set([
  "/workspace/ff-workspace/CREDENTIALS.txt",
  "/workspace/ff-workspace-vercel/CREDENTIALS.txt",
]);

function isTestCredsPath(p) {
  if (!p) return false;
  if (REAL_CREDS.has(p)) return false;
  return p.startsWith("/tmp/") || /test/i.test(p);
}

function looksLikeBotPin(pin) {
  return typeof pin === "string" && /^[A-Za-z0-9_-]{32}$/.test(pin);
}

function auditClean(reset, pin) {
  if (!reset || !pin) return false;
  const s = JSON.stringify(reset);
  return !!reset.actor && !!reset.bot && !!reset.at && !("pin" in reset) && !s.includes(pin);
}

function saveTestPin(id, pin, C) {
  C[id] = pin;
  const path = process.env.FFW_CREDENTIALS;
  if (!isTestCredsPath(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  const out = lines.map((l) => l.startsWith(id + " ") || l.startsWith(id + "\t") ? l.replace(/(\|\s*)(\S+)(\s*)$/, `$1${pin}$3`) : l);
  // Only write if we actually replaced a matching credentials line and the file still looks like the test format.
  if (out.some((l, i) => l !== lines[i])) writeFileSync(path, out.join("\n"), { mode: 0o600 });
}

export async function runBotPinTests(ctx) {
  const { call, human, check, credsRef, basic, sessionLogin } = ctx;
  const C = credsRef.C;
  const OWN = { dylan: "dylan_bot", jacob: "jacob_bot" };

  for (const bot of ["dylan_bot", "jacob_bot"]) {
    const r = await call(bot, "POST", "/api/bot-pin/reset", {});
    check(`bot PIN reset: ${bot} → 403`, r.status === 403);
  }

  const cross = await human.jacob.fetch("POST", "/api/bot-pin/reset", { bot: "dylan_bot" });
  const stillD = await call(basic("dylan_bot", C.dylan_bot), "GET", "/api/whoami");
  check("bot PIN reset: Jacob targeting Dylan's Bot → 403", cross.status === 403);
  check("bot PIN reset: Dylan's Bot PIN unchanged after cross-owner attempt", stillD.status === 200 && stillD.data.id === "dylan_bot");

  const cross2 = await human.dylan.fetch("POST", "/api/bot-pin/reset?bot=jacob_bot", { member: "jacob_bot" });
  const stillJ = await call("jacob_bot", "GET", "/api/whoami");
  check("bot PIN reset: Dylan targeting Jacob's Bot → 403", cross2.status === 403);
  check("bot PIN reset: Jacob's Bot PIN unchanged after cross-owner attempt", stillJ.status === 200 && stillJ.data.id === "jacob_bot");

  async function resetAs(owner) {
    const bot = OWN[owner];
    const oldPin = C[bot];
    const botSession = sessionLogin ? await sessionLogin(bot, oldPin) : null;
    const r = await human[owner].fetch("POST", "/api/bot-pin/reset", {});
    const pin = r.data?.pin;
    const ok = r.status === 200 && r.data?.bot?.id === bot && looksLikeBotPin(pin)
      && !!r.data.pinNote && auditClean(r.data.reset, pin)
      && r.data.reset.actor === owner && r.data.reset.bot === bot;
    check(`${owner} resets own bot: new PIN shown once, audit has who/bot/when and no PIN`, ok, ok ? "" : `status ${r.status}`);
    const oldR = await call(basic(bot, oldPin), "GET", "/api/whoami");
    const newR = await call(basic(bot, pin || "x"), "GET", "/api/whoami");
    check(`${owner} resets own bot: old PIN fails, new PIN works`, oldR.status === 401 && newR.status === 200 && newR.data?.id === bot);
    if (botSession) {
      const stale = await botSession.fetch("GET", "/api/whoami");
      check(`${owner} resets own bot: previous bot session ends`, stale.status === 401);
    }
    if (pin) saveTestPin(bot, pin, C);
  }

  for (let i = 0; i < 5; i++) await call(basic("jacob_bot", "wrong-lock-" + i), "GET", "/api/whoami");
  const locked = await call("jacob_bot", "GET", "/api/whoami");
  check("bot PIN reset: Jacob's Bot locked before its owner resets", locked.status === 423);
  await resetAs("jacob");
  await resetAs("dylan");

  const setD = await human.dylan.fetch("GET", "/api/webhooks");
  const setJ = await human.jacob.fetch("GET", "/api/webhooks");
  const dOk = setD.status === 200 && setD.data.myBot?.id === "dylan_bot" && setD.data.pinReset?.actor === "dylan" && !JSON.stringify(setD.data).includes(C.dylan_bot);
  const jOk = setJ.status === 200 && setJ.data.myBot?.id === "jacob_bot" && setJ.data.pinReset?.actor === "jacob" && !JSON.stringify(setJ.data).includes(C.jacob_bot);
  check("settings: Dylan sees only his bot for PIN reset, no PIN in the payload", dOk);
  check("settings: Jacob sees only his bot for PIN reset, no PIN in the payload", jOk);
  credsRef.C = C;
}
