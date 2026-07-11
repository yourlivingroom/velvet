# velvet

A self-hosted event-management server. Status: **API only**, auth nailed down,
first domain model (`events`) landing; `invites`/`sessions` still stand-ins. Not
yet wired to a real claude.ai connection.

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
auth.mjs    Resource Server (JWT validation) + bootstrap issuer
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
- `requireAdmin: true` — admin-only (see Auth).
- `handler(input)` returns a value (serialized to all interfaces). `null` means
  "not found" → REST 404. Throw `ClientError(msg, status)` for caller errors →
  REST maps the status, MCP an `isError` result, CLI stderr + exit 1.

CLI positionals (path params, then payload) fill left-to-right; giving the same
one both positionally *and* by flag is an error. No other file needs editing.

## Domain (so far)

- `events` — the first real model. The stored doc separates **our** metadata
  (top-level: `id` = `evt_…`, `createdAt`) from the **user's** `config` (an
  arbitrary JSON document). Only `config` is user-editable, and only via JSON
  Patch (RFC 6902) at `PATCH /events/:eventId/config` (`events.patch`, whose
  `payload` is the ops array). `GET /events/:eventId/config` returns just the
  config; `GET /events/:eventId` the whole doc.
- `invites` / `sessions` — still placeholder stand-ins.

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

Authorization: `requireAdmin` is enforced in REST (route guard: 401 anon / 403
authed-non-admin) and MCP (per-tool: hidden from `tools/list`, `Forbidden` on
`tools/call`). **CLI is filesystem-trust = implicitly admin** (it calls handlers
directly; anyone with `data/` access already has full control).

Admin = JWT carries `roles` including `"admin"`. Bootstrap tokens always do.
There is currently **one** bootstrap admin; per-identity admins + external
trusted issuers are deliberately deferred (`roles` is the seam for them).

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

## Dogfooding pulp-db

This project exists partly to exercise `@livingroom/pulp-db`. Findings so far:
- Fixed its broken `get()` (`fs.promises.read` → `readFile`).
- Added `list()` (direct `readdir`, strongly consistent) — its cardcatalog index
  is eventually-consistent (chokidar watcher), wrong for read-after-write.
- No native TTL/expiry; bootstrap codes use an `expiresAt` field + lazy sweep.
  Candidate pulp-db feature if a second TTL collection appears.
```
