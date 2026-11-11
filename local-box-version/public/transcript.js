// Full, paginated transcript of one room (oldest first). Everything posted is permanent.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const STATUS = { todo: "To do", in_progress: "In progress", done: "Done" };
  const fmt = (ms) => new Date(ms).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const params = new URLSearchParams(location.search);
  let room = params.get("room") || "talk", page = Number(params.get("page")) || 0, members = [];
  const PS = Math.min(Math.max(Number(params.get("pageSize")) || 100, 1), 200);
  const nameOf = (id) => members.find((m) => m.id === id)?.name || id || "Unassigned";
  async function api(path) {
    const r = await fetch(path, { credentials: "same-origin", headers: { "X-FFW": "1" } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `Error ${r.status}`), { status: r.status });
    return d;
  }
  async function load() {
    $("#t-error").textContent = "";
    try {
      const q = new URLSearchParams({ pageSize: String(PS) }); if (page) q.set("page", String(page));
      let d = await api(`/api/rooms/${room}/transcript?${q}`);
      if (!page) { page = d.totalPages; if (page > 1) d = await api(`/api/rooms/${room}/transcript?pageSize=${PS}&page=${page}`); }
      page = d.page;
      history.replaceState(null, "", `?room=${room}&page=${page}${PS !== 100 ? "&pageSize=" + PS : ""}`);
      $("#t-title").textContent = `${d.roomName} — full transcript`;
      $("#t-meta").textContent = `${d.total} item(s), oldest first. Nothing here can be deleted.`;
      $("#t-page").textContent = `Page ${d.page} of ${d.totalPages}`;
      $("#t-first").disabled = $("#t-prev").disabled = d.page <= 1;
      $("#t-next").disabled = $("#t-last").disabled = d.page >= d.totalPages;
      $("#t-last").onclick = () => { page = d.totalPages; load(); };
      $("#t-feed").innerHTML = d.messages.map((m) => `<article class="msg ${m.room === "work" ? "status-" + m.status : ""}">
        <div class="meta"><span class="who ${m.author}">${esc(m.authorName)}</span><time class="when">${fmt(m.createdAt)}</time>
          ${m.commands.map((c) => `<span class="badge">${m.commandKind === "handoff" ? "handoff" : "command"} → ${esc(nameOf(c))}</span>`).join("")}
          ${m.room === "work" ? `<span class="badge">${esc(STATUS[m.status])}${m.assignee ? " · " + esc(nameOf(m.assignee)) : ""}</span>` : ""}</div>
        <div class="body">${esc(m.body)}</div>
        ${m.file ? `<a class="file" href="${m.file.url}">📎 ${esc(m.file.name)}</a>` : ""}
        ${m.history?.length ? `<div class="muted">${m.history.map((h) => `${fmt(h.at)} · ${esc(h.actorName)}: ${Object.entries(h.changes).map(([k, [a, b]]) => `${k} ${esc(k === "status" ? STATUS[a] || a : nameOf(a))} → ${esc(k === "status" ? STATUS[b] || b : nameOf(b))}`).join(", ")}`).join("<br>")}</div>` : ""}
      </article>`).join("") || `<p class="empty">Nothing here yet.</p>`;
      window.scrollTo(0, 0);
    } catch (e) {
      if (e.status === 401) { location.href = "/"; return; }
      $("#t-feed").innerHTML = ""; $("#t-error").textContent = e.message;
    }
  }
  (async () => {
    const s = await api("/api/session");
    if (!s.user) { location.href = "/"; return; }
    members = (await api("/api/members")).members;
    const rooms = (await api("/api/rooms")).rooms.filter((r) => r.kind !== "docs");
    $("#t-room").innerHTML = rooms.map((r) => `<option value="${r.id}" ${r.id === room ? "selected" : ""}>${esc(r.name)}</option>`).join("");
    $("#t-room").onchange = (e) => { room = e.target.value; page = 0; load(); };
    $("#t-first").onclick = () => { page = 1; load(); };
    $("#t-prev").onclick = () => { page = Math.max(1, page - 1); load(); };
    $("#t-next").onclick = () => { page += 1; load(); };
    load();
  })();
})();
