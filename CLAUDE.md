# velvet

A self-hosted event-management server. Status: **API only**. Admin auth *and*
non-admin accounts (via invite tokens) both work; `events` and
`invites`/`accounts` are real, `sessions` still a stand-in. Not yet wired to a
real claude.ai connection.

## The one idea

Every action is defined **once** in `logic.mjs` as a self-describing descriptor,
and mechanically projected onto four interfaces. Never hand-write an interface —
add to the registry and all four update.

```
logic.mjs   THE registry. action = { summary, description?, requireAdmin?,
            payload?, http:{method, path, mediaType?}, input:<JSON Schema>, handler }
bind.mjs    pure projections: schema -> sbopts flags, path/payload split, -> MCP
            tool; cliSummary() folds CLI-only hints into help text
cli.mjs     sbopts command tree; path params + payload -> positionals (or --flags)
rest.mjs    Fastify routes        (input schema -> params/body/querystring + validation)
mcp.mjs     stateless Streamable-HTTP MCP endpoint (tools/list + tools/call == registry)
auth.mjs    Resource Server (JWT validation) + bootstrap issuer + invite redeem
permissions.mjs  pure path-glob matcher: can(grants, path)
errors.mjs  ClientError(msg, statusCode) — the caller-error seam adapters map
server.mjs  REST + OpenAPI(/docs) + MCP + auth in one Fastify process
index.mjs   args -> CLI; else -> server
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
- `requireAdmin: true` — admin-only, enforced by a loud guard (see Auth).
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
  (`events.patch`, whose `payload` is the ops array). `GET /events/:eventId/config`
  (the user view) needs the `/events/:id/view` permission; `GET /events/:eventId`
  (full doc) needs `/events/:id/admin`. Unpermitted → 404 (quiet-hide).
- `invites` — an invite **is a token**. `invites.create` (admin) mints one; its
  `id` (`nvt_…`) is a non-secret handle, its `token` field is the secret you put
  in a link, and its `grants` are the permissions redemption confers. `token`/`id`
  are separate so future expiry/single-use lives on the token without touching
  account identity. Redeeming binds an **account**.
- `accounts` — non-admin identities, auto-created (and bound to the invite) on
  first redemption, carrying the invite's `grants`; a JWT's `sub` is an account
  id. `sessions` — still a placeholder stand-in.

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
- **Loud** — `requireAdmin` guard (REST 401 anon / 403 non-admin; MCP hides the
  tool + `Forbidden`), and `ctx.assertPermission(...)` → 403. For the admin
  surface.
- **Quiet** — handler returns `null` (→ 404) when `!ctx.can(...)`, to hide a
  resource the public might probe by id rather than challenge. Event reads do
  this.

**CLI is filesystem-trust = implicitly admin** (`makeContext` with a synthetic
admin auth → `**`). Admin = JWT `roles` includes `"admin"` (bootstrap tokens
always; redeemed invites never). `requireAdmin` is still a separate coarse gate;
it could later become a permission check too. Per-identity admins + external
trusted issuers remain deferred.

**Gotcha:** never let an immer draft (or a sub-object of one) escape an `edit()`
updater — immer revokes it on return, and touching it later throws "proxy that
has been revoked". Snapshot a plain copy inside the updater (`[...draft.arr]`).

## Run

```sh
velvet                       # or `velvet serve` — start server on :3000
velvet invites create --email a@b.com   # CLI (no auth needed locally)
npm start                    # = node index.mjs serve
```

Env: `VELVET_PUBLIC_URL` (default `http://localhost:3000`; must match what a
client hits — baked into discovery/issuer/aud), `VELVET_JWT_SECRET` (overrides
the persisted key, not persisted), `VELVET_DATA` (default `data`), `VELVET_AUTH=off`
(dev: no guards, everyone admin). OpenAPI + docs UI at `/docs`.

## Gotchas

- **Testing the server: don't `pkill -f "index.mjs serve"`** — the pattern matches
  your own shell. Kill by port (`fuser -k 3000/tcp`) or capture `$!` at launch.
  A node server's `comm` shows as `MainThread`, so `comm`-based filters miss it.
- **`data/` is gitignored** — holds the signing key and live bootstrap credential.
  Never commit it.
- **`package.json` uses `file:../` deps** (`pulp-db`, `cardcatalog`, `sbopts`) —
  resolves inside `silly/`, not in a standalone clone.
- **claude.ai needs a public HTTPS URL** for MCP — can't dial `http://localhost`.
  Local CLI/REST is genuinely turnkey; remote MCP needs a tunnel.

## Dogfooding pulp-db + cardcatalog

Exercises `@livingroom/pulp-db` and `@livingroom/cardcatalog`. **Neither is
version-controlled** — their edits live in the sibling dirs, uncommitted.

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
index; redemption uses it (eventual consistency is fine — a token is handed to a
human before anyone redeems it).

Fixes made along the way:
- pulp-db `get()` was broken (`fs.promises.read` → `readFile`); added `list()`
  (direct `readdir`) and the `inline` mode above.
- cardcatalog: `mkdirSync(dataPath)` before watching (it silently indexed
  *nothing* on a fresh dir — every lookup was null); a `shouldIndex(path, stats)`
  predicate so the caller filters files (pulp-db passes `p => p.endsWith('.json')`
  to skip write-file-atomic's temp files — indexing those double-registers a key
  → `get()` throws "Multiple matches"); debug logs gated behind `CARDCATALOG_DEBUG`.
- No native TTL; bootstrap codes use an `expiresAt` field + lazy sweep.
```
