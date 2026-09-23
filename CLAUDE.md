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
blobs.mjs   REST-native binary store: permissioned buckets + resumable
            upload/download protocol, referenced from JSON via `{ $blob }`
errors.mjs  ClientError(msg, statusCode) — the caller-error seam adapters map
spa.mjs     serve the built React client, content-negotiated onto the API URLs
dev.mjs     `velvet --dev` supervisor: watched backend + Vite HMR
server.mjs  REST + OpenAPI(/docs) + MCP + auth + SPA in one Fastify process
index.mjs   args -> CLI; `--dev` -> dev supervisor; else -> server
client/     Vite + React SPA (src/App.jsx + src/styles.css base theme); built
            to client/dist (gitignored). Operator reskins via data/theme.css
            (served at /theme.css). See Frontend → Theming.
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
  `createdAt`) from the **user's** `config` (arbitrary JSON). Alongside metadata
  sit **operative** top-level fields — `startsAt`/`endsAt` (ISO date-times,
  optional, start `null`) — the distinction being that these are data we'll
  *reason about*, not just render, so they don't belong in the free-form
  `config`. Two edit surfaces, both event-admin gated: `config` via JSON Patch
  (RFC 6902) at `PATCH /events/:eventId/config` (`events.patch`, whose `payload`
  is the ops array), and the operative fields via `PATCH /events/:eventId`
  (`events.update`: `startsAt`/`endsAt` as `['string','null']` — omit to leave
  unchanged, `null` to clear, a string is parsed and normalized to a canonical
  ISO instant or 422s). Config edits, `events.update`, and
  `events.delete` are gated **in-handler** on `/events/:id/admin` (event-scoped,
  so not a static `requires` — `ctx.assertPermission`), which `**` satisfies for
  every event. So "event admin" is a real role, not just a richer read. `GET /events/:eventId` is
  **graded**: admins (`/events/:id/admin`) get the full doc; participants
  (`/view` *or* `/join`) get a whitelisted user view (`id`, `startsAt`, `endsAt`,
  `config`, `guestList` — operative fields drive display, so participants see
  them); anyone else → 404 (hide). An event also has a **blob bucket**
  `events/<id>` (see Blob storage) — writable by its admin, readable by
  participants; the SPA stores a cover image there and references it from
  `config.picture` as `{ $blob: 'events/<id>/blb_…' }`. Other config keys the SPA
  renders: `config.location` (shown to invitees, linked to `config.locationHref`
  when that's a safe-scheme URL — `safeHref` blocks `javascript:`/`data:` since
  an admin's config reaches invitees). Both views also carry an **`access`**
  block (`{ admin, join }`) so a client offers only the actions the viewer may
  take (e.g. the SPA's RSVP strip appears iff `access.join`). `GET /events` (`events.list`) is
  **"my events"** — no admin gate; it returns only the events you participate in
  (via `/view`/`/join`/`/admin`), each graded the same way (admins get all),
  **ordered by time** (untimed events first, then by start, then end). A
  **`when`** query param scopes it: `upcoming` (default) hides *past* events;
  `past` returns exactly those, most-recent first; `all` returns everything.
  `isPastEvent`: a fully-timed event is past once start *and* end are both before
  now; an **open-ended** event (start, no end) is past once its start is more
  than **48h** ago (`OPEN_ENDED_GRACE_MS`); an untimed event (no start) is never
  past. It's
  backed by the **`byUser` index** (see Dogfooding): each event carries a
  denormalized `members` list — the account ids invited to or administrating it,
  mirrored from their grants by `addEventMember`/`eventIdFromGrant` on
  invite-redeem and `accounts.grant`/`revoke` (and reconciled at boot by
  `backfillEventMembers`). A scoped caller queries `byUser.getMany([sub])`
  (already time-ordered); a global `**` admin isn't enumerated in any `members`,
  so `seesAllEvents(ctx)` routes them through a full scan instead. The handler
  re-sorts regardless, so ordering holds under the inline (CLI) index too.
  `eventAccess()` + `projectEvent()` are shared by both so an event appears in
  your list exactly when you could open it, and looks identical either way. Both
  synthesize a **`guestList`** from reservations (one scan grouped by event) —
  entries `{ id, name?, avatar?, response?, guests }` (Facebook-style:
  participants see who's coming) — but the guest list is **responders only**.
  For the admins-only "haven't responded" view there's **`events.members`**
  (`GET /events/:eventId/members`, event-admin gated): the full roster resolved
  from `members[]` — every associated account with name, avatar, and `response`
  (null = no RSVP yet), including non-responders the guest list omits.
  **`events.removeMember`** (`DELETE /events/:eventId/members/:accountId`,
  event-admin gated) fully removes an account: strips its `/events/:id/*` grants,
  drops it from `members[]`, and deletes its reservation (you can't remove
  yourself → 400). The **open-invite** ("link sent, not used") cohort has its own
  pair: **`events.invites`** (`GET /events/:eventId/invites`, event-admin gated)
  lists invites conferring access to the event that nobody has redeemed yet
  (`!accountId`), token omitted; **`events.revokeInvite`**
  (`DELETE /events/:eventId/invites/:inviteId`) deletes one to invalidate its
  link (only if it references this event); **`events.updateInvite`**
  (`PATCH` same path) edits an invite's `name`/`guestAllowance` (see invites).
  (`PATCH /events/:eventId/config` remains for editing config; there's no GET on
  that path — read config via the graded `GET /events/:id`.)
- `reservations` — an account's RSVP to an event, one per (event, account),
  keyed `<eventId>~<accountId>`. `PUT/GET/DELETE /events/:eventId/reservation`
  gated (in-handler) on `/events/:id/join`; `accountId` defaults to the caller,
  another account requires admin over that event (`/server/admin` *or*
  `/events/:id/admin`). Fields: `response` (going/maybe/not-going),
  `guests` (array of possibly-empty names). **`reservations.set` enforces the
  reserver's guest allowance**: `guests.length` may not exceed the account's
  `guestAllowance` (422), *unless* the caller is an admin over the event (exempt —
  they may seat any party size). The viewer's effective allowance is surfaced in
  the graded event view's `access.guestAllowance` (null = unlimited; admins get
  null) so the SPA can stop offering "Add guest" past the cap.
- `invites` — an invite **is a token**. `invites.create` mints one, authorized
  by *what it confers*: a global admin may confer any `grants`; anyone else may
  only mint an invite whose every grant falls under an event they administer
  (`/events/:id/admin`) — so an event admin can invite people to their own event
  (the SPA's "Admin actions" → Create invite), but no bare or global-scoped
  invite, and no escalation. Its
  `id` (`nvt_…`) is a non-secret handle, its `token` field is the secret you put
  in a link, its `grants` are the permissions redemption confers, an optional
  `entrypoint` (same-origin relative path) is echoed back at redeem as where to
  start, an optional `name` seeds the redeemer's account, and an optional
  **`guestAllowance`** (int ≥ 0; omit = unlimited) caps how many guests the
  redeemer may bring — copied to the account at redemption. `token`/`id` are
  separate so future expiry/single-use lives on the token without touching
  account identity. **The token is shown once, in the create response** —
  `invites.get`/`list` are admin-only and omit it (redemption finds it via the
  byToken index, not a read). An open invite's `name`/`guestAllowance` are
  editable from the admin "Open invites" screen (`events.updateInvite`).
  Redeeming binds an **account**.
- `accounts` — non-admin identities, auto-created (and bound to the invite) on
  first redemption, carrying the invite's `grants`, `name`, and `guestAllowance`
  (the guest cap enforced by `reservations.set`); a JWT's `sub` is an account id. `accounts.update` (`PATCH /accounts/:accountId`) is
  **owner-or-admin** (`ownAccountOrAdmin` helper) and sets `name` and `avatar`
  (never grants — no self-escalation). **`avatar`** is a profile picture, stored
  as a `{ $blob }` ref into the account's *own* `accounts/<id>` bucket (see Blob
  storage; a cheap string check rejects a ref to any other bucket — 422; `null`
  clears). That bucket is 2 MB + evict-oldest, so new uploads purge stale
  pictures. `accounts.get` is **graded**: owner/admin get the full doc, any other
  signed-in caller a whitelisted public view (`{ id, name, avatar }` — name +
  avatar already show in guest lists, but grants/bindings never leak), anonymous
  callers 404. The guest list's `name`/`avatar` are sourced from the account, so
  editing either updates it everywhere; guest names render as a `UserLink`
  (mini avatar or initial-in-a-colored-circle + name) linking to `/accounts/:id`
  (read-only unless it's you), and `?event=` renders that page relative to the
  event (RSVP line + an event-admin grant control).
  `accounts.grant`/`revoke` (`POST`/`DELETE /accounts/:accountId/grants`,
  field `grant`) add/remove one permission glob on an account, under a
  **confer-only-what-you-hold** rule (`ctx.assertPermission(grant)`): a `**`
  holder grants anything, an event admin only that event's `/admin`. Idempotent,
  and effective on the target's next request (grants resolve per-request, never
  frozen into a JWT). Kept off `accounts.update` to preserve its no-escalation
  invariant. `accounts.reconnect` (`POST /accounts/:accountId/reconnect`,
  `requires: /server/admin`) mints an invite **pre-bound to this account** — its
  `accountId` is set at creation, so `redeemInvite` takes its already-bound
  branch (returns this account, creates none), letting a logged-out person
  re-establish a session under their **existing** profile (with its existing
  grants). **Global-admin only** — the link is full access to the account, so
  event admins can't mint one. Token shown once (like `invites.create`).
  `sessions` — still a placeholder stand-in.

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

## Blob storage (`blobs.mjs`)

Binary that JSON refers to by an embedded sentinel
**`{ $blob: '<bucket>/blb_<id>' }`**. A **REST-native subsystem** (like
`auth.mjs`), *not* a registry action — the resumable transfer protocol
(offset-addressed append, `HEAD`-to-resume, `Range` download) doesn't project
onto CLI/MCP. So the registry stays JSON-only; **MCP/CLI can still carry `$blob`
refs inside `config`, they just can't move bytes** (this is the Option-B answer
to "binary over MCP": out-of-band bytes, an opaque handle in the JSON).

**Buckets are permission-scoped namespaces with a storage policy.**
`resolveBucket(bucket)` maps a bucket string to `{ canRead(ctx), canWrite(ctx),
maxBytes, evict }` (or `null` → 404, and the strict regex means no `..` reaches
the fs). New bucket kinds slot into `resolveBucket`. Two kinds today:
- **`events/<evt_id>`** — `canWrite` = `/events/:id/admin`, `canRead` =
  participant (`/admin`|`/join`|`/view`). So a blob grades **exactly** like its
  event (reuses the `eventAccess` logic), and the download URL is literally
  `/blobs/<ref>` — an `<img src>` a participant's session cookie authorizes
  automatically. Cap 10 MB, evict-oldest (so stale covers eventually reap).
- **`accounts/<acct_id>`** — the per-user profile-picture bucket. `canWrite` =
  owner (`ctx.auth.sub === id`) or global admin; `canRead` = any signed-in caller
  (avatars show in guest lists). Cap **2 MB**, evict-oldest — upload several and
  the stale ones purge fast. (The upload UI for this isn't wired yet; the bucket
  kind + policy are.)

**Per-bucket quota + GC.** `maxBytes` caps the bucket's *total* declared bytes
(an in-progress upload reserves its full `size`). A create is enforced by
`reserveAndCreate` under a per-bucket lock: if it won't fit and `evict` is
`'oldest'`, the oldest **complete** blobs are purged (by `createdAt`) until it
does; if it still won't fit (or `evict` is `'reject'`, the default), the create
`413`s. A single blob larger than `maxBytes` always `413`s. This is the GC —
there's no background sweeper; space is reclaimed lazily, at the moment a new
upload needs it.

**Read-time enforcement only** (v1): a forged/cross-bucket ref just 403/404s for
everyone, so no bytes leak — `logic.mjs` stays decoupled (a `$blob` in `config`
is opaque data it round-trips; there's no write-time ref validation yet).

**The protocol** (all `/blobs/*`, splat parsed per method; writes ride the same
cookie-auth + `csrfGuard` as REST; bytes live at `data/blobs/<bucket>/<blobId>`
with a `.meta.json` sidecar, plain fs — not pulp-db):
- `POST /blobs/<bucket>` `{ size, contentType, filename? }` → `201 { id, bucket,
  ref, offset, size }` — create a session (declare total size).
- `PATCH /blobs/<bucket>/<blobId>` — append a chunk: `Upload-Offset` header +
  `application/offset+octet-stream` body. Offset ≠ current → `409` + the real
  `Upload-Offset` (client re-syncs → **resumable**); past `size` → `400`;
  reaching `size` → `Upload-Complete: true`. A per-blob async lock serializes
  appends.
- `HEAD /blobs/<bucket>/<blobId>` → `Upload-Offset`/`-Length`/`-Complete` (query
  where to resume).
- `GET /blobs/<bucket>/<blobId>` → download once complete; `Range`-aware (`206`),
  `Cache-Control: immutable` (a completed id never changes).
- `DELETE /blobs/<bucket>/<blobId>` → remove.

The chunked create-then-append shape is what lets the SPA draw a **progress bar**
(it PATCHes 1 MB chunks and reports the running offset) and lets a future client
**resume** a broken upload. `/blobs` is in `spa.mjs`'s `NON_SPA` (never the app
shell). Caps: 25 MB declared size, 8 MB per chunk.

## Run

```sh
velvet                       # or `velvet serve` — start server on :3000
velvet --dev                 # dev: watched backend + Vite HMR (app at :5173)
velvet invites create --email a@b.com   # CLI (no auth needed locally)
npm run build:client         # build the SPA into client/dist
npm test                     # backend suite (node:test, test/**/*.test.mjs)
npm start                    # = node index.mjs serve
```

**Docker** is the primary release artifact. `./docker-build.sh` builds
`velvet:<package version>` + `velvet:latest` (`IMAGE=...` to retag). The image
stores everything under **`/data`** (mount a volume there; runs as the `node`
user) and listens on **`PORT`** (default `8080`; the CMD maps it to
`VELVET_PORT`). Set `VELVET_PUBLIC_URL` to the external URL in any real
deployment. CLI in a running container: `docker exec <c> node index.mjs ...`.

Env: `VELVET_PUBLIC_URL` (default `http://localhost:3000`; must match what a
client hits — baked into discovery/issuer/aud), `VELVET_JWT_SECRET` (overrides
the persisted key, not persisted), `VELVET_DATA` (default `data`), `VELVET_PORT`
(default `3000`), `VELVET_AUTH=off` (dev: no guards, everyone admin). OpenAPI +
docs UI at `/docs`.

## Tests

`test/` covers all four projections: handlers directly (`makeLogic`), REST and
MCP via `fastify.inject()` on `buildServer()` (no port bound), and the CLI via
`buildCli(...).run()` with injected `out`/`err` sinks. Each test gets its own
`mkdtemp` data dir under **inline** pulp-db (no LevelDB, no lock, strongly
consistent). `eventual-consistency.test.mjs` instead uses `watch:false` stores
(via `velvetLogic`'s `makeStore` seam) so a write missing `awaitIndex` stays
invisible to index reads until flushed. Helpers live in `test/helpers.mjs`.

## Frontend (SPA)

### Theming — React emits semantic HTML, CSS does all the skinning

**The strategy:** React renders **semantic, presentation-free HTML** with **stable
class hooks**; *all* visual styling lives in **CSS**. An operator reskins the
entire app by supplying one stylesheet — no rebuild, no JS changes. This is the
frontend's "one idea": markup describes *structure and meaning*, CSS owns *looks*.

**How it's wired** (built — no longer aspirational):
- **Base theme** = `client/src/styles.css`, imported in `main.jsx`. *All* its
  rules live inside **`@layer velvet-base`**.
- **Operator theme** = `GET /theme.css`, served by the backend (`server.mjs`)
  from `data/theme.css` (empty `text/css` when absent; `no-cache`). The shell
  (`client/index.html`) links it in `<head>`. Registered unconditionally so it
  works in `--dev` too (Vite proxies `/theme.css` to the backend).
- **Why the layer:** unlayered CSS always beats layered CSS, so the operator's
  (plain, unlayered) theme overrides **any** base rule **regardless of load order
  or specificity** — no `!important`, and we don't have to fight Vite's CSS
  injection order. An operator drops a `data/theme.css` and reskins live.

Rules that keep it true (follow these for all SPA work):
- **No inline styles, no JS style objects for presentation.** An inline `style`
  wins the cascade, so a theme can't override it. `App.jsx` is fully migrated to
  classes; the *only* inline `style` is `--avatar-hue` (a CSS variable, not a
  look — see below). Keep it that way.
- **Semantic elements first:** `<main>` is the page container (styled globally),
  `<button>`, `<ul>/<li>`, `<label>`-wrapping-`<input>`, ordered headings.
- **Stable, documented class names are an API.** kebab-case, BEM-ish
  (`.event-detail__header`, `.rsvp__option--active`, `.roster__item`). Renaming
  one breaks operator themes — treat like a public interface. State via classes/
  `aria-*`, never a computed style. Existing hooks: `.muted`, `.actions(--end)`,
  `.list-head`, `.rsvp`/`.rsvp__option(--active)`, `.tabs`/`.tab(--active)`,
  `.roster`/`.roster__item`/`__status`/`__actions`, `.user-link`, `.avatar(--lg,
  --placeholder)`, `.overlay`/`.dialog`, `.menu`/`.menu__item`, `.profile-menu`,
  `.admin-actions`, `.grant-row`, `.profile__head`, `.event-cover`/`-when`/
  `-location`, `.icon-button`.
- **Knobs are CSS custom properties** on `:root` in `styles.css` (`--fg`,
  `--fg-muted`, `--bg`, `--surface`, `--border(-strong)`, `--accent`/`--accent-fg`,
  `--radius(-sm)`, `--shadow(-sm)`, `--overlay`, `--page-width`). A light reskin
  overrides variables; a heavy one overrides rules. A `prefers-color-scheme: dark`
  block flips the variables (operators can override that too).
- **When a value must come from data, hand it to CSS — don't compute the look in
  JS.** The avatar color is the reference: JS sets `style={{ '--avatar-hue': N }}`
  and CSS does `background: hsl(var(--avatar-hue) 55% 45%)`, so a theme restyles
  avatars freely. That's the sanctioned form of an inline `style` — a data hook,
  not a look.

**Pushback posture:** if a request would bake a visual decision into JS or markup
in a way CSS can't override (data-driven inline styles, canvas/SVG with hardcoded
colors, layout decided in JS, pixel dimensions in markup, presentational content,
third-party widgets that inject their own inline/shadow styles), flag it and offer
the CSS-reskinnable version instead. Exceptions are allowed — just surface them
for a call, don't decide silently. The `qrcode.react` **QR code**
(`InviteLinkDialog`) was one, now largely reclaimed: it's rendered
`fgColor="currentColor" bgColor="transparent"`, so `.qr svg { color: var(--qr-fg);
background: var(--qr-bg) }` drives its colors + quiet-zone from CSS, reactively.
Only the module **shapes** stay lib-controlled (that's the residual exception).
`--qr-fg`/`--qr-bg` default dark-on-light and are *not* flipped in dark mode — QR
needs high contrast to scan. (General trick for a widget that takes a color prop:
pass `currentColor` and let CSS's `color` cascade in, rather than reading a CSS
var in JS — the JS read is a one-time snapshot that won't react to theme changes.)

### Serving & routing

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
- `/` or `/events` → your events list (upcoming by default, each with its
  localized time; a **Create event** button for global admins mints a blank event
  and jumps into it; a **Previous events →** link goes to `/events?when=past`, the
  historical list — `?when=past` flips the same component to fetch `when=past` and
  show a **← Upcoming events** link back); `/events/:eventId` → event
  detail: the graded view (an optional cover image from `config.picture`'s
  `$blob`, title, a localized schedule line when `startsAt`/`endsAt` are set,
  description), an edit pencil — an `access.admin`-gated link to a **dedicated
  editor** at `/events/:eventId/edit` (`EventEdit`) that shows *only* the edit
  form (title, description, location + optional link, the `startsAt`/`endsAt`
  datetime pickers, and a cover-image picker that uploads to the event's blob
  bucket via the resumable protocol with a `<progress>` bar) — no event display,
  but it keeps EventDetail's "card over the cover" chrome (the wallpaper behind,
  live-previewing the *pending* cover pick) so an admin gets a feel for the theme
  and cover photo while editing; one Save fans out to the config Patch, which also
  carries the `$blob` ref, *and* the operative `PATCH /events/:eventId`, then
  navigates back to the event (Cancel just navigates back). The page re-checks
  `access.admin` itself (non-admins/404 get a message + back link). Also **an
  "Admin actions"**
  accordion (Create invite) gated on `access.admin` (so event admins see
  it), an RSVP block gated on `access.join` (`RsvpStrip`: the going/maybe/not-
  going segmented control **plus guest management** when going/maybe — add/edit/
  remove named guests as clickable chips, capped at `access.guestAllowance`; the
  "Add guest" button hides at the cap and a "N of M guests allowed" hint shows),
  and the RSVP roster (`Rsvps`) — a "Who's Going" tab listing the *going*
  responses then the *maybes* (tagged "(maybe going)"), its count a **head count**
  (attendees + guests), and a "Can't go" tab for the declines; names link to
  profiles. The Admin actions accordion also links to **User management**
  (`/events/:eventId/users` → `EventUsers`, admin-only): the full roster from
  `events.members` (including no-response invitees), each with a two-click
  **Revoke invite** that calls `events.removeMember`; and **Open invites**
  (`/events/:eventId/invites` → `EventInvites`, admin-only): unredeemed invite
  links from `events.invites`, each with **Edit** (name + guest slots,
  `events.updateInvite`) and a two-click **Invalidate** (`events.revokeInvite`).
  Create invite also takes a **Guest slots** number (blank = unlimited).
- `/accounts/:accountId` → profile page: editable only for your own account —
  display name **and a profile-picture upload** (to your `accounts/<id>` bucket
  via the resumable protocol + `<progress>` bar; the `$blob` ref is saved through
  `accounts.update`) — peers get a read-only `{ id, name, avatar }` view;
  `?event=<eventId>` renders it relative to that event — the account's RSVP
  status line plus, for an admin of that event, a grant/revoke control (event
  admin, and full `**` for global admins). A **global** admin also gets a "New
  invite link" button here (`accounts.reconnect`) that mints a link to reconnect
  that person under their existing profile — shown via the shared
  `<InviteLinkDialog>` (QR + copyable link), the same modal event invites use.
  The `<UserLink>` component (mini
  `<Avatar>` — the picture, or the name's first initial in a color-hashed circle
  — + name, linking to the profile) renders every name link, e.g. the event
  guest list.
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
→ respawn. The non-overlap is deliberate — the
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
- **`data/` is gitignored** — holds the signing key and live bootstrap credential
  (and, under `data/blobs/`, uploaded blob bytes). Never commit it.
- **Blobs can orphan** — the SPA uploads a cover image immediately but only
  writes the `$blob` ref on Save, so Cancel (or replacing an image) leaves bytes
  in `data/blobs/` unreferenced. There's no background sweeper; the per-bucket
  evict-oldest policy reclaims them lazily when a later upload needs the space
  (see Blob storage). Read-time-only enforcement means a dangling ref (evicted or
  never-saved) just renders broken, never leaks.
- **claude.ai needs a public HTTPS URL** for MCP — can't dial `http://localhost`.
  Local CLI/REST is genuinely turnkey; remote MCP needs a tunnel.

## Dogfooding pulp-db + cardcatalog

Exercises `@yourlivingroom/pulp-db` and `@yourlivingroom/cardcatalog`, which are
shaped alongside velvet. Each has its own git repo (`../pulp-db`,
`../cardcatalog`) and is **published to npm**; velvet consumes the published
versions. So editing the sibling source does **not** reach velvet: change it
there (with its own tests/README), publish (cardcatalog before pulp-db, which
depends on it), bump velvet's range, `npm install`. npm takes ~a minute to serve
a fresh publish — poll `npm view <pkg>@<ver> version` before installing.

**Index materialization is a choice.** An index is a *definition* (a
`process`/`emit` fn) plus a *materialization*:
- **live** (default) — cardcatalog keeps it in a chokidar-watched LevelDB: fast,
  but holds an exclusive lock and is eventually consistent (watcher lag).
- **inline** (`pulpDb(idx, { inline: true })`) — no persistent structure; each
  query scans the collection and runs `process` in memory. No LevelDB, no
  watcher, no lock.

Same query API either way (`store.indexes.<name>.get(key)` /
`getMany(prefixKey)`). velvet runs the **server live** and the **CLI inline**, so
a one-shot CLI shares a `data/` dir with a live server without fighting for the
lock. `invites` carries a `byToken` index; redemption uses it.

**Composite keys are ordered (charwise).** `events` carries a **`byUser`** index
emitting `[accountId, startsAt, endsAt] → id` per member. Keys are stored with
`charwise`, whose byte-ordering puts `null` before any string and sorts ISO
date-times chronologically — so `byUser.getMany([accountId])` (a prefix query:
cardcatalog ranges `[key, KEY_BOTTOM]..[key, KEY_TOP]`) streams that account's
events **already ordered** untimed-first-then-chronological, no sort needed live.
This is what backs "my events" (see Domain). `events.list` also re-sorts in the
handler; that predates inline mode matching live ordering and is now redundant.

**Strong-consistency escape hatch:** `store.edit(path, updater, { awaitIndex:
true })` blocks until the live index reflects the write (the writer drives
cardcatalog's `reindex(path)` directly — no waiting on the watcher). No-op when
inline or unchanged. `invites.create` uses it, so a fresh invite is redeemable
the instant create returns (removes the create-then-redeem race — no test poll).
Without it, the live index is eventually consistent (watcher lag ~sub-second),
which is fine where a human-in-the-loop delay precedes the read.

A third materialization, **`watch: false`**, keeps the LevelDB but runs no
watcher: the index changes only when driven (`awaitIndex` or `reindex()`). The
test suite uses it to make watcher lag reproducible (see Tests).

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
