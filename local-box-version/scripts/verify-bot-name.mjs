// Bot self-name (PUT /api/me/name) and owner Settings override. Never prints PINs.
// Restores default display names at the end so later UI checks still see "Dylan's Bot" / "Jacob's Bot".
export async function runBotNameTests(ctx) {
  const { call, human, check } = ctx;
  const DEFAULTS = { dylan_bot: "Dylan's Bot", jacob_bot: "Jacob's Bot" };
  const restore = async () => {
    for (const [bot, name] of Object.entries(DEFAULTS)) {
      await call(bot, "PUT", "/api/me/name", { name });
    }
  };

  try {
    const docs = await fetch((process.env.FFW_URL || "http://127.0.0.1:3480") + "/api-docs").then((r) => r.text());
    check("api-docs documents PUT /api/me/name and aliases", /\/api\/me\/name/.test(docs) && /start of each run/.test(docs) && /aliases/.test(docs) && /manual override/.test(docs));

    const asHuman = await human.dylan.fetch("PUT", "/api/me/name", { name: "Nope" });
    check("human PUT /api/me/name → 403", asHuman.status === 403);

    const asBotOwner = await call("dylan_bot", "PUT", "/api/bot/name", { name: "Nope" });
    check("bot PUT /api/bot/name → 403", asBotOwner.status === 403);

    const bad = await call("dylan_bot", "PUT", "/api/me/name", { name: "Bad:Name" });
    check("invalid name (colon) → 400", bad.status === 400);

    const empty = await call("dylan_bot", "PUT", "/api/me/name", { name: "  " });
    check("empty name → 400", empty.status === 400);

    const clash = await call("dylan_bot", "PUT", "/api/me/name", { name: "Jacob's Bot" });
    check("name collision with the other bot → 409", clash.status === 409);

    const humanClash = await call("dylan_bot", "PUT", "/api/me/name", { name: "Jacob" });
    check("name collision with a person → 409", humanClash.status === 409);

    const self = await call("dylan_bot", "PUT", "/api/me/name", { name: "Field Observer" });
    const auditOk = self.data?.audit && self.data.audit.actor === "dylan_bot" && self.data.audit.subject === "dylan_bot" && self.data.audit.source === "self" && !("pin" in (self.data.audit || {}));
    check("bot reports its own name: handle derived, aliases and audit recorded",
      self.status === 200 && self.data.name === "Field Observer" && self.data.handle === "field-observer" && self.data.unchanged === false
      && Array.isArray(self.data.aliases) && self.data.aliases.includes("dylans-bot") && auditOk,
      self.status !== 200 ? `status ${self.status}` : "");

    const same = await call("dylan_bot", "PUT", "/api/me/name", { name: "Field Observer" });
    check("reporting the same name is a no-op", same.status === 200 && same.data.unchanged === true && same.data.name === "Field Observer");

    const who = await call("dylan_bot", "GET", "/api/whoami");
    check("whoami shows the new name, handle, and aliases", who.status === 200 && who.data.name === "Field Observer" && who.data.handle === "field-observer" && (who.data.aliases || []).includes("dylans-bot"));

    const pinAuth = async (name) => call(`Pin ${name}:${ctx.pin("dylan_bot")}`, "GET", "/api/whoami");
    const a1 = await pinAuth("Field Observer");
    const a2 = await pinAuth("field-observer");
    const a3 = await pinAuth("Dylan's Bot");
    const a4 = await pinAuth("dylans-bot");
    const a5 = await pinAuth("dylan_bot");
    check("auth still works with new name, new handle, old name, old handle, and id",
      [a1, a2, a3, a4, a5].every((r) => r.status === 200 && r.data.id === "dylan_bot"));

    const mentioned = await human.dylan.fetch("POST", "/api/rooms/talk/messages", { body: `@field-observer and @dylans-bot check the notes.` });
    const mentions = mentioned.data?.message?.mentions || [];
    check("old and new handles both @mention the same bot",
      mentioned.status === 201 && mentions.includes("dylan_bot") && mentioned.data.message.commands?.includes("dylan_bot"));

    const hijack = await human.dylan.fetch("PUT", "/api/bot/name", { name: "Owner Override", bot: "jacob_bot", id: "jacob_bot" });
    const jacobStill = await call("jacob_bot", "GET", "/api/whoami");
    check("owner override renames only their own bot (body target for the other bot is ignored)",
      hijack.status === 200 && hijack.data.name === "Owner Override" && hijack.data.handle === "owner-override" && hijack.data.audit?.source === "owner" && hijack.data.audit?.actor === "dylan"
      && jacobStill.status === 200 && jacobStill.data.name === "Jacob's Bot");

    const other = await call("jacob_bot", "PUT", "/api/me/name", { name: "Owner Override" });
    check("the other bot cannot take a name (or alias) already used", other.status === 409);

    const members = await call("dylan_bot", "GET", "/api/members");
    const d = members.data.members.find((m) => m.id === "dylan_bot");
    check("member list exposes the current name and aliases, not a way to rename someone else",
      members.status === 200 && d?.name === "Owner Override" && (d.aliases || []).includes("field-observer") && (d.aliases || []).includes("dylans-bot"));
  } finally {
    await restore();
    const back = await call("dylan_bot", "GET", "/api/whoami");
    const jb = await call("jacob_bot", "GET", "/api/whoami");
    check("default bot names restored after name tests", back.data?.name === "Dylan's Bot" && jb.data?.name === "Jacob's Bot");
  }
}
