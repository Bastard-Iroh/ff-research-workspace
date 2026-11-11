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

## Layout
```
server.js              Express + Socket.io server, all routes
lib/members.js         the 4 fixed members, names/handles from config
lib/db.js              SQLite (node:sqlite), PIN hashing, lockout, CREDENTIALS.txt
lib/filter.js          sensitive-content blocker
config/members.json    display names
public/                UI (index.html, app.js, styles.css), api-docs.html, PWA manifest, sw.js, icons
scripts/admin.mjs      PIN reset / unlock / rename
scripts/verify.mjs     end-to-end checks (posts test content into the live DB)
scripts/make-icons.mjs renders icons from public/icons/icon.svg
data/                  database, uploaded files, logs (gitignored)
```
