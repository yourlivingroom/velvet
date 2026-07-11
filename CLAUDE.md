# velvet

A self-hosted event-management server with a **React SPA** front-end (profiles,
RSVPs, invites, per-event admin) over the same URLs as the API. Admin auth *and*
non-admin accounts (via invite tokens) both work; `events`, `invites`,
`accounts`, and `reservations` are real, `sessions` still a stand-in. Not yet
wired to a real claude.ai connection.

## The one idea

Every action is defined **once** in `logic.mjs` as a self-describing descriptor,
and mechanically projected onto four interfaces. Never hand-write an interface —
add to the registry and all four update.

```
logic.mjs   THE registry. action = { summary, description?, requires?,
            payload?, http:{method, path, mediaType?}, input:<JSON Schema>, handler }
bind.mjs    pure projections: schema -> sbopts flags, path/payload split, -> MCP
            tool; cliSummary() folds CLI-only hints into help text
cli.mjs     sbopts command tree; path params + payload -> positionals (or --flags)
rest.mjs    Fastify routes        (input schema -> params/body/querystring + validation)
mcp.mjs     stateless Streamable-HTTP MCP endpoint (tools/list + tools/call == registry)
auth.mjs    Resource Server (JWT validation) + bootstrap issuer + invite redeem
            + GET /admin login helper page
permissions.mjs  pure path-glob matcher: can(grants, path)
errors.mjs  ClientError(msg, statusCode) — the caller-error seam adapters map
spa.mjs     serve the built React client, content-negotiated onto the API URLs
dev.mjs     `velvet --dev` supervisor: watched backend + Vite HMR
server.mjs  REST + OpenAPI(/docs) + MCP + auth + SPA in one Fastify process
index.mjs   args -> CLI; `--dev` -> dev supervisor; else -> server
client/     Vite + React SPA (src/App.jsx); built to client/dist (gitignored)
```

**JSON Schema is the shared pivot** — it's the one dialect MCP, OpenAPI, Fastify,
and (flattened) sbopts all speak.

## Adding an action

Add one entry to the `actions` object in `logic.mjs`. `input` is a JSON Schema
object; each property plays one of **three roles**, and every interface renders
each role in its own idiom:

- **path params** — the `:name` segments of `http.path`. REST: URL segment.
  CLI: leading positional (also `--name`). MCP: named arg.
- **payload** — name one property in `payload:` to make it the action's single
  top-level value. REST: the *bare* request body (media type from
  `http.mediaType`, e.g. `application/json-patch+json`). CLI: trailing positional
  (also `--name`). MCP: named arg.
- **record fields** — everything else. REST: JSON body object (writes) /
  querystring (GET). CLI: `--flag`. MCP: named arg.

Keep record fields **flat scalars** (the sbopts ceiling). Nested inputs (object
/ array) still work: on the CLI they arrive as JSON strings (parsed by
`coerceCliInput`, auto-hinted in help by `cliSummary`); on REST/MCP they're
native JSON.

Other keys:
- `requires: '<permission path>'` — loud-gate the action behind a permission,
  e.g. `'/server/admin'` for operational actions (see Auth).
- `handler(input, ctx)` returns a value (serialized to all interfaces). `ctx =
  { isAdmin, auth, grants, can(path), assertPermission(path) }` (see Permissions).
  `null` means "not found" → REST 404 — also the *quiet* way to hide a resource
  from the unpermitted (return null when `!ctx.can(...)`). Throw
  `ClientError(msg, status)` for caller errors → REST maps the status, MCP an
  `isError` result, CLI stderr + exit 1.

CLI positionals (path params, then payload) fill left-to-right; giving the same
one both positionally *and* by flag is an error. No other file needs editing.

## Domain (so far)

- `events` — stored doc separates **our** metadata (top-level `id` = `evt_…`,
  `createdAt`) from the **user's** `config` (arbitrary JSON). Only `config` is
  user-editable, via JSON Patch (RFC 6902) at `PATCH /events/:eventId/config`
  (`events.patch`, whose `payload` is the ops array). Config edits and
  `events.delete` are gated **in-handler** on `/events/:id/admin` (event-scoped,
  so not a static `requires` — `ctx.assertPermission`), which `**` satisfies for
  every event. So "event admin" is a real role, not just a richer read. `GET /events/:eventId` is
  **graded**: admins (`/events/:id/admin`) get the full doc; participants
  (`/view` *or* `/join`) get a whitelisted user view (`id`, `config`,
  `guestList`); anyone else → 404 (hide). Both views also carry an **`access`**
  block (`{ admin, join }`) so a client offers only the actions the viewer may
  take (e.g. the SPA's RSVP strip appears iff `access.join`). `GET /events` (`events.list`) is
  **"my events"** — no admin gate; it returns only the events you participate in
  (via `/view`/`/join`/`/admin`), each graded the same way (admins get all).
  `eventAccess()` + `projectEvent()` are shared by both so an event appears in
  your list exactly when you could open it, and looks identical either way. Both
  synthesize a **`guestList`** from reservations (one scan grouped by event) —
  entries `{ id, name?, response?, guests }` (Facebook-style: participants see
  who's coming). (`PATCH /events/:eventId/config` remains for editing config;
  there's no GET on that path — read config via the graded `GET /events/:id`.)
- `reservations` — an account's RSVP to an event, one per (event, account),
  keyed `<eventId>~<accountId>`. `PUT/GET/DELETE /events/:eventId/reservation`
  gated (in-handler) on `/events/:id/join`; `accountId` defaults to the caller,
  another account requires admin over that event (`/server/admin` *or*
  `/events/:id/admin`). Fields: `response` (going/maybe/not-going),
  `guests` (array of possibly-empty names).
- `invites` — an invite **is a token**. `invites.create` mints one, authorized
  by *what it confers*: a global admin may confer any `grants`; anyone else may
  only mint an invite whose every grant falls under an event they administer
  (`/events/:id/admin`) — so an event admin can invite people to their own event
  (the SPA's "Admin actions" → Create invite), but no bare or global-scoped
  invite, and no escalation. Its
  `id` (`nvt_…`) is a non-secret handle, its `token` field is the secret you put
  in a link, its `grants` are the permissions redemption confers, an optional
  `entrypoint` (same-origin relative path) is echoed back at redeem as where to
  start, and an optional `name` seeds the redeemer's account. `token`/`id` are
  separate so future expiry/single-use lives on the token without touching
  account identity. **The token is shown once, in the create response** —
  `invites.get`/`list` are admin-only and omit it (redemption finds it via the
  byToken index, not a read). Redeeming binds an **account**.
- `accounts` — non-admin identities, auto-created (and bound to the invite) on
  first redemption, carrying the invite's `grants` and `name`; a JWT's `sub` is
  an account id. `accounts.update` (`PATCH /accounts/:accountId`) is
  **owner-or-admin** (`ownAccountOrAdmin` helper) and sets only `name` (never
  grants — no self-escalation). `accounts.get` is **graded**: owner/admin get
  the full doc, any other signed-in caller a whitelisted public view
  (`{ id, name }` — names already show in guest lists, but grants/bindings never
  leak), anonymous callers 404. The guest list's `name` is sourced from the
  account, so editing your name updates it everywhere; guest names link to
  `/accounts/:id` (read-only unless it's you), and `?event=` renders that page
  relative to the event (RSVP line + an event-admin grant control).
  `accounts.grant`/`revoke` (`POST`/`DELETE /accounts/:accountId/grants`,
  field `grant`) add/remove one permission glob on an account, under a
  **confer-only-what-you-hold** rule (`ctx.assertPermission(grant)`): a `**`
  holder grants anything, an event admin only that event's `/admin`. Idempotent,
  and effective on the target's next request (grants resolve per-request, never
  frozen into a JWT). Kept off `accounts.update` to preserve its no-escalation
  invariant. `sessions` — still a
  placeholder stand-in.

## Auth model

Two halves (MCP spec: RFC 9728 / 8414 / 7591):

- **Resource Server** — `/mcp` validates a Bearer JWT (signature + `iss` + `aud`),
  nothing more. This half is meant to stay; later it can trust external IdPs.
- **Bootstrap issuer** — the *sole* way to get a first admin credential on a fresh
  `npx velvet`, before any external issuer exists. **Root of trust = whoever can
  read the server's terminal.**

One bootstrap primitive, two front-ends:
- `mintCode` → 8-hex single-use code (3-min TTL), printed to the terminal banner
  + a `0600 data/.bootstrap-code` file. **Never** returned over HTTP.
- `redeemCode` → present any live code → admin JWT. Stored in a pulp-db
  collection keyed by the code itself (redeem = O(1) get-and-delete).
- **REST**: `POST /bootstrap/challenge` (prints code) → `POST /bootstrap/redeem
  {code}` → tokens.
- **MCP**: `GET /oauth/authorize` mints+prints on the page render → `POST` redeems
  → PKCE-bound auth code → `POST /oauth/token` → tokens. (This is what claude.ai
  drives.)

Tokens: persisted HS256 key at `data/keys/hs256.key` (0600), reloaded on boot —
**this is the only durable secret; it's what keeps connections alive across
restarts.** Access (`aud=/mcp`) and refresh (`aud=/oauth/refresh`) are both JWTs
(stateless, no server-side store). Rotating the bootstrap *code* never breaks a
live connection — only the JWT, signed once on redeem, is checked thereafter.

Non-admin auth: `POST /invites/redeem {token}` trades an invite token for a
**non-admin** JWT (`roles: []`), creating/binding the account on first redeem
(`sub` = account id). Same signing key. REST-only (CLI/MCP are admin
interfaces). Refresh preserves roles — no elevation.

### Browser sessions (BFF)

The SPA never handles a JWT. A **backend-for-frontend** surface lives in
`auth.mjs` — the server *is* its own BFF, since it already serves the SPA and API
same-origin. Two distinct auth surfaces:
- **API auth (Bearer)** — `/bootstrap/redeem`, `/invites/redeem`, `/oauth/token`
  return the JWT in the body. For CLI, CI, scripts, native, MCP. **The browser
  never calls these**, so the token can't land in a JS-reachable response.
- **BFF auth (cookie)** — `/session/*`, the browser's *only* auth door. Same core
  (`redeemCode`/`redeemInvite` → `issueTokens`), but the access token leaves as
  an **HttpOnly `velvet_session` cookie** (`SameSite=Lax`, `Path=/`, `Secure`
  under https, `Max-Age`=access TTL) instead of a body:
  - `POST /session/bootstrap {code}` → admin cookie (the `/admin` page).
  - `POST /session/invite {token}` → non-admin cookie; returns only `{entrypoint}`.
  - `GET /session` → `{ accountId, isAdmin }` (or 401) — the SPA's replacement for
    decoding the JWT client-side.
  - `POST /session/refresh` → mints a fresh access cookie from the refresh cookie.
  - `DELETE /session` → clears the cookies (logout).

`authenticate(request, { cookie })` reads Bearer always, and the cookie **only
when `cookie:true`** — `rest.mjs` opts in (the SPA's data surface), but **`/mcp`
stays Bearer-only** (a cookie there would be a CSRF vector, and MCP clients aren't
browsers).

**CSRF: HMAC double-submit.** Beyond `SameSite=Lax`, cookie-authenticated *writes*
must carry `X-CSRF-Token`. The token is `HMAC(sub)` under a subkey derived from
the signing key (domain-separated), delivered to JS in a readable (non-HttpOnly)
`velvet_csrf` cookie set at login and refreshed on every `GET /session`. `api()`
echoes it into the header on non-GET; `csrfGuard` (an `onRequest` step `rest.mjs`
chains *after* `attachAuth`) verifies `header == HMAC(request.auth.sub)`. It
**skips** safe methods, Bearer callers (CLI/tools — no ambient cookie), and
requests with no session cookie — so only browser cookie-writes are gated. A
cross-site forgery carries the session cookie automatically but can't read the
token nor set the header (CORS preflight), so it 403s. The `/session/*` routes
themselves are raw (not through `csrfGuard`); logout is `DELETE` (preflighted,
so naturally CSRF-safe).

**Refresh (server-side, invisible).** Login also sets a long-lived (`30d`),
HttpOnly **`velvet_refresh`** cookie **path-scoped to `/session/refresh`** (so it
rides only refresh requests, not every API call). `POST /session/refresh` trades
it for a fresh access cookie (and re-issues the refresh cookie — sliding window),
preserving `roles`. It needs no CSRF token: the cookie is `SameSite=Lax` +
path-scoped, and a forced refresh only renews the victim's *own* session. Client
side, `api()` transparently retries: on a `401` it fires one shared
`/session/refresh` (single-flight) and replays the request — so an active session
outlives the 1h access token without re-login. An invalid/absent refresh 401s and
clears the cookies, and the caller falls through to the logged-out page. (The
separate `/oauth/token` refresh grant still serves MCP Bearer clients.)

### Permissions

A **permission** is a slash path (`/events/evt_123/view`). A **grant** is a glob
over paths — literal segment, `*` (one segment), `**` (any number; a lone `**` =
super-admin). `permissions.mjs` is the pure matcher (`can(grants, path)`).

A caller's grants are resolved **per request** in `logic.makeContext(auth)`
(hence revocable — not baked into the JWT): admin JWTs and the CLI → `['**']`; a
redeemed account → its stored `grants`; anyone else → `[]`. The resulting `ctx`
carries `can(path)` (boolean) and `assertPermission(path)` (throws
`ClientError(403)`). All three adapters build ctx through `makeContext`; REST
best-effort-authenticates *every* route so ctx is populated even on ungated ones.

Two enforcement styles:
- **Loud** — an action's `requires: '<perm>'` becomes a route guard (REST 401
  anon / 403 unpermitted; MCP hides the tool from `tools/list` + `Forbidden` on
  call), and `ctx.assertPermission(...)` → 403. Operational actions use
  `requires: '/server/admin'`.
- **Quiet** — handler returns `null` (→ 404) when `!ctx.can(...)`, to hide a
  resource the public might probe by id rather than challenge. Event reads do
  this (`/events/:id/view` for config, `/events/:id/admin` for the full doc).

**CLI is filesystem-trust = implicitly admin** (`makeContext` with a synthetic
admin auth → `**`). "Admin" isn't a magic boolean — it's just holding `**`
(bootstrap JWTs and the CLI resolve to it; redeemed invites don't). So `requires`
is an ordinary permission — you could grant `/server/admin` without `**`, or make
a gate event-scoped, with no new machinery. **Per-identity event admins now
exist**: `accounts.grant` confers `/events/:id/admin` to an account, and the
event write actions enforce it in-handler (see Domain). Granting is itself
permission-checked (confer only what you hold), so an event admin can delegate
their event but not mint global admins. External trusted issuers remain deferred.

**Gotcha:** never let an immer draft (or a sub-object of one) escape an `edit()`
updater — immer revokes it on return, and touching it later throws "proxy that
has been revoked". Snapshot a plain copy inside the updater (`[...draft.arr]`).

## Run

```sh
velvet                       # or `velvet serve` — start server on :3000
velvet --dev                 # dev: watched backend + Vite HMR (app at :5173)
velvet invites create --email a@b.com   # CLI (no auth needed locally)
npm run build:client         # build the SPA into client/dist
npm start                    # = node index.mjs serve
```

Env: `VELVET_PUBLIC_URL` (default `http://localhost:3000`; must match what a
client hits — baked into discovery/issuer/aud), `VELVET_JWT_SECRET` (overrides
the persisted key, not persisted), `VELVET_DATA` (default `data`), `VELVET_PORT`
(default `3000`), `VELVET_AUTH=off` (dev: no guards, everyone admin). OpenAPI +
docs UI at `/docs`.

## Frontend (SPA)

`client/` is a Vite + React SPA, built to `client/dist` (gitignored; `npm run
build:client`). `spa.mjs` serves it **content-negotiated on the same URLs as the
API** (a 5th door): a browser navigation (`Accept: text/html`) to a non-server
path gets the app shell — so RESTful URLs double as client routes — while a
fetch (`Accept: application/json`, or `*/*`) falls through to the JSON handler.
Plain `fetch` already gets JSON (default `Accept: */*`); only navigations get the
shell. Infra paths (`/mcp`, `/oauth`, `/bootstrap`, `/.well-known`, `/docs`,
`/admin`, `/assets`) are excluded (`NON_SPA`). No client build → API-only.
Because these URLs are negotiated on `Accept`, **every response carries
`Vary: Accept`** (a global `onSend` hook in `server.mjs`) — else a browser's HTTP
cache replays a `fetch`'s cached JSON for a later navigation to the same URL (or
vice-versa), which surfaced as a back-navigation rendering raw event JSON.

`GET /admin` (in `auth.mjs`) is a standalone helper page (not an API door) that
drives the bootstrap flow — request a code (printed to the terminal), then redeem
it via the BFF `POST /session/bootstrap`, which sets the HttpOnly session cookie.
No token touches page JS. The startup banner points the operator there.

**Client routes & behaviors** (`src/App.jsx`, one tiny path router — RESTful URLs
double as client routes via the negotiation above):
- `/` or `/events` → your events list; `/events/:eventId` → event detail: the
  graded view, a config-edit pencil **and** an "Admin actions" accordion (Create
  invite) both gated on `access.admin` (so event admins see them), an RSVP strip
  gated on `access.join`, and a guest list whose names link to profiles.
- `/accounts/:accountId` → profile page: editable only for your own account
  (peers get a read-only `{ id, name }` view); `?event=<eventId>` renders it
  relative to that event — the account's RSVP status line plus, for an admin of
  that event, a grant/revoke control (event admin, and full `**` for global
  admins).
- `/invites/?t=<token>` → the redeem landing: POSTs the token to the BFF
  `/session/invite` (sets the cookie server-side, returns only `{entrypoint}`) and
  forwards there via `location.replace` (keeping the token out of history).
- A 👤 profile menu (Edit profile / Log out, the latter warning you'll need to be
  re-invited and calling `DELETE /session`) sits top-right on signed-in pages.
- **No JWT ever lives in JS.** `api()` just fetches same-origin — the browser
  attaches the HttpOnly session cookie automatically; on writes it also echoes the
  readable `velvet_csrf` cookie into `X-CSRF-Token` (see CSRF above). Identity
  comes from `GET /session`
  (not a client-side token decode): `<App>` resolves it once into a
  `SessionContext` (`useSession()`); `undefined`=loading, `null`=logged out →
  **"You are not logged in"** page, object=`{ accountId, isAdmin }`. Access-token
  expiry is handled by `api()`'s transparent refresh (see Refresh above); only a
  dead refresh token lands you on the logged-out page (re-log at `/admin`).

`velvet --dev` (`dev.mjs`) runs both halves hot-reloading: the backend (env
`VELVET_DEV=1` → it skips serving assets) plus the Vite dev server (React HMR)
which proxies API/infra to the backend (`client/vite.config.js`, mirroring the
same-URL negotiation). Dev mirrors prod — same relative URLs — so nothing in the
client changes between the two. The backend runs in the **invocation cwd** (so
`data/` resolves like the plain server).

**Backend reload is home-grown, not `node --watch`.** `node --watch` watches
file *inodes*, which go stale after an atomic save (temp-file + rename swaps the
inode), so it reloads once then silently stops — leaving a stale backend on
:3000. Instead `dev.mjs` watches the velvet source *directory* (all backend
`.mjs` live at the package root, so a non-recursive watch suffices and never
touches `node_modules`) and restarts the child itself: SIGTERM → **await exit**
→ respawn. The `file:../` sibling deps aren't watched — hard-restart when they
change. The non-overlap is deliberate — the
outgoing process must free the port and cardcatalog's exclusive LevelDB lock
before the next boots, or the reload wedges. Debounced (~120ms) to coalesce the
multiple raw events an atomic save emits; a 4s SIGKILL safety net covers a stuck
process.

## Gotchas

- **The operator keeps a `velvet --dev` running on :3000 (API) and :5173 (Vite)
  for live testing — never disturb it.** Don't bind those ports and don't
  `fuser -k`/`pkill` them. For your own verification, start a throwaway server on
  a *different* port with an *isolated* data dir
  (`VELVET_PORT=4173 VELVET_DATA=/tmp/velvet-test node index.mjs serve`) and kill
  it by the captured `$!` only. Editing a `.mjs` will hot-reload their `--dev`
  backend (that's fine/intended); the client hot-reloads via Vite.
- **Killing a *test* server: don't `pkill -f "index.mjs serve"`** — the pattern
  matches your own shell. Capture `$!` at launch and `kill` that. A node server's
  `comm` shows as `MainThread`, so `comm`-based filters miss it.
- **`data/` is gitignored** — holds the signing key and live bootstrap credential.
  Never commit it.
- **`package.json` uses `file:../` deps** (`pulp-db`, `cardcatalog`, `sbopts`) —
  resolves inside `silly/`, not in a standalone clone.
- **claude.ai needs a public HTTPS URL** for MCP — can't dial `http://localhost`.
  Local CLI/REST is genuinely turnkey; remote MCP needs a tunnel.

## Dogfooding pulp-db + cardcatalog

Exercises `@livingroom/pulp-db` and `@livingroom/cardcatalog`, which are used
only by velvet and shaped alongside it. They're **intentionally left uncommitted
for now** (they have no git repo) — we edit them in place to bring their feature
set into focus, and will version them once it settles. No need to flag this.

**Index materialization is a choice.** An index is a *definition* (a
`process`/`emit` fn) plus a *materialization*:
- **live** (default) — cardcatalog keeps it in a chokidar-watched LevelDB: fast,
  but holds an exclusive lock and is eventually consistent (watcher lag).
- **inline** (`pulpDb(idx, { inline: true })`) — no persistent structure; each
  query scans the collection and runs `process` in memory. No LevelDB, no
  watcher, no lock.

Same query API either way (`store.indexes.<name>.get(key)`). velvet runs the
**server live** and the **CLI inline**, so a one-shot CLI shares a `data/` dir
with a live server without fighting for the lock. `invites` carries a `byToken`
index; redemption uses it.

**Strong-consistency escape hatch:** `store.edit(path, updater, { awaitIndex:
true })` blocks until the live index reflects the write (the writer drives
cardcatalog's `reindex(path)` directly — no waiting on the watcher). No-op when
inline or unchanged. `invites.create` uses it, so a fresh invite is redeemable
the instant create returns (removes the create-then-redeem race — no test poll).
Without it, the live index is eventually consistent (watcher lag ~sub-second),
which is fine where a human-in-the-loop delay precedes the read.

Fixes made along the way:
- pulp-db `get()` was broken (`fs.promises.read` → `readFile`); added `list()`
  (direct `readdir`) and the `inline` mode above.
- cardcatalog: `mkdirSync(dataPath)` before watching (it silently indexed
  *nothing* on a fresh dir — every lookup was null); a `shouldIndex(path, stats)`
  predicate so the caller filters files (pulp-db passes `p => p.endsWith('.json')`
  to skip write-file-atomic's temp files — indexing those double-registers a key
  → `get()` throws "Multiple matches"); debug logs gated behind `CARDCATALOG_DEBUG`;
  a `reindex(path)` method backing pulp-db's `awaitIndex`.
- No native TTL; bootstrap codes use an `expiresAt` field + lazy sweep.
```
