// Shared backend-test harness.
//
// Two isolation seams, both built on pulp-db's INLINE mode + a throwaway temp
// dir. Inline mode keeps no LevelDB, no chokidar watcher, and no lock, and it's
// strongly consistent (index queries scan live) — so each test gets a fresh,
// fully-isolated store for ~a millisecond and never has to poll for a watcher to
// catch up. See CLAUDE.md → Dogfooding for why inline is the right call here.
//
//   makeLogic(t)   — the fast seam. Drives action handlers directly against a
//                    velvetLogic() built inline. Use for the bulk of coverage:
//                    permissions, grading, RSVP caps, invite authz, etc.
//   makeServer(t)  — the wiring seam. Boots the real Fastify app (buildServer,
//                    no port) and drives it with inject(): routing, schema
//                    validation, auth guards, CSRF, content-negotiation.
//
// Both register a t.after() that closes the store and removes the temp tree, so
// a test never leaks a dir or a file handle.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SignJWT } from 'jose';

import pulpDb from '@yourlivingroom/pulp-db';
import velvetLogic from '../logic.mjs';
import { buildServer } from '../server.mjs';

// A fixed signing secret for the server seam, so tests can FORGE session cookies
// (and their matching CSRF tokens) directly — no need to drive the rate-limited,
// banner-printing bootstrap/redeem flow for every logged-in request. A handful
// of tests still exercise the real login endpoints; those live in the REST file.
export const TEST_SECRET = 'velvet-test-secret-key';
export const TEST_PUBLIC_URL = 'http://localhost:3000';
const RESOURCE_AUD = `${TEST_PUBLIC_URL}/mcp`;

// A private temp dir wired to auto-clean when the test finishes.
function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// ---- the handler seam -----------------------------------------------------

// Build an inline velvetLogic over a fresh temp dir. Returns the logic object
// plus ctx factories for the three caller kinds a handler cares about.
export function makeLogic(t) {
    const dir = tempDir(t);
    const logic = velvetLogic(dir, { inline: true });
    t.after(() => logic.close());

    return {
        logic,
        dir,
        actions: logic.actions,
        redeemInvite: logic.redeemInvite,
        backfillEventMembers: logic.backfillEventMembers,
        // A global admin (bootstrap JWT / CLI equivalent): grants '**'.
        adminCtx: () => logic.makeContext({ roles: ['admin'], sub: 'admin' }),
        // A redeemed account: identity only; its grants come from the stored
        // account doc (so grant/revoke it first if you need permissions).
        accountCtx: (sub) => logic.makeContext({ sub, roles: [] }),
        // Nobody (anonymous / no credential).
        anonCtx: () => logic.makeContext(null),
        // Run one action by name — sugar over actions[name].handler(input, ctx).
        call: async (name, input, ctx) =>
                logic.actions[name].handler(input, await ctx)
    };
}

// ---- the eventual-consistency seam ----------------------------------------
//
// The inline seam is strongly consistent, which means it can't tell whether a
// handler correctly opts into `awaitIndex` where production (a live, watched
// index) needs it — under inline, `awaitIndex` is a no-op. This seam closes that
// gap: it builds each collection over a `watch: false` pulp-db store — a real
// LevelDB index that updates ONLY when driven — and wraps it so a write made
// *without* `awaitIndex` stays invisible to index queries until `flushWrites()`.
// So a create-then-read that relies on `awaitIndex` succeeds before any flush
// (proving the guard is there), while the lag is otherwise real and
// deterministic — no watcher timing, and stale-on-delete behaves like production.

// Wrap a store so plain edits lag the index until flushWrites(); an awaitIndex
// edit (which pulp-db reindexes on the spot) is visible at once, as in prod.
function lagStore(store) {
    const pending = new Set();   // relative paths written since the last flush
    return {
        ...store,
        async edit(path, updater, opts = {}) {
            const result = await store.edit(path, updater, opts);
            // awaitIndex already drove the reindex → visible now, not pending.
            if (opts.awaitIndex) pending.delete(path);
            else pending.add(path);
            return result;
        },
        // The deterministic "eventually": fold every deferred write into the
        // index (reindex is idempotent, and reconciles deletes too).
        async flushWrites() {
            for (const p of pending) await store.reindex(p);
            pending.clear();
        }
    };
}

// Like makeLogic, but over live (watch:false) lag-wrapped stores. Adds `stores`
// (the wrapped collections, by name) and `flushWrites()` (advance every index).
export function makeLiveLogic(t) {
    const dir = tempDir(t);
    const stores = {};
    const makeStore = (indexes, opts) => {
        const name = opts.dataPath.split('/').pop();   // invites, events, …
        const wrapped = lagStore(
                pulpDb(indexes, { ...opts, inline: false, watch: false }));
        stores[name] = wrapped;
        return wrapped;
    };
    const logic = velvetLogic(dir, { makeStore });
    t.after(() => logic.close());

    return {
        logic,
        dir,
        stores,
        actions: logic.actions,
        redeemInvite: logic.redeemInvite,
        backfillEventMembers: logic.backfillEventMembers,
        adminCtx: () => logic.makeContext({ roles: ['admin'], sub: 'admin' }),
        accountCtx: (sub) => logic.makeContext({ sub, roles: [] }),
        anonCtx: () => logic.makeContext(null),
        flushWrites: async () => {
            for (const w of Object.values(stores)) await w.flushWrites();
        }
    };
}

// ---- the server (inject) seam ---------------------------------------------

// Forge a velvet_session access JWT for a subject with the given roles, signed
// with TEST_SECRET so the running server accepts it as genuine.
export async function forgeAccess(sub, roles = []) {
    const key = new TextEncoder().encode(TEST_SECRET);
    return new SignJWT({ typ: 'access', roles })
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject(sub)
            .setIssuer(TEST_PUBLIC_URL)
            .setAudience(RESOURCE_AUD)
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(key);
}

// The CSRF token the server expects for `sub`: HMAC(sub) under a subkey derived
// from the signing key, exactly as auth.mjs computes it. Mirrored (not imported)
// on purpose — if auth.mjs's derivation drifts, the real-login REST tests catch
// it, while these forged-cookie tests stay fast.
export function csrfTokenFor(sub) {
    const key = new TextEncoder().encode(TEST_SECRET);
    const subkey = crypto.createHmac('sha256', key)
            .update('velvet-csrf-v1').digest();
    return crypto.createHmac('sha256', subkey).update(sub).digest('hex');
}

// Boot the real app (no port) over a fresh inline store. Returns the Fastify
// instance plus an `as(sub, roles)` factory yielding a browser-like client that
// carries the forged session cookie and auto-attaches X-CSRF-Token on writes.
export async function makeServer(t, { env = {} } = {}) {
    const dir = tempDir(t);
    const prevEnv = {};
    const setEnv = {
        VELVET_PUBLIC_URL: TEST_PUBLIC_URL,
        VELVET_JWT_SECRET: TEST_SECRET,
        VELVET_DEV: '1',          // skip serving the built SPA
        ...env
    };
    for (const [k, v] of Object.entries(setEnv)) {
        prevEnv[k] = process.env[k];
        process.env[k] = v;
    }

    const logic = velvetLogic(dir, { inline: true });
    const fastify = await buildServer(logic, { rootPath: dir, logger: false });
    await fastify.ready();

    t.after(async () => {
        await fastify.close();   // fires onClose → closes logic + auth stores
        for (const [k, v] of Object.entries(prevEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    // A thin client bound to one identity. `sub` null = anonymous (no cookie).
    function client(sub, roles = []) {
        const cookiePromise = sub == null
                ? Promise.resolve(null)
                : forgeAccess(sub, roles);

        async function request(method, url, { body, headers = {}, csrf = true } = {}) {
            const access = await cookiePromise;
            const cookies = {};
            if (access != null) {
                cookies.velvet_session = access;
                cookies.velvet_csrf = csrfTokenFor(sub);
            }
            const h = { ...headers };
            const writeMethod = !['GET', 'HEAD', 'OPTIONS'].includes(method);
            if (writeMethod && csrf && sub != null && !('x-csrf-token' in h)) {
                h['x-csrf-token'] = csrfTokenFor(sub);
            }
            return fastify.inject({ method, url, cookies, headers: h,
                    ...(body !== undefined ? { payload: body } : {}) });
        }

        return {
            raw: request,
            get: (url, opts) => request('GET', url, opts),
            post: (url, body, opts) => request('POST', url, { ...opts, body }),
            put: (url, body, opts) => request('PUT', url, { ...opts, body }),
            patch: (url, body, opts) => request('PATCH', url, { ...opts, body }),
            del: (url, opts) => request('DELETE', url, opts)
        };
    }

    // Post a JSON-RPC message to the MCP endpoint. `token` is a Bearer access
    // JWT (forgeAccess) — /mcp is Bearer-only (no cookie), so pass null to test
    // the unauthenticated path. Returns { status, json }.
    async function mcp(token, message) {
        const headers = { 'content-type': 'application/json' };
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await fastify.inject(
                { method: 'POST', url: '/mcp', headers, payload: message });
        return { status: res.statusCode, json: body(res), res };
    }

    return {
        fastify,
        dir,
        logic,
        inject: (opts) => fastify.inject(opts),          // fully raw
        mcp,
        anon: () => client(null),
        as: (sub, roles = []) => client(sub, roles),
        asAdmin: () => client('bootstrap-admin', ['admin'])
    };
}

// ---- the CLI seam ----------------------------------------------------------

// Drive the sbopts CLI in-process: buildCli(...).run(argv). Captures stdout,
// stderr, and process.exitCode (restoring all three after), so a test can
// assert on the JSON the CLI prints, the error text it writes, and its exit
// code — exactly what a shell would see. Buffer-safe (process.stdout.write can
// be handed a Buffer). `logic` is a makeLogic()'s `.logic` (or any velvetLogic).
export async function runCli(logic, argv) {
    const out = [];
    const err = [];
    const sink = (arr) => ({
        write: (chunk) => {
            arr.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
            return true;
        }
    });
    // buildCli writes to the injected sinks, so we never touch the global
    // process streams (which the test runner also writes to). Only exitCode is a
    // shared global — a plain number, saved and restored here.
    const prevExit = process.exitCode;
    process.exitCode = 0;
    let code;
    try {
        const { buildCli } = await import('../cli.mjs');
        await buildCli(logic.actions,
                { makeContext: logic.makeContext, out: sink(out), err: sink(err) })
                .run(argv);
    }
    finally {
        code = process.exitCode;
        process.exitCode = prevExit;
    }
    return { stdout: out.join(''), stderr: err.join(''), code };
}

// ---- seed helpers (handler seam) ------------------------------------------
// Build fixtures through the real actions, so setup exercises real code paths.
// All take the object returned by makeLogic(t).

// Create an event as a global admin; returns the stored event doc.
export async function seedEvent(h, { config } = {}) {
    return h.actions['events.create'].handler(
            { config: config ?? {} }, await h.adminCtx());
}

// Mint an invite (as admin) conferring `grants`, redeem it, and return the
// new account's id (+ the invite). This is how a non-admin account with real,
// stored grants comes to exist — the same path production uses.
export async function seedAccount(h, { grants = [], name, guestAllowance } = {}) {
    const admin = await h.adminCtx();
    const invite = await h.actions['invites.create'].handler(
            { grants, ...(name !== undefined ? { name } : {}),
              ...(guestAllowance !== undefined ? { guestAllowance } : {}) }, admin);
    const { accountId } = await h.redeemInvite(invite.token);
    return { accountId, invite };
}

// Grant one permission to an account, as a global admin.
export async function grantTo(h, accountId, grant) {
    return h.actions['accounts.grant'].handler(
            { accountId, grant }, await h.adminCtx());
}

// ---- misc -----------------------------------------------------------------

// Drain an async iterable into an array.
export async function collect(iter) {
    const out = [];
    for await (const x of iter) out.push(x);
    return out;
}

// Parse a JSON inject response body (fastify's res.json() also works, but this
// tolerates empty bodies).
export function body(res) {
    return res.payload === '' ? undefined : JSON.parse(res.payload);
}
