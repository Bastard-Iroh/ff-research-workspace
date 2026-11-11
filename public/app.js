(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const STATUS = { todo: "To do", in_progress: "In progress", done: "Done" };
  const state = { since: 0, me: null, members: [], rooms: [], room: "talk", filter: "", messages: [], docs: [], doc: null, editing: false };

  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: "same-origin", ...opts,
      headers: { "X-FFW": "1", ...(opts.body && !(opts.body instanceof Blob) ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status, data });
    return data;
  }
  function toast(msg, err) { const t = $("#toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : ""); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), 4200); }
  const nameOf = (id) => state.members.find((m) => m.id === id)?.name || id || "";
  const fmtTime = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB");
  const isBotId = (id) => state.members.find((m) => m.id === id)?.type === "bot";

  function renderBody(text) {
    return esc(text).replace(/(^|[^\w@])@([a-z0-9][a-z0-9_-]*)/gi, (m, pre, h) =>
      state.members.some((x) => { const tok = h.toLowerCase(); return x.handle === tok || x.id === tok || (x.aliases || []).includes(tok); }) ? `${pre}<span class="mention">@${h}</span>` : m);
  }

  // ---------- login ----------
  let picked = null;
  async function showLogin() {
    $("#app").classList.add("hidden"); $("#login").classList.remove("hidden");
    const { members } = await api("/api/session");
    const np = $("#name-picker"); np.innerHTML = "";
    for (const m of members) {
      const b = document.createElement("button"); b.type = "button"; b.dataset.id = m.id;
      b.innerHTML = `${esc(m.name)}<span class="kind">${m.type === "bot" ? "Bot" : "Person"}</span>`;
      b.onclick = () => { picked = m.id; np.querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x === b)); $("#pin").focus(); };
      np.appendChild(b);
    }
  }
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault(); $("#login-error").textContent = "";
    if (!picked) { $("#login-error").textContent = "Pick your name first."; return; }
    try { await api("/api/login", { method: "POST", body: JSON.stringify({ member: picked, pin: $("#pin").value }) }); $("#pin").value = ""; boot(); }
    catch (err) { $("#login-error").textContent = err.message; }
  });
  $("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); state.me = null; clearTimeout(pollTimer); showLogin(); };

  function fillPeople() {
    const pf = $("#people-filter"); const cur = pf.value;
    pf.innerHTML = `<option value="">Everyone</option>` + state.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
    if ([...pf.options].some((o) => o.value === cur)) pf.value = cur;
  }
  async function refreshMembers() {
    state.members = (await api("/api/members")).members;
    fillPeople();
  }

  // ---------- app ----------
  async function boot() {
    const s = await api("/api/session");
    if (!s.user) return showLogin();
    state.me = s.user;
    state.members = (await api("/api/members")).members;
    state.rooms = (await api("/api/rooms")).rooms;
    $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
    $("#me-name").textContent = state.me.name;
    fillPeople();
    $("#people-filter").value = state.filter;
    if (!state.rooms.some((r) => r.id === state.room)) state.room = "talk";
    renderNav(); openRoom(state.room);
  }
  function renderNav() {
    const nav = $("#rooms"); nav.innerHTML = "";
    for (const r of state.rooms) {
      const b = document.createElement("button"); b.dataset.room = r.id; b.className = r.id === state.room ? "active" : "";
      b.innerHTML = `<span class="dot"></span>${esc(r.name)}`; b.onclick = () => openRoom(r.id); nav.appendChild(b);
    }
    if (state.me.type === "human") {
      const b = document.createElement("button"); b.dataset.room = "settings"; b.className = state.room === "settings" ? "active" : "";
      b.innerHTML = `<span class="dot"></span>Settings`; b.onclick = () => openSettings(); nav.appendChild(b);
    }
  }
  $("#people-filter").onchange = (e) => { state.filter = e.target.value; openRoom(state.room); };

  // ---------- polling (replaces websockets on Vercel) ----------
  // Every 10s while the tab is visible and you've been active in the last 3 minutes, every 60s when idle, paused when hidden.
  // (Kept modest because the free database plan has a monthly operation cap.)
  let lastActive = Date.now(), pollTimer = null;
  ["pointerdown", "keydown", "scroll", "touchstart"].forEach((ev) => addEventListener(ev, () => { const idle = Date.now() - lastActive > 180000; lastActive = Date.now(); if (idle) schedulePoll(300); }, { passive: true, capture: true }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastActive = Date.now(); schedulePoll(200); } });
  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    if (!state.me) return;
    const delay = ms ?? (Date.now() - lastActive > 180000 ? 60000 : 10000);
    pollTimer = setTimeout(async () => { if (!document.hidden) { try { await pollOnce(); } catch (e) { if (e.status === 401) return showLogin(); } } schedulePoll(); }, delay);
  }
  async function pollOnce() {
    const room = state.room;
    if (room === "settings") return;
    if (room === "docs") {
      if (state.editing) return;
      const q = state.filter ? `?owner=${state.filter}` : "";
      const { docs } = await api(`/api/docs${q}`);
      const sig = (l) => l.map((d) => `${d.id}:${d.updatedAt}:${d.pendingSuggestions}`).join(",");
      if (sig(docs) !== sig(state.docs) && room === state.room && !state.editing) loadDocs(state.doc?.doc?.id);
      return;
    }
    const q = new URLSearchParams({ since: String(Math.max(0, state.since - 3000)) }); if (state.filter) q.set("author", state.filter);
    const { messages, serverTime } = await api(`/api/rooms/${room}/messages?${q}`);
    if (room !== state.room) return;
    state.since = serverTime;
    let added = false, changed = false;
    for (const m of messages) {
      const i = state.messages.findIndex((x) => x.id === m.id);
      if (i < 0) { state.messages.push(m); added = true; }
      else if (state.messages[i].updatedAt !== m.updatedAt) { state.messages[i] = m; changed = true; }
    }
    if (added || changed) { state.messages.sort((x, y) => x.id - y.id); renderFeed(added); }
  }

  async function openRoom(id) {
    if (id === "settings") return openSettings();
    state.room = id; state.editing = false; renderNav(); $("#toast").classList.add("hidden");
    const r = state.rooms.find((x) => x.id === id);
    $("#room-title").textContent = r.name; $("#room-desc").textContent = r.description;
    const tl = $("#transcript-link"); tl.classList.toggle("hidden", r.kind === "docs"); tl.href = `/transcript.html?room=${r.id}`;
    if (r.kind === "docs") { await loadDocs(); return schedulePoll(); }
    const q = new URLSearchParams({ limit: "50" }); if (state.filter) q.set("author", state.filter);
    const { messages, serverTime, hasMore } = await api(`/api/rooms/${id}/messages?${q}`);
    state.messages = messages; state.since = serverTime; state.hasMore = hasMore;
    renderChat(r); schedulePoll();
  }

  function memberOptions(sel, withNone) {
    return (withNone ? `<option value="">Unassigned</option>` : "") + state.members.map((m) => `<option value="${m.id}" ${m.id === sel ? "selected" : ""}>${esc(m.name)}</option>`).join("");
  }

  function renderChat(room) {
    const work = room.kind === "work";
    $("#view").innerHTML = `<div class="feed" id="feed"></div>
      <form class="composer" id="composer">
        <textarea id="body" rows="2" placeholder="${work ? "New task or update…" : "Message " + esc(room.name) + "…  (@" + state.members.filter((m) => m.type === "bot").map((m) => esc(m.handle)).join(" or @") + " to give a bot a command)"}"></textarea>
        <div class="row">
          ${work ? `<label class="muted">Status <select id="new-status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
                    <label class="muted">Assign <select id="new-assignee">${memberOptions("", true)}</select></label>` : ""}
          <input type="file" id="file" class="hidden"><button type="button" class="ghost small" id="attach">Attach file</button>
          <span id="file-name" class="muted grow"></span>
          <button class="brass" type="submit">${work ? "Post" : "Send"}</button>
        </div>
      </form>`;
    $("#attach").onclick = () => $("#file").click();
    $("#file").onchange = () => { const f = $("#file").files[0]; $("#file-name").textContent = f ? `${f.name} (${fmtSize(f.size)})` : ""; };
    $("#body").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !work) { e.preventDefault(); $("#composer").requestSubmit(); } });
    $("#composer").onsubmit = async (e) => {
      e.preventDefault();
      const body = $("#body").value.trim(); const file = $("#file").files[0];
      const extra = work ? { status: $("#new-status").value, assignee: $("#new-assignee").value || undefined } : {};
      try {
        if (file) {
          if (file.size > 4 * 1024 * 1024) throw new Error("File is over the 4 MB limit.");
          const q = new URLSearchParams({ name: file.name, caption: body }); if (work) { q.set("status", extra.status); if (extra.assignee) q.set("assignee", extra.assignee); }
          await api(`/api/rooms/${room.id}/files?${q}`, { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
        } else {
          if (!body) return;
          await api(`/api/rooms/${room.id}/messages`, { method: "POST", body: JSON.stringify({ body, ...extra }) });
        }
        $("#body").value = ""; $("#file").value = ""; $("#file-name").textContent = "";
        await pollOnce();
      } catch (err) { toast(err.message, true); }
    };
    renderFeed(true);
  }

  function renderFeed(scroll) {
    const feed = $("#feed"); if (!feed) return;
    const work = state.room === "work";
    if (!state.messages.length) { feed.innerHTML = `<p class="empty">${state.filter ? "No posts from " + esc(nameOf(state.filter)) + " here yet." : "Nothing here yet."}</p>`; return; }
    const older = state.hasMore ? `<div class="toolbar" style="justify-content:center"><button class="ghost small" id="load-older">Load older</button> <a class="ghost small" href="/transcript.html?room=${state.room}">Full transcript</a></div>` : "";
    feed.innerHTML = older + state.messages.map((m) => `
      <article class="msg ${work ? "status-" + m.status : ""}" data-id="${m.id}">
        <div class="meta"><span class="who ${m.author}">${esc(m.authorName)}</span>${isBotId(m.author) ? `<span class="badge bot">bot</span>` : ""}
          <time class="when" datetime="${new Date(m.createdAt).toISOString()}">${fmtTime(m.createdAt)}</time>
          ${m.commands.map((c) => `<span class="badge" title="${m.commandKind === "handoff" ? "Bot-to-bot handoff: valid command for the receiving bot" : "Valid command from an owner"}">${m.commandKind === "handoff" ? "handoff" : "command"} → ${esc(nameOf(c))}</span>`).join("")}</div>
        <div class="body">${renderBody(m.body)}</div>
        ${m.file ? `<a class="file" href="${m.file.url}">📎 ${esc(m.file.name)} (${fmtSize(m.file.size)})</a>` : ""}
        ${work ? `<div class="work-ctrls">
          <label>Status <select data-act="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === m.status ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label>Assigned to <select data-act="assignee">${memberOptions(m.assignee, true)}</select></label>
          ${m.updatedAt !== m.createdAt ? `<span class="muted">updated ${fmtTime(m.updatedAt)}</span> <button class="ghost small" data-hist="${m.id}">History</button>` : ""}</div><div class="hist muted"></div>` : ""}
      </article>`).join("");
    if (work) feed.querySelectorAll("select[data-act]").forEach((sel) => sel.onchange = async () => {
      const id = sel.closest(".msg").dataset.id;
      try { await api(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify({ [sel.dataset.act]: sel.value || null }) }); await pollOnce(); }
      catch (err) { toast(err.message, true); }
    });
    feed.querySelectorAll("[data-hist]").forEach((b) => b.onclick = async () => {
      const box = b.closest(".msg").querySelector(".hist");
      const { history } = await api(`/api/messages/${b.dataset.hist}/history`);
      const fmt = (k, v) => (k === "status" ? STATUS[v] || v : nameOf(v) || "Unassigned");
      box.innerHTML = history.map((h) => `<div>${fmtTime(h.at)} · ${esc(h.actorName)}: ${Object.entries(h.changes).map(([k, [a, b2]]) => `${k} ${esc(fmt(k, a))} → ${esc(fmt(k, b2))}`).join(", ")}</div>`).join("") || "No changes.";
    });
    const lo = $("#load-older");
    if (lo) lo.onclick = async () => {
      const q = new URLSearchParams({ limit: "50", before: String(state.messages[0]?.id || 0) }); if (state.filter) q.set("author", state.filter);
      const room = state.room, prevH = feed.scrollHeight;
      const { messages, hasMore } = await api(`/api/rooms/${room}/messages?${q}`);
      if (room !== state.room) return;
      state.messages = [...messages.filter((m) => !state.messages.some((x) => x.id === m.id)), ...state.messages]; state.hasMore = hasMore;
      renderFeed(false); feed.scrollTop = feed.scrollHeight - prevH;
    };
    if (scroll) feed.scrollTop = feed.scrollHeight;
  }


  // ---------- settings: bot webhooks (humans only) ----------
  async function openSettings() {
    try { await refreshMembers(); } catch {}
    state.room = "settings"; state.editing = false; renderNav(); $("#transcript-link").classList.add("hidden"); $("#toast").classList.add("hidden");
    $("#room-title").textContent = "Settings"; $("#room-desc").textContent = "Your bot's name, webhooks, and PIN.";
    let data;
    try { data = await api("/api/webhooks"); } catch (err) { $("#view").innerHTML = `<p class="empty">${esc(err.message)}</p>`; return; }
    const card = (w) => `<section class="sugg" data-bot="${w.botId}">
        <h3>${esc(w.botName)} webhook</h3>
        <p class="muted">Managed by ${esc(w.managedByName)}. Status: ${w.configured ? "set" : "not set"}${w.lastDelivery ? ` · last delivery <b>${esc(w.lastDelivery.status)}</b>${w.lastDelivery.error ? " (" + esc(w.lastDelivery.error) + ")" : ""} for ${esc(w.lastDelivery.type)} at ${fmtTime(w.lastDelivery.at)}` : ""}</p>
        ${w.canEdit ? `<div class="row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
            <input class="hook-url" style="flex:1;min-width:220px" type="url" placeholder="https://your-bot.example.com/hook" value="${esc(w.url || "")}">
            <button class="brass small" data-act="save">Save</button>
            <button class="small" data-act="test" ${w.configured ? "" : "disabled"}>Send test</button>
            <button class="danger small" data-act="clear" ${w.configured ? "" : "disabled"}>Clear</button></div>
          <p class="muted hook-secret"></p>
          <p class="muted" style="margin-top:12px">Custom auth header: <b>${w.authHeader?.set ? "set" : "not set"}</b>${w.authHeader?.name ? " (" + esc(w.authHeader.name) + ")" : ""}. Sent with every notice, including tests. The secret is stored and never shown again.</p>
          <div class="row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
            <input class="hook-auth-name" style="flex:1;min-width:160px" placeholder="Header name (e.g. X-Sender-Key)" value="${esc(w.authHeader?.name || "")}" ${w.configured ? "" : "disabled"}>
            <input class="hook-auth-value" style="flex:1;min-width:160px" type="password" autocomplete="off" placeholder="${w.authHeader?.set ? "Enter a new value to replace it" : "Secret value"}" ${w.configured ? "" : "disabled"}>
            <button class="brass small" data-act="save-auth" ${w.configured ? "" : "disabled"}>Save header</button>
            <button class="danger small" data-act="clear-auth" ${w.authHeader?.set ? "" : "disabled"}>Clear header</button>
          </div>` : `<p class="muted">Only ${esc(w.managedByName)} can change this.${w.authHeader?.set ? " Custom auth header: set." : " Custom auth header: not set."}</p>`}
      </section>`;
    const nameCard = data.myBot ? `<section class="sugg" id="bot-name">
        <h3>My bot's name</h3>
        <p class="muted">The workspace follows the name your bot reports with <code>PUT /api/me/name</code>. You can also set it here as a manual override. Current: <b>${esc(data.myBot.name)}</b> (@${esc(data.myBot.handle)}).</p>
        ${data.nameChange ? `<p class="muted">Last changed ${fmtTime(data.nameChange.at)} by ${esc(data.nameChange.actorName)}${data.nameChange.name ? " to " + esc(data.nameChange.name) : ""}.</p>` : ""}
        <div class="row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <input id="bot-name-input" style="flex:1;min-width:160px" maxlength="40" value="${esc(data.myBot.name)}" placeholder="Bot name">
          <button class="brass small" id="save-bot-name">Save name</button>
        </div>
        <p class="muted" id="bot-name-msg"></p>
      </section>` : "";
    const pinCard = data.myBot ? `<section class="sugg" id="bot-pin">
        <h3>Reset my bot's PIN</h3>
        <p class="muted">This makes a new PIN for <b>${esc(data.myBot.name)}</b> only. The current PIN stops working immediately. You'll see the new one once — copy it now.</p>
        ${data.pinReset ? `<p class="muted">Last reset ${fmtTime(data.pinReset.at)} by ${esc(data.pinReset.actorName)}.</p>` : ""}
        <div class="toolbar" style="margin-top:8px">
          <button class="danger small" id="reset-bot-pin">Reset my bot's PIN</button>
          <button class="ghost small hidden" id="cancel-bot-pin">Cancel</button>
        </div>
        <p class="muted" id="new-bot-pin"></p>
      </section>` : "";
    $("#view").innerHTML = `<div class="docpane" id="settings">
      <div class="sugg" id="hook-help">
        <h3>Set up your bot's webhook</h3>
        <ol class="muted" style="padding-left:1.2em;margin:8px 0">
          <li>Paste your bot's HTTPS webhook URL under your bot's name and click Save. Copy the signing secret when it appears — it is shown only once.</li>
          <li>If the receiver needs a sender key, enter the header name and secret, then click Save header. The secret is stored on the server and never shown again.</li>
          <li>Click Send test. A successful delivery means your bot will get a short notice when something targets it.</li>
          <li>Clear the header or the URL at any time. You can only change your own bot (Dylan → Dylan's Bot, Jacob → Jacob's Bot).</li>
        </ol>
      </div>
      <p class="muted">Notices are sent for: @mentions and bot handoffs, Work posts assigned to the bot, suggestions on the bot's docs (and decisions on its suggestions), and any message from Dylan or Jacob. Never for Owners only, never for the bot's own actions. Payload: <code>{type, room, itemId, author, time}</code>, no message text.</p>
      ${data.webhooks.map(card).join("")}
      ${nameCard}
      ${pinCard}</div>`;
    document.querySelectorAll("#settings [data-act]").forEach((b) => b.onclick = async () => {
      const sec = b.closest("[data-bot]"), bot = sec.dataset.bot;
      try {
        if (b.dataset.act === "save") {
          const r = await api(`/api/webhooks/${bot}`, { method: "PUT", body: JSON.stringify({ url: sec.querySelector(".hook-url").value }) });
          await openSettings();
          const out = document.querySelector(`#settings [data-bot="${bot}"] .hook-secret`);
          if (out) out.innerHTML = `Signing secret (shown once, copy it now): <code class="secret-once">${esc(r.secret)}</code><br>Each notice has <code>X-FFW-Signature: sha256=HMAC(secret, body)</code>.`;
          toast("Webhook saved.");
        } else if (b.dataset.act === "clear") {
          await api(`/api/webhooks/${bot}`, { method: "DELETE" }); toast("Webhook cleared."); openSettings();
        } else if (b.dataset.act === "save-auth") {
          await api(`/api/webhooks/${bot}/auth-header`, { method: "PUT", body: JSON.stringify({ name: sec.querySelector(".hook-auth-name").value, value: sec.querySelector(".hook-auth-value").value }) });
          toast("Auth header saved. The secret will not be shown again.");
          openSettings();
        } else if (b.dataset.act === "clear-auth") {
          await api(`/api/webhooks/${bot}/auth-header`, { method: "DELETE" }); toast("Auth header cleared."); openSettings();
        } else {
          const r = await api(`/api/webhooks/${bot}/test`, { method: "POST" });
          toast(r.result.ok ? `Test delivered (${r.result.status}).` : `Test failed: ${r.result.status}${r.result.error ? " - " + r.result.error : ""}`, !r.result.ok);
          openSettings();
        }
      } catch (err) { toast(err.message, true); }
    });
    const saveName = $("#save-bot-name"), nameInput = $("#bot-name-input");
    if (saveName) {
      saveName.onclick = async () => {
        try {
          const r = await api("/api/bot/name", { method: "PUT", body: JSON.stringify({ name: nameInput.value }) });
          toast(r.unchanged ? "Name is already current." : `Name saved: ${r.name} (@${r.handle}).`);
          const mine = state.members.find((m) => m.id === data.myBot.id);
          if (mine) { mine.name = r.name; mine.handle = r.handle; mine.aliases = r.aliases || []; }
          fillPeople();
          openSettings();
        } catch (err) { toast(err.message, true); }
      };
    }
    const resetBtn = $("#reset-bot-pin"), cancelBtn = $("#cancel-bot-pin"), pinOut = $("#new-bot-pin");
    if (resetBtn) {
      let pending = false;
      cancelBtn.onclick = () => { pending = false; resetBtn.disabled = false; resetBtn.textContent = "Reset my bot's PIN"; cancelBtn.classList.add("hidden"); };
      resetBtn.onclick = async () => {
        if (!pending) {
          pending = true;
          resetBtn.textContent = "Confirm reset — the old PIN will stop working";
          cancelBtn.classList.remove("hidden");
          return;
        }
        resetBtn.disabled = true;
        cancelBtn.classList.add("hidden");
        try {
          const r = await api("/api/bot-pin/reset", { method: "POST", body: "{}" });
          pinOut.innerHTML = `New PIN for ${esc(r.bot.name)} (shown once, copy it now): <code class="secret-once" id="bot-pin-value">${esc(r.pin)}</code> <button class="brass small" id="copy-bot-pin">Copy</button><br>${esc(r.pinNote || "")}`;
          $("#copy-bot-pin").onclick = async () => {
            try { await navigator.clipboard.writeText(r.pin); toast("PIN copied."); }
            catch { toast("Copy failed — select and copy it yourself.", true); }
          };
          toast("New bot PIN created. The old one no longer works.");
        } catch (err) {
          toast(err.message, true);
          pending = false;
          resetBtn.disabled = false;
          resetBtn.textContent = "Reset my bot's PIN";
        }
      };
    }
  }

  // ---------- documents ----------
  async function loadDocs(selectId) {
    const q = state.filter ? `?owner=${state.filter}` : "";
    state.docs = (await api(`/api/docs${q}`)).docs;
    const id = selectId ?? state.doc?.doc?.id ?? state.docs[0]?.id;
    state.doc = id && state.docs.some((d) => d.id === id) ? await api(`/api/docs/${id}`) : null;
    renderDocs();
  }
  function lineDiff(a, b) {
    const A = a.split("\n"), B = b.split("\n"), n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) { if (A[i] === B[j]) { out.push(["same", A[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(["del", A[i++]]); else out.push(["add", B[j++]]); }
    while (i < n) out.push(["del", A[i++]]); while (j < m) out.push(["add", B[j++]]);
    return out.map(([k, t]) => `<span class="${k}">${k === "add" ? "+ " : k === "del" ? "− " : "  "}${esc(t) || " "}</span>`).join("");
  }
  function renderDocs() {
    const d = state.doc;
    $("#view").innerHTML = `<div class="docs">
      <div class="doclist"><button class="brass small" id="new-doc" style="width:100%;margin-bottom:10px">New document</button>
        ${state.docs.map((x) => `<button class="item ${d?.doc.id === x.id ? "active" : ""}" data-id="${x.id}">${esc(x.title)}<small>Owner: ${esc(x.ownerName)} · ${fmtTime(x.updatedAt)}${x.pendingSuggestions ? ` · ${x.pendingSuggestions} pending` : ""}</small></button>`).join("") || `<p class="muted">No documents${state.filter ? " owned by " + esc(nameOf(state.filter)) : ""}.</p>`}
      </div>
      <div class="docpane" id="docpane"></div></div>`;
    $("#new-doc").onclick = () => renderEditor(null);
    document.querySelectorAll(".doclist .item").forEach((b) => b.onclick = () => { state.editing = false; loadDocs(Number(b.dataset.id)); });
    const pane = $("#docpane");
    if (!d) { pane.innerHTML = `<p class="empty">Select or create a document.</p>`; return; }
    const doc = d.doc, owner = d.youAreOwner;
    const pending = d.suggestions.filter((s) => s.status === "pending"), done = d.suggestions.filter((s) => s.status !== "pending");
    const sugHtml = (s) => `<div class="sugg ${s.status}" data-sid="${s.id}">
        <div class="meta"><span class="who ${s.author}">${esc(s.authorName)}</span> suggested <time class="when">${fmtTime(s.createdAt)}</time> <span class="badge">${s.status}</span>${s.decidedBy ? ` <span class="muted">by ${esc(nameOf(s.decidedBy))} ${fmtTime(s.decidedAt)}</span>` : ""}</div>
        ${s.note ? `<p class="muted">Note: ${esc(s.note)}</p>` : ""}
        ${s.before.title !== s.after.title ? `<p class="muted">Title: <s>${esc(s.before.title)}</s> → <b>${esc(s.after.title)}</b></p>` : ""}
        <div class="diff">${lineDiff(s.before.body, s.after.body)}</div>
        ${s.status === "pending" && owner ? `<div class="toolbar"><button class="brass small" data-act="accept">Accept</button><button class="danger small" data-act="reject">Reject</button></div>` : ""}
        ${s.status === "pending" && !owner ? `<p class="muted">Waiting for ${esc(doc.ownerName)} to accept or reject.</p>` : ""}</div>`;
    pane.innerHTML = `<h3>${esc(doc.title)}</h3>
      <p class="muted">Owner: <span class="who ${doc.owner}">${esc(doc.ownerName)}</span> · last change ${fmtTime(doc.updatedAt)} by ${esc(nameOf(doc.updatedBy))}</p>
      <div class="docbody">${esc(doc.body) || '<span class="muted">(empty)</span>'}</div>
      <div class="toolbar"><button class="brass small" id="edit-doc">${owner ? "Edit" : "Suggest an edit"}</button><button class="ghost small" id="doc-versions">Version history</button></div>
      <div id="versions"></div>
      ${pending.length ? `<h4>Pending suggestions</h4>${pending.map(sugHtml).join("")}` : ""}
      ${done.length ? `<h4 class="muted">History</h4>${done.map(sugHtml).join("")}` : ""}`;
    $("#edit-doc").onclick = () => renderEditor(d);
    $("#doc-versions").onclick = async () => {
      const { versions } = await api(`/api/docs/${doc.id}/versions`);
      const src = { create: "created", edit: "edited by owner", suggestion: "accepted suggestion", existing: "saved" };
      $("#versions").innerHTML = `<h4>All versions (kept permanently)</h4>` + versions.map((v) => `<details class="sugg"><summary>v${v.version} · ${esc(v.title)} · ${esc(src[v.source] || v.source)} · ${esc(v.authorName)} · ${fmtTime(v.at)}</summary><div class="docbody">${esc(v.body) || '<span class="muted">(empty)</span>'}</div></details>`).join("");
    };
    pane.querySelectorAll(".sugg [data-act]").forEach((b) => b.onclick = async () => {
      const sid = b.closest(".sugg").dataset.sid;
      try { const r = await api(`/api/suggestions/${sid}/${b.dataset.act}`, { method: "POST" }); toast(`Suggestion ${r.suggestion.status}.${r.staleBase ? " (Doc had changed since it was made.)" : ""}`); loadDocs(doc.id); }
      catch (err) { toast(err.message, true); }
    });
  }
  function renderEditor(d) {
    state.editing = true;
    const owner = !d || d.youAreOwner;
    $("#docpane").innerHTML = `<h3>${d ? (owner ? "Edit document" : "Suggest an edit") : "New document"}</h3>
      ${d && !owner ? `<p class="muted">You don't own this doc. Saving sends your version to ${esc(d.doc.ownerName)} as a suggestion.</p>` : ""}
      <input class="title" id="doc-title" placeholder="Title" value="${esc(d?.doc.title || "")}">
      <textarea id="doc-body" placeholder="Write here…">${esc(d?.doc.body || "")}</textarea>
      ${d && !owner ? `<input id="doc-note" class="title" placeholder="Note for the owner (optional)" style="margin-top:8px">` : ""}
      <div class="toolbar" style="margin-top:10px"><button class="brass" id="save-doc">${d && !owner ? "Send suggestion" : "Save"}</button><button class="ghost" id="cancel-doc">Cancel</button></div>`;
    $("#cancel-doc").onclick = () => { state.editing = false; renderDocs(); };
    $("#save-doc").onclick = async () => {
      const payload = { title: $("#doc-title").value, body: $("#doc-body").value };
      if ($("#doc-note")) payload.note = $("#doc-note").value;
      try {
        if (!d) { const r = await api("/api/docs", { method: "POST", body: JSON.stringify(payload) }); state.editing = false; return loadDocs(r.doc.id); }
        const r = await api(`/api/docs/${d.doc.id}`, { method: "PUT", body: JSON.stringify(payload) });
        if (r.suggested) toast(r.message);
        state.editing = false; loadDocs(d.doc.id);
      } catch (err) { toast(err.message, true); }
    };
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  boot().catch(() => showLogin());
})();
