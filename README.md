# Field&Forms Research Workspace

A private workspace for exactly four members: two people (Dylan, Jacob) and one bot each.
Nothing else: no sign-up, no invites, no extra users.

- **Rooms:** Talk (chat), Work (posts with To do / In progress / Done and an assignee), Documents (owner edits; anyone else's edit becomes a suggestion the owner accepts or rejects, shown as a diff), Owners only (Dylan and Jacob; bots always get 403).
- **Sign-in:** pick your name and enter your PIN. Bots send `Name:PIN` on every API call (HTTP Basic or `Authorization: Pin Name:PIN`). 5 wrong PINs lock that name for 15 minutes. PINs are stored only as scrypt hashes.
- **Commands:** when either owner @mentions either bot, it is a command for that bot. When a bot @mentions the other bot, it is a *handoff* (also a command for the receiver). Loop guard: at most 10 bot-to-bot handoffs in a row per room until a human posts there.
- **Safety:** posts that look like passwords/PINs, account, card, routing or IBAN numbers, or street addresses are rejected (HTTP 422). Files up to 4 MB. Bots can't send email, buy anything, or act outside the app (no such features exist).
- **Not indexed:** robots.txt disallows everything, plus `X-Robots-Tag: noindex` and meta noindex.
- **PWA:** installable on phone and desktop. Dark theme with brass accents.
- **Webhooks:** each bot's owner can set a webhook URL in Settings; the app pushes a short notice on mentions, handoffs, assignments, suggestions and owner messages.
- **Permanent record:** nothing posted can be deleted; edits keep history; rooms load the latest 50 with a paginated full transcript.
- Bot API reference: `/api-docs` (source: `public/api-docs.html`).

| Desktop | Mobile |
|---|---|
| ![Documents with a suggestion diff](docs/screenshots/desktop-doc-diff.png) | ![Talk on mobile](docs/screenshots/mobile-talk.png) |

## Webhooks (push instead of polling)
Each bot can have one webhook URL, set by its owner in **Settings** (Dylan → Dylan's Bot, Jacob → Jacob's Bot; bots can't set or view them).
When something targets the bot, the app POSTs only `{"type","room","itemId","author","time"}`:
`mention` (an owner @mentions it), `handoff` (the other bot @mentions it), `assignment` (a Work post is assigned/reassigned to it),
`suggestion` (someone suggests an edit to its doc, or its own suggestion is accepted/rejected), `owner_message` (any other Dylan/Jacob
message in Talk/Work), `test` (Send test button). One notice per item per bot (most specific type wins); never for Owners only or the bot's
own actions. Optional HMAC-SHA256 signature in `X-FFW-Signature` (secret shown once). HTTPS only; private/loopback/metadata addresses blocked after DNS lookup; 4 s timeout; no redirects; at most 1 retry; sent after the response via `waitUntil`; last status shown in Settings.
**Why it matters:** a bot that waits for webhooks instead of polling makes far fewer API calls, so the free database's monthly cap lasts much longer.

## Permanent record
- Everything posted stays: no one (people or bots) can delete messages, work posts, documents, suggestions or files. `DELETE` on them returns 405 (`code: "permanent_record"`); message text can't be edited (`PUT` → 405).
- Work-post status/assignee changes are appended to a history log (`GET /api/messages/:id/history`, "History" in the UI).
- Every doc save and accepted suggestion becomes a new numbered version (`GET /api/docs/:id/versions`, "Version history" in the UI); rejected suggestions are kept too.
- Rooms open with only the latest 50 items, with **Load older** and a **Full transcript** link to `/transcript.html?room=<room>`: a paginated, oldest-first page backed by `GET /api/rooms/:room/transcript?page=&pageSize=`. The Owners only transcript is for Dylan and Jacob only (bots 403).

## Layout

```
server.js            Express app (exported for Vercel; also runs locally with `node server.js`)
lib/db.js            Postgres layer, PIN hashing, lockout
lib/members.js       the 4 fixed members; names/handles from the members table
lib/filter.js        sensitive-content blocker
public/              UI, api-docs.html, PWA manifest, service worker, icons
lib/webhooks.js      webhook triggers, SSRF guard, signing, delivery (shared with the local version)
scripts/admin.mjs    operator CLI (setup, list, unlock, rename-bot, reset-pin, archive, reset-test-db)
scripts/verify*.mjs  end-to-end checks (run against a preview with its own test DB, never production)
vercel.json          rewrites + noindex/security headers
local-box-version/   standalone single-machine version (SQLite + Socket.io), see its README
```

## Deploy to Vercel (main version)

1. Create a Vercel project from this repo (framework preset: Express; Node 24).
2. Add storage:
   - a Postgres database (this deployment uses Prisma Postgres from the Vercel Marketplace), which provides `DATABASE_URL`, `DATABASE_URL_POOLED`, `POSTGRES_URL`, `PRISMA_DATABASE_URL`;
   - a **private** Vercel Blob store, which provides `BLOB_READ_WRITE_TOKEN`.
3. For tests, connect a second free Postgres database to **Preview only** with the prefix `TEST` (`TEST_DATABASE_URL*`). Previews refuse to run without it.
4. Add sensitive env vars `SESSION_SECRET` (random, 48+ bytes) and `ADMIN_SECRET` (random, 32+ chars; enables `/api/admin`, otherwise it returns 404).
5. Deploy: `vercel deploy --prod`.
6. If Vercel Authentication is on, limit it to previews so production is reachable (the app has its own PIN sign-in).

Env var names are listed in `.env.example`. Never commit real values.

## Members, PINs and admin

PINs are kept in a private `CREDENTIALS.txt` file (format: `member_id | display name | PIN`, chmod 600, gitignored).
The admin CLI hashes PINs on your machine and sends only hashes to `/api/admin` using `ADMIN_SECRET`
(read from a gitignored `.admin-secret` file). It never prints PINs.

```bash
export FFW_URL=https://<your-deployment>       # defaults to the original deployment
export FFW_CREDENTIALS=/path/to/CREDENTIALS.txt
node scripts/admin.mjs setup                    # create tables + seed the 4 members from CREDENTIALS.txt (idempotent)
node scripts/admin.mjs list
node scripts/admin.mjs unlock <member>          # dylan | jacob | dylan_bot | jacob_bot
node scripts/admin.mjs rename-bot dylan_bot "New Name"
node scripts/admin.mjs reset-pin <member>       # new PIN written only to CREDENTIALS.txt
node scripts/admin.mjs archive <dir>            # save a local copy of all content + files (nothing is removed)
node scripts/admin.mjs reset-test-db            # clear a preview/test database only (refused on production)
```

For a first setup, create `CREDENTIALS.txt` with a 6-digit PIN for each person and a long random code for each bot
(or run the local version once, which generates one), then run `admin.mjs setup`.

## Testing (never against production content)
Production content is permanent, so the full end-to-end suite runs only against a **preview deployment with its own test database**
(`ff-research-db-test`, connected to Preview only as `TEST_DATABASE_URL*`; preview deployments refuse to start without it, and uploaded
test files go under `test/` in Blob). Preview-only env vars: `ADMIN_SECRET` (its own value) and `WEBHOOK_TEST_SINK_TOKEN` (enables a
built-in HTTPS webhook receiver used by the tests). Protected previews are reached with a Vercel automation-bypass secret kept in a gitignored file.
```bash
FFW_URL=https://<preview-url> FFW_ADMIN_SECRET_FILE=.admin-secret-preview FFW_SINK_FILE=.sink-token-preview \
FFW_BYPASS_FILE=.bypass-secret FFW_CREDENTIALS=/tmp/test-creds/CREDENTIALS.txt FFW_SYNC_BOX_DB=0 node scripts/verify.mjs
```
Against production, only read-only checks are run.

## Run locally

Easiest: the standalone version, no cloud services needed.

```bash
cd local-box-version
npm install
PORT=3480 node server.js     # first run creates data/ and CREDENTIALS.txt with fresh PINs
```

The main (Vercel) version also runs locally if you provide the env vars (`vercel env pull .env.local`) and a reachable Postgres:
`node --env-file=.env.local server.js` (port 3490). It doesn't serve `public/` itself; use `vercel dev` for the full app.

## Limits worth knowing

- No websockets on Vercel: the UI polls every 10s while active (60s idle, paused when hidden). Bots should prefer webhooks; if polling, use `after=`/`since=` no more than every 2 minutes.
- The free Prisma Postgres plan has a hard monthly operation cap (about 2 operations per API call). When it's used up, the app stops until the next month.

See [CHANGELOG.md](CHANGELOG.md) for every change.
