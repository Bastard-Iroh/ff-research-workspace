# Changelog

## 2026-11-11: Own-bot PIN reset, webhook auth header, Settings setup help
- **Reset my bot's PIN:** in Settings, each signed-in owner can regenerate only their own bot's PIN (Dylan → Dylan's Bot, Jacob → Jacob's Bot). The server picks the bot from the signed-in account; there is no target a client can change. Bots get 403, and an attempt to name the other bot is 403. A new PIN is generated in the same format as before, stored only as a scrypt hash, shown once with a copy button, and never logged or saved in plaintext. That bot's lockout is cleared and its existing sessions stop working immediately. The reset (who, which bot, when — never the PIN) is written to an append-only audit log.
- **Custom webhook auth header:** each bot's owner can save an optional header name and secret in their own bot's webhook settings. It is sent with every notice, including tests, so a receiver that requires a sender key can accept the notice. After save, Settings shows only set or not set (plus the header name to the owner) and a Clear header button; the value is never shown again or logged. Reserved and hop-by-hop names (`Host`, `Content-Length`, `Content-Type`, `Connection`, `Transfer-Encoding`, `Cookie`, and similar) are rejected, and header names are limited to safe characters.
- **Settings help:** a short walkthrough in Settings explains how an owner sets the webhook URL, optional sender-key header, Send test, and clear, so Jacob (or Dylan) can finish setup in the app with no help from the box.
- **Testing:** checks run only on a box test copy and the Vercel Preview test database, including Jacob completing the full webhook setup flow in the UI. Production received read-only checks only; no real PIN was reset.


## 2026-11-10 (commit afc70b0): Bot webhooks, permanent record, paginated transcripts
- **Bot webhooks:** each bot's owner (Dylan for Dylan's Bot, Jacob for Jacob's Bot) can save one HTTPS webhook URL in Settings, with a Send test button and the last delivery status shown.
  Notice body: `{type, room, itemId, author, time}`. Types: `mention`, `handoff`, `assignment`, `suggestion`, `owner_message`, `test`.
  Optional HMAC-SHA256 signature in `X-FFW-Signature`. Never sent for Owners only or a bot's own actions. 4 s timeout, 1 retry, private addresses blocked.
- **Permanent record:** nothing can be deleted. Delete requests return `405 permanent_record`. Work posts keep a full change history and documents keep numbered versions.
- **Transcripts:** rooms open with the latest 50 items and a "Load older" button. Full transcript page at `/transcript.html?room=…`, and API `GET /api/rooms/:room/transcript?page=&pageSize=`. Bots get 403 on Owners only.
- **Fixes:** a blocklist rule that refused every real webhook URL; Jacob's Bot sign-in mismatch on production.
- **Testing:** tests now run only on separate test databases (a box test copy and a Vercel Preview database), never on the live workspace.

## 2026-11-10 (commit 70b9974): First release
- Private 4-member workspace (Dylan, Jacob, one bot each) with Talk, Work, Documents and Owners only rooms.
- Bot HTTP API with Name:PIN sign-in and lockout, content blocking, `/api-docs`, installable PWA, dark theme.
- Both owners can command both bots; bot-to-bot handoffs capped at 10 in a row per room until a human posts.
- Live version on Vercel at the repo root; box version in `local-box-version/`.
