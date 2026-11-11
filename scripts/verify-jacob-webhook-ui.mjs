// Jacob's Settings webhook flow in the browser: URL, custom auth header, Send test, and clear.
// Never prints header values or signing secrets.
export async function runJacobWebhookUiTests(ctx) {
  const { page, check, clickJs, sleep, receiverUrl, readInbox, clearInbox, tag } = ctx;
  const secret = `ffwui_${tag}`;
  await clickJs(page, '#rooms button[data-room="settings"]');
  await page.waitForSelector("#settings");
  const help = await page.$eval("#hook-help", (e) => e.innerText).catch(() => "");
  check("UI: Settings help note walks an owner through webhook setup", /Paste your bot's HTTPS webhook URL/.test(help) && /Save header/.test(help) && /Send test/.test(help) && /Clear/.test(help) && /Jacob/.test(help));
  const editable = await page.$$eval("#settings .hook-url", (e) => e.length);
  const jacobEdit = await page.$eval('#settings [data-bot="jacob_bot"]', (e) => !!e.querySelector(".hook-url"));
  const dylanLocked = await page.$eval('#settings [data-bot="dylan_bot"]', (e) => e.innerText);
  check("UI: Settings shows Jacob an editable webhook for Jacob's Bot only", editable === 1 && jacobEdit && /Only Dylan can change this/.test(dylanLocked));

  const urlSel = '#settings [data-bot="jacob_bot"] .hook-url';
  await page.$eval(urlSel, (e) => { e.value = ""; });
  await page.type(urlSel, receiverUrl);
  await clickJs(page, '#settings [data-bot="jacob_bot"] [data-act="save"]');
  await page.waitForFunction(() => document.querySelector('#settings [data-bot="jacob_bot"] .hook-secret code.secret-once')?.textContent.startsWith("whsec_"), { timeout: 10000 }).catch(() => {});
  const savedSecret = await page.$eval('#settings [data-bot="jacob_bot"] .hook-secret code.secret-once', (e) => e.textContent).catch(() => "");
  check("UI: Jacob saves his bot's webhook URL and sees the signing secret once", /^whsec_/.test(savedSecret));

  await page.type('#settings [data-bot="jacob_bot"] .hook-auth-name', "X-Sender-Key");
  await page.type('#settings [data-bot="jacob_bot"] .hook-auth-value', secret);
  await clickJs(page, '#settings [data-bot="jacob_bot"] [data-act="save-auth"]');
  await page.waitForFunction(() => /Custom auth header: set/.test(document.querySelector('#settings [data-bot="jacob_bot"]')?.innerText || ""), { timeout: 10000 }).catch(() => {});
  const card = await page.$eval('#settings [data-bot="jacob_bot"]', (e) => e.innerText);
  const valueField = await page.$eval('#settings [data-bot="jacob_bot"] .hook-auth-value', (e) => e.value);
  check("UI: Jacob saves a custom auth header; Settings shows set, not the secret", /Custom auth header: set/.test(card) && /X-Sender-Key/.test(card) && !card.includes(secret) && valueField === "");

  await clearInbox();
  await clickJs(page, '#settings [data-bot="jacob_bot"] [data-act="test"]');
  await page.waitForFunction(() => /Test delivered/.test(document.querySelector("#toast")?.textContent || ""), { timeout: 12000 }).catch(() => {});
  const toast = await page.$eval("#toast", (e) => e.textContent).catch(() => "");
  check("UI: Jacob Send test reports delivery OK", /Test delivered/.test(toast));

  let got = [];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { got = await readInbox(); if (got.length) break; await sleep(400); }
  const n = got.find((x) => x.bot === "jacob_bot") || got[0];
  const hdrs = n?.headers || {};
  const sent = hdrs["x-sender-key"] ?? hdrs["X-Sender-Key"];
  let payloadOk = false;
  try { payloadOk = !!n && JSON.parse(n.body).type === "test"; } catch {}
  check("UI: Jacob's test notice arrives with his custom auth header", payloadOk && sent === secret);

  await clickJs(page, '#settings [data-bot="jacob_bot"] [data-act="clear-auth"]');
  await page.waitForFunction(() => /Custom auth header: not set/.test(document.querySelector('#settings [data-bot="jacob_bot"]')?.innerText || ""), { timeout: 10000 }).catch(() => {});
  check("UI: Jacob clears the auth header from Settings", /Custom auth header: not set/.test(await page.$eval('#settings [data-bot="jacob_bot"]', (e) => e.innerText)));

  await clickJs(page, '#settings [data-bot="jacob_bot"] [data-act="clear"]');
  await page.waitForFunction(() => document.querySelector('#settings [data-bot="jacob_bot"] [data-act="test"]')?.disabled, { timeout: 10000 }).catch(() => {});
  const after = await page.$eval('#settings [data-bot="jacob_bot"]', (e) => e.innerText);
  check("UI: Jacob clears his bot's webhook URL from Settings", /Status: not set/.test(after));
}
