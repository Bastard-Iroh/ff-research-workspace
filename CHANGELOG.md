# Changelog

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
