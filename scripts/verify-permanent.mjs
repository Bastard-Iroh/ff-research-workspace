// Permanent record + pagination/transcript checks (shared by the box and live verify scripts).
// Run only against a TEST database: it posts ~60 messages, docs and suggestions that can never be deleted.
export async function runPermanentTests({ call, dylanS, jacobS, check, tag }) {
  // --- nothing can be deleted, message text can't be edited ---
  const m = await dylanS.fetch("POST", "/api/rooms/talk/messages", { body: `Permanent record check ${tag}` });
  const id = m.data.message.id;
  const delOwner = await dylanS.fetch("DELETE", `/api/messages/${id}`);
  const delBot = await call("dylan_bot", "DELETE", `/api/messages/${id}`);
  check("permanent: DELETE message → 405 for owner and bot", delOwner.status === 405 && delBot.status === 405 && delOwner.data?.code === "permanent_record");
  const put = await jacobS.fetch("PUT", `/api/messages/${id}`, { body: "rewritten" });
  const putBot = await call("jacob_bot", "PUT", `/api/messages/${id}`, { body: "rewritten" });
  check("permanent: message text can't be edited (PUT → 405)", put.status === 405 && putBot.status === 405);
  const others = await Promise.all([
    dylanS.fetch("DELETE", "/api/docs/1"), dylanS.fetch("DELETE", "/api/suggestions/1"), dylanS.fetch("DELETE", "/api/files/1"),
    dylanS.fetch("DELETE", "/api/rooms/talk/messages"), call("jacob_bot", "DELETE", "/api/docs/1"), call("jacob_bot", "DELETE", "/api/files/1"),
  ]);
  check("permanent: DELETE docs/suggestions/files/room → 405 for everyone", others.every((r) => r.status === 405), others.map((r) => r.status).join(","));
  const still = await call("jacob_bot", "GET", "/api/rooms/talk/messages?limit=5");
  check("permanent: message still there after delete attempts", still.data.messages.some((x) => x.id === id && x.body.includes(tag)));

  // --- work-post changes keep an append-only history ---
  const wp = await jacobS.fetch("POST", "/api/rooms/work/messages", { body: `Revision log task ${tag}` });
  const wid = wp.data.message.id;
  await dylanS.fetch("PATCH", `/api/messages/${wid}`, { status: "in_progress" });
  await jacobS.fetch("PATCH", `/api/messages/${wid}`, { assignee: "jacob_bot" });
  await call("jacob_bot", "PATCH", `/api/messages/${wid}`, { status: "done" });
  const h = await call("dylan_bot", "GET", `/api/messages/${wid}/history`);
  const hist = h.data?.history || [];
  check("revisions: every status/assignee change logged in order (3 entries)", h.status === 200 && hist.length === 3
    && hist[0].actor === "dylan" && hist[0].changes.status?.[1] === "in_progress"
    && hist[1].changes.assignee?.[1] === "jacob_bot" && hist[2].actor === "jacob_bot" && hist[2].changes.status?.join(">") === "in_progress>done");

  // --- every doc state kept as a version ---
  const d = await dylanS.fetch("POST", "/api/docs", { title: `Versioned doc ${tag}`, body: "v1 text" });
  const did = d.data.doc.id;
  await dylanS.fetch("PUT", `/api/docs/${did}`, { body: "v2 text" });
  const s = await jacobS.fetch("PUT", `/api/docs/${did}`, { body: "v3 text", note: "tweak" });
  await dylanS.fetch("POST", `/api/suggestions/${s.data.suggestion.id}/accept`);
  const s2 = await call("jacob_bot", "PUT", `/api/docs/${did}`, { body: "rejected text" });
  await dylanS.fetch("POST", `/api/suggestions/${s2.data.suggestion.id}/reject`);
  const v = await call("jacob_bot", "GET", `/api/docs/${did}/versions`);
  const vs = v.data?.versions || [];
  check("doc versions: create, owner edit and accepted suggestion all kept (newest first)", v.status === 200 && vs.length === 3
    && vs.map((x) => x.source).join(",") === "suggestion,edit,create" && vs.map((x) => x.body).join(",") === "v3 text,v2 text,v1 text" && vs[0].author === "jacob");
  const sugg = await dylanS.fetch("GET", `/api/docs/${did}`);
  check("doc versions: rejected suggestion still on record", (sugg.data?.suggestions || []).some((x) => x.status === "rejected" && x.after?.body === "rejected text"));

  // --- recent-50 window, Load older, full transcript ---
  for (let i = 1; i <= 55; i++) await jacobS.fetch("POST", "/api/rooms/talk/messages", { body: `Paging ${tag} #${i}` });
  const recent = await call("dylan_bot", "GET", "/api/rooms/talk/messages");
  check("pagination: room opens with only the last 50 + hasMore", recent.data.messages.length === 50 && recent.data.hasMore === true
    && recent.data.messages.at(-1).body === `Paging ${tag} #55`);
  const older = await call("dylan_bot", "GET", `/api/rooms/talk/messages?limit=50&before=${recent.data.messages[0].id}`);
  check("pagination: Load older (before=) returns earlier items", older.data.messages.length > 0 && older.data.messages.at(-1).id < recent.data.messages[0].id
    && older.data.messages.some((x) => x.body === `Paging ${tag} #5`));
  const t1 = await call("jacob_bot", "GET", "/api/rooms/talk/transcript?pageSize=20&page=1");
  const tl = await call("jacob_bot", "GET", `/api/rooms/talk/transcript?pageSize=20&page=${t1.data.totalPages}`);
  const asc = (a) => a.every((x, i) => !i || a[i - 1].id < x.id);
  check("transcript: paginated, oldest first, totals correct", t1.status === 200 && t1.data.total >= 57 && t1.data.messages.length === 20
    && t1.data.totalPages === Math.ceil(t1.data.total / 20) && asc(t1.data.messages) && tl.data.messages.at(-1).body === `Paging ${tag} #55`);
  const big = await call("jacob_bot", "GET", "/api/rooms/talk/transcript?pageSize=5000");
  check("transcript: page size capped at 200", big.data.pageSize === 200);
  const wt = await call("dylan_bot", "GET", "/api/rooms/work/transcript");
  check("transcript: work posts include their change history", (wt.data.messages.find((x) => x.id === wid)?.history || []).length === 3);
  const ob1 = await call("dylan_bot", "GET", "/api/rooms/owners/transcript");
  const ob2 = await call("jacob_bot", "GET", "/api/rooms/owners/transcript");
  const oh1 = await dylanS.fetch("GET", "/api/rooms/owners/transcript"), oh2 = await jacobS.fetch("GET", "/api/rooms/owners/transcript");
  check("transcript: Owners only → 403 for both bots, 200 for Dylan and Jacob", ob1.status === 403 && ob2.status === 403 && oh1.status === 200 && oh2.status === 200);
  const dt = await dylanS.fetch("GET", "/api/rooms/docs/transcript");
  check("transcript: Documents has none (400, use versions)", dt.status === 400);
  const unauth = await call("Basic eDp5", "GET", "/api/rooms/talk/transcript");
  check("transcript: requires sign-in (401)", unauth.status === 401);
}
