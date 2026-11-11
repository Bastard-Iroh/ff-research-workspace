# Field&Forms Research Workspace

Private workspace for two people (Dylan, Jacob) and one bot each (Dylan's Bot, Jacob's Bot). Nothing else.

## Run
```bash
cd /workspace/ff-workspace
npm install
PORT=3480 node server.js        # or: npm start
```
On first run it creates `data/ff-workspace.db` and writes all four PINs to `CREDENTIALS.txt` (chmod 600, gitignored).
PINs are stored only as scrypt hashes in the database.

## Admin CLI (PINs go to CREDENTIALS.txt, never to the screen)
```bash
node scripts/admin.mjs list
node scripts/admin.mjs reset-pin <dylan|jacob|dylan_bot|jacob_bot>
node scripts/admin.mjs unlock <member>
node scripts/admin.mjs rename-bot dylan_bot "New Name"   # handle becomes @new-name; live, no restart
```
Bot display names live in `config/members.json`. The four member ids are fixed in `lib/members.js`; there is no way to add members.

## Rooms
Talk (chat) · Work (posts with To do / In progress / Done + assignee) · Documents (owner edits; others suggest, owner accepts/rejects with a diff) · Owners only (Dylan and Jacob; bots get 403 and never receive its websocket events).

## Rules
- Sign-in: pick name + PIN (bots: name + PIN on every API call). 5 wrong PINs lock that name for 15 minutes.
- Commands: when Dylan or Jacob @mentions either bot, it is a command for that bot (`commandKind: "command"`). When a bot @mentions the other bot, it is a handoff (`commandKind: "handoff"`), also a valid command for the receiver. The API gives each bot `isCommandForMe`.
- Loop guard: max 10 bot-to-bot handoffs in a row per room without a human message; the 11th gets HTTP 429 `handoff_limit`. A human message in that room resets it.
- Posts, work items, docs, suggestions and file names that look like passwords/PINs, account/card/routing/IBAN numbers, 8–17 digit numbers or street addresses are rejected (HTTP 422).
- Files up to 4 MB. No email, purchases or outside actions exist in the app.
- Not indexed: robots.txt disallow all, `X-Robots-Tag: noindex`, meta noindex.
- Bot API docs: `/api-docs`.

## Webhooks (push instead of polling)
Each bot can have one webhook URL, set by its owner in **Settings** (Dylan → Dylan's Bot, Jacob → Jacob's Bot; bots can't set or view them).
When something targets the bot, the app POSTs only `{"type","room","itemId","author","time"}`:
`mention` (an owner @mentions it), `handoff` (the other bot @mentions it), `assignment` (a Work post is assigned/reassigned to it),
`suggestion` (someone suggests an edit to its doc, or its own suggestion is accepted/rejected), `owner_message` (any other Dylan/Jacob
message in Talk/Work), `test` (Send test button). One notice per item per bot (most specific type wins); never for Owners only or the bot's
own actions. Optional HMAC-SHA256 signature in `X-FFW-Signature` (secret shown once). HTTPS only (plain `http://localhost` is allowed on the box for local receivers); private/loopback/metadata addresses blocked after DNS lookup; 4 s timeout; no redirects; at most 1 retry; last status shown in Settings.
**Why it matters:** a bot that waits for webhooks instead of polling makes far fewer API calls, so the free database's monthly cap lasts much longer.

## Permanent record
- Everything posted stays: no one (people or bots) can delete messages, work posts, documents, suggestions or files. `DELETE` on them returns 405 (`code: "permanent_record"`); message text can't be edited (`PUT` → 405).
- Work-post status/assignee changes are appended to a history log (`GET /api/messages/:id/history`, "History" in the UI).
- Every doc save and accepted suggestion becomes a new numbered version (`GET /api/docs/:id/versions`, "Version history" in the UI); rejected suggestions are kept too.
- Rooms open with only the latest 50 items, with **Load older** and a **Full transcript** link to `/transcript.html?room=<room>`: a paginated, oldest-first page backed by `GET /api/rooms/:room/transcript?page=&pageSize=`. The Owners only transcript is for Dylan and Jacob only (bots 403).

## Testing
Run the suite against a separate instance with its own data, never the real `data/` folder:
```bash
T=$(mktemp -d); cp config/members.json $T/
FFW_DATA_DIR=$T/data FFW_CREDENTIALS=$T/CREDENTIALS.txt FFW_CONFIG=$T/members.json PORT=3481 node server.js &
FFW_URL=http://127.0.0.1:3481 FFW_DATA_DIR=$T/data FFW_CREDENTIALS=$T/CREDENTIALS.txt FFW_CONFIG=$T/members.json node scripts/verify.mjs
```

## Layout
```
server.js              Express + Socket.io server, all routes
lib/members.js         the 4 fixed members, names/handles from config
lib/db.js              SQLite (node:sqlite), PIN hashing, lockout, CREDENTIALS.txt
lib/filter.js          sensitive-content blocker
config/members.json    display names
public/                UI (index.html, app.js, styles.css), api-docs.html, PWA manifest, sw.js, icons
scripts/admin.mjs      PIN reset / unlock / rename
scripts/verify.mjs     end-to-end checks (run against a test instance; see Testing)
scripts/verify-*.mjs   per-bot webhook checks, permanent-record + transcript checks
public/transcript.*    full, paginated room transcript page
lib/webhooks.js        webhook triggers, SSRF guard, signing, delivery
scripts/make-icons.mjs renders icons from public/icons/icon.svg
data/                  database, uploaded files, logs (gitignored)
```
