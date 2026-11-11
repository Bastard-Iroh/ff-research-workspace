(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const STATUS = { todo: "To do", in_progress: "In progress", done: "Done" };
  const state = { me: null, members: [], rooms: [], room: "talk", filter: "", messages: [], docs: [], doc: null, editing: false, socket: null };

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
      state.members.some((x) => x.handle === h.toLowerCase() || x.id === h.toLowerCase()) ? `${pre}<span class="mention">@${h}</span>` : m);
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
  $("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); state.socket?.disconnect(); showLogin(); };

  // ---------- app ----------
  async function boot() {
    const s = await api("/api/session");
    if (!s.user) return showLogin();
    state.me = s.user;
    state.members = (await api("/api/members")).members;
    state.rooms = (await api("/api/rooms")).rooms;
    $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
    $("#me-name").textContent = state.me.name;
    const pf = $("#people-filter"); pf.innerHTML = `<option value="">Everyone</option>` + state.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
    pf.value = state.filter;
    if (!state.rooms.some((r) => r.id === state.room)) state.room = "talk";
    renderNav(); connectSocket(); openRoom(state.room);
  }
  function renderNav() {
    const nav = $("#rooms"); nav.innerHTML = "";
    for (const r of state.rooms) {
      const b = document.createElement("button"); b.dataset.room = r.id; b.className = r.id === state.room ? "active" : "";
      b.innerHTML = `<span class="dot"></span>${esc(r.name)}`; b.onclick = () => openRoom(r.id); nav.appendChild(b);
    }
  }
  $("#people-filter").onchange = (e) => { state.filter = e.target.value; openRoom(state.room); };

  function connectSocket() {
    state.socket?.disconnect();
    const sock = io({ transports: ["websocket", "polling"] });
    sock.on("message:new", (m) => { if (m.room === state.room && (!state.filter || m.author === state.filter)) { state.messages.push(m); renderFeed(true); } });
    sock.on("message:update", (m) => { const i = state.messages.findIndex((x) => x.id === m.id); if (i >= 0) { state.messages[i] = m; renderFeed(); } });
    sock.on("doc:update", ({ id }) => { if (state.room === "docs" && !state.editing) loadDocs(state.doc?.doc?.id === id ? id : state.doc?.doc?.id); });
    state.socket = sock;
  }

  async function openRoom(id) {
    state.room = id; state.editing = false; renderNav(); $("#toast").classList.add("hidden");
    const r = state.rooms.find((x) => x.id === id);
    $("#room-title").textContent = r.name; $("#room-desc").textContent = r.description;
    if (r.kind === "docs") return loadDocs();
    const q = new URLSearchParams({ limit: "200" }); if (state.filter) q.set("author", state.filter);
    const { messages } = await api(`/api/rooms/${id}/messages?${q}`);
    state.messages = messages;
    renderChat(r);
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
      } catch (err) { toast(err.message, true); }
    };
    renderFeed(true);
  }

  function renderFeed(scroll) {
    const feed = $("#feed"); if (!feed) return;
    const work = state.room === "work";
    if (!state.messages.length) { feed.innerHTML = `<p class="empty">${state.filter ? "No posts from " + esc(nameOf(state.filter)) + " here yet." : "Nothing here yet."}</p>`; return; }
    feed.innerHTML = state.messages.map((m) => `
      <article class="msg ${work ? "status-" + m.status : ""}" data-id="${m.id}">
        <div class="meta"><span class="who ${m.author}">${esc(m.authorName)}</span>${isBotId(m.author) ? `<span class="badge bot">bot</span>` : ""}
          <time class="when" datetime="${new Date(m.createdAt).toISOString()}">${fmtTime(m.createdAt)}</time>
          ${m.commands.map((c) => `<span class="badge" title="${m.commandKind === "handoff" ? "Bot-to-bot handoff: valid command for the receiving bot" : "Valid command from an owner"}">${m.commandKind === "handoff" ? "handoff" : "command"} → ${esc(nameOf(c))}</span>`).join("")}</div>
        <div class="body">${renderBody(m.body)}</div>
        ${m.file ? `<a class="file" href="${m.file.url}">📎 ${esc(m.file.name)} (${fmtSize(m.file.size)})</a>` : ""}
        ${work ? `<div class="work-ctrls">
          <label>Status <select data-act="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === m.status ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label>Assigned to <select data-act="assignee">${memberOptions(m.assignee, true)}</select></label>
          ${m.updatedAt !== m.createdAt ? `<span class="muted">updated ${fmtTime(m.updatedAt)}</span>` : ""}</div>` : ""}
      </article>`).join("");
    if (work) feed.querySelectorAll("select[data-act]").forEach((sel) => sel.onchange = async () => {
      const id = sel.closest(".msg").dataset.id;
      try { await api(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify({ [sel.dataset.act]: sel.value || null }) }); }
      catch (err) { toast(err.message, true); }
    });
    if (scroll) feed.scrollTop = feed.scrollHeight;
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
      <div class="toolbar"><button class="brass small" id="edit-doc">${owner ? "Edit" : "Suggest an edit"}</button></div>
      ${pending.length ? `<h4>Pending suggestions</h4>${pending.map(sugHtml).join("")}` : ""}
      ${done.length ? `<h4 class="muted">History</h4>${done.map(sugHtml).join("")}` : ""}`;
    $("#edit-doc").onclick = () => renderEditor(d);
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
