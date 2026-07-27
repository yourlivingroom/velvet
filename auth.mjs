import crypto from 'crypto';
import fs from 'fs/promises';
import pathLib from 'path';
import pulpDb from '@yourlivingroom/pulp-db';
import { SignJWT, jwtVerify } from 'jose';

// Auth for velvet, in two halves the MCP spec (RFC 9728 / 8414 / 7591) expects:
//
//   Resource Server  — validate the Bearer JWT on /mcp, nothing more.
//                      Swappable for external IdPs by changing how `verify()`
//                      resolves keys + trusted issuers.
//
//   Bootstrap issuer — the *sole* way to get a first admin credential on a
//                      fresh `npx velvet`, before any external issuer is
//                      configured. Root of trust = whoever can read the
//                      server's terminal. One primitive, two front-ends:
//
//                        challenge -> a single-use code is printed to the
//                                     terminal (and a 0600 file)
//                        redeem    -> present any live code -> admin JWT
//
//                      The MCP /oauth/authorize page is a browser front-end
//                      over the same challenge/redeem; REST hits them directly;
//                      the CLI needs neither (filesystem access *is* admin).
//
// The only durable secret is the signing key. Bootstrap codes are ephemeral
// (3-min TTL, single use) and live in a pulp-db collection keyed by the code
// itself, so redeem is an O(1), strongly-consistent get-and-delete.

const CODE_TTL_MS = 3 * 60 * 1000;
const ACCESS_TTL = '1h';
const ACCESS_TTL_S = 3600;          // seconds — matches ACCESS_TTL, for cookie Max-Age
const REFRESH_TTL = '30d';
const REFRESH_TTL_S = 30 * 24 * 3600;   // matches REFRESH_TTL
const REDEEM_LIMIT_PER_MIN = 20;

// The BFF session cookie: the browser's *only* credential. HttpOnly (invisible
// to JS — the whole point), SameSite=Lax (blocks cross-site state-changing
// sends → CSRF cover), and Secure only under https (else it breaks on
// http://localhost). Its value is the access-token JWT itself (stateless).
const SESSION_COOKIE = 'velvet_session';

// The CSRF token cookie (double-submit, HMAC flavor). Deliberately NOT HttpOnly
// so the SPA can read it and echo it in the X-CSRF-Token header on writes. Its
// value is HMAC(sub) — an attacker can't compute it (no key) nor read it
// (cross-origin), and can't set the header cross-site (CORS preflight), so a
// forged request can't present a matching token. See csrfGuard.
const CSRF_COOKIE = 'velvet_csrf';

// The refresh cookie: long-lived, HttpOnly, and **path-scoped to
// /session/refresh** so it rides only refresh requests, not every API call. Lets
// an active session outlive the short access token without re-login. Never
// reaches page JS.
const REFRESH_COOKIE = 'velvet_refresh';

function base64url(buf) {
    return buf.toString('base64')
            .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function s256(verifier) {
    return base64url(crypto.createHash('sha256').update(verifier).digest());
}

// Persist a 256-bit HS256 key under data/, 0600. Env wins and is not persisted.
async function loadOrCreateKey(rootPath) {
    if (process.env.VELVET_JWT_SECRET) {
        return new TextEncoder().encode(process.env.VELVET_JWT_SECRET);
    }
    const keyPath = pathLib.join(rootPath, 'keys', 'hs256.key');
    try {
        return Buffer.from((await fs.readFile(keyPath, 'utf8')).trim(), 'hex');
    }
    catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const key = crypto.randomBytes(32);
        await fs.mkdir(pathLib.dirname(keyPath), { recursive: true });
        await fs.writeFile(keyPath, key.toString('hex'), { mode: 0o600 });
        return key;
    }
}

export async function registerAuth(fastify,
        { publicUrl, rootPath = 'data', redeemInvite }) {
    const issuer = publicUrl;
    const resource = `${publicUrl}/mcp`;
    const refreshAud = `${publicUrl}/oauth/refresh`;
    const key = await loadOrCreateKey(rootPath);

    // CSRF token = HMAC(sub) under a subkey *derived* from the signing key
    // (domain-separated so it never doubles as a JWT-signing key). Deterministic
    // per session, verified by recomputation — no server-side store.
    const csrfKey = crypto.createHmac('sha256', key)
            .update('velvet-csrf-v1').digest();
    const csrfToken = (sub) =>
            crypto.createHmac('sha256', csrfKey).update(sub).digest('hex');

    // Bootstrap codes: a pulp-db collection keyed by `<code>.json`.
    const codes = pulpDb({}, {
        dataPath: `${rootPath}/bootstrap`,
        indexPath: `${rootPath}/indexes/bootstrap`
    });

    // OAuth authorization codes are seconds-lived, single-exchange: in-memory is
    // fine (a restart mid-handshake just makes the client re-authorize).
    const authCodes = new Map();

    fastify.addContentTypeParser(
            'application/x-www-form-urlencoded',
            { parseAs: 'string' },
            (req, body, done) =>
                    done(null, Object.fromEntries(new URLSearchParams(body))));

    // ---- token minting (stateless: access + refresh are both JWTs) --------

    function sign(claims, sub, audience, ttl) {
        return new SignJWT(claims)
                .setProtectedHeader({ alg: 'HS256' })
                .setSubject(sub)
                .setIssuer(issuer)
                .setAudience(audience)
                .setIssuedAt()
                .setExpirationTime(ttl)
                .sign(key);
    }

    async function issueTokens(sub = 'bootstrap-admin', roles = ['admin']) {
        return {
            access_token: await sign({ typ: 'access', roles }, sub, resource, ACCESS_TTL),
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: await sign({ typ: 'refresh', roles }, sub, refreshAud, REFRESH_TTL),
            scope: 'mcp'
        };
    }

    // ---- bootstrap challenge / redeem (the sole primitive) ----------------

    async function sweepExpired() {
        const now = Date.now();
        const expired = [];
        for await (const r of codes.list()) {
            if (!r.value || r.value.expiresAt <= now) expired.push(r.path);
        }
        await Promise.all(expired.map(
                path => codes.edit(path, (cur, { remove }) => remove())));
    }

    async function mintCode() {
        await sweepExpired();
        const code = crypto.randomBytes(4).toString('hex'); // 8 hex = 32 bits
        await codes.edit(`${code}.json`, () => ({
            createdAt: new Date().toISOString(),
            expiresAt: Date.now() + CODE_TTL_MS
        }));

        // Surface only to the trusted terminal + a 0600 local file. Never over
        // HTTP, never in a log line that ships elsewhere.
        try {
            await fs.mkdir(rootPath, { recursive: true });
            await fs.writeFile(pathLib.join(rootPath, '.bootstrap-code'),
                    code + '\n', { mode: 0o600 });
        }
        catch { /* best-effort convenience file */ }
        printBanner(code);
        return code;
    }

    // Any live code authenticates; consume it (single-use) atomically.
    async function redeemCode(code) {
        if (!/^[0-9a-f]{8}$/.test(code ?? '')) return false;
        let valid = false;
        await codes.edit(`${code}.json`, (cur, { remove }) => {
            if (!cur) return;
            if (cur.expiresAt > Date.now()) valid = true;
            remove();
        });
        return valid;
    }

    const redeemHits = [];
    function rateLimited() {
        const now = Date.now();
        while (redeemHits.length && redeemHits[0] < now - 60_000) {
            redeemHits.shift();
        }
        if (redeemHits.length >= REDEEM_LIMIT_PER_MIN) return true;
        redeemHits.push(now);
        return false;
    }

    // A standalone helper page (not an API door): drives the bootstrap flow so
    // the operator can log the browser in as admin without curling. It requests
    // a code (printed to the terminal), then redeems it via the BFF
    // `/session/bootstrap`, which sets the HttpOnly session cookie — no token
    // ever reaches page JS.
    fastify.get('/admin', { schema: { hide: true } }, async (request, reply) => {
        reply.type('text/html');
        return adminPage();
    });

    fastify.post('/bootstrap/challenge', { schema: { hide: true } },
            async (request, reply) => {
                await mintCode();
                return reply.code(202).send({
                    detail: 'A code was printed to the server terminal. '
                            + 'POST it to /bootstrap/redeem.'
                });
            });

    fastify.post('/bootstrap/redeem', { schema: { hide: true } },
            async (request, reply) => {
                if (rateLimited()) {
                    return reply.code(429).send({ error: 'rate_limited' });
                }
                if (!await redeemCode((request.body ?? {}).code)) {
                    return reply.code(401).send({ error: 'invalid_code' });
                }
                return issueTokens();
            });

    // Invite redemption: trade an invite token for a *non-admin* JWT. The
    // account is created on first redemption (see logic.redeemInvite); the
    // token maps to a stable account thereafter. Public — the token is the
    // credential. REST-only (CLI/MCP are admin interfaces).
    fastify.post('/invites/redeem', { schema: { hide: true } },
            async (request, reply) => {
                if (rateLimited()) {
                    return reply.code(429).send({ error: 'rate_limited' });
                }
                const result = redeemInvite
                        ? await redeemInvite((request.body ?? {}).token)
                        : null;
                if (!result) {
                    return reply.code(401).send({ error: 'invalid_token' });
                }
                // Tokens + the invite's suggested starting path (if any).
                return {
                    ...await issueTokens(result.accountId, []),   // non-admin
                    entrypoint: result.entrypoint
                };
            });

    // ---- Resource Server ---------------------------------------------------

    async function verify(token) {
        const { payload } = await jwtVerify(token, key, {
            issuer,
            audience: resource    // refresh tokens have a different aud -> rejected
        });
        return payload;
    }

    function unauthorized(reply) {
        reply.header('WWW-Authenticate',
                `Bearer resource_metadata=`
                + `"${publicUrl}/.well-known/oauth-protected-resource"`);
        return reply.code(401).send({ error: 'unauthorized' });
    }

    // Resolve a caller's identity without sending anything; null if absent or
    // invalid. Bearer is the API/MCP credential; the session cookie is the
    // browser's — but only honored when the caller opts in (`{ cookie: true }`),
    // so /mcp stays Bearer-only (a cookie there would be a CSRF vector).
    async function authenticate(request, { cookie = false } = {}) {
        const m = /^Bearer (.+)$/i.exec(request.headers.authorization ?? '');
        const token = m ? m[1]
                : (cookie ? request.cookies?.[SESSION_COOKIE] : undefined);
        if (!token) return null;
        try {
            return await verify(token);
        }
        catch {
            return null;
        }
    }

    // Cookie options for setting the session. Secure tracks the public scheme.
    const sessionCookieOpts = () => ({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: issuer.startsWith('https'),
        maxAge: ACCESS_TTL_S
    });
    const refreshCookieOpts = () => ({
        httpOnly: true,
        sameSite: 'lax',
        path: '/session/refresh',   // scoped: sent only to the refresh endpoint
        secure: issuer.startsWith('https'),
        maxAge: REFRESH_TTL_S
    });

    // Establish a session: the HttpOnly access JWT, the readable CSRF token bound
    // to `sub`, and the path-scoped refresh JWT. Called at login *and* on refresh
    // (sliding — the refresh window renews each time).
    const setSession = (reply, { access, refresh, sub }) => {
        reply.setCookie(SESSION_COOKIE, access, sessionCookieOpts());
        reply.setCookie(CSRF_COOKIE, csrfToken(sub),
                { ...sessionCookieOpts(), httpOnly: false });   // JS must read it
        reply.setCookie(REFRESH_COOKIE, refresh, refreshCookieOpts());
    };
    const clearSession = (reply) => {
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        reply.clearCookie(CSRF_COOKIE, { path: '/' });
        reply.clearCookie(REFRESH_COOKIE, { path: '/session/refresh' });
    };

    // onRequest guard for state-changing REST routes (wired in by rest.mjs after
    // attachAuth). CSRF only threatens *cookie-authenticated* writes, so this
    // skips safe methods, Bearer callers (CLI/tools — not browsers), and requests
    // with no session cookie; otherwise it demands X-CSRF-Token == HMAC(sub).
    async function csrfGuard(request, reply) {
        if (request.method === 'GET' || request.method === 'HEAD'
                || request.method === 'OPTIONS') return;
        if (/^Bearer /i.test(request.headers.authorization ?? '')) return;
        if (!request.cookies?.[SESSION_COOKIE]) return;
        const sub = request.auth?.sub;
        if (!sub) return;   // cookie invalid/expired → handler sees no grants anyway
        const provided = request.headers['x-csrf-token'];
        const expected = csrfToken(sub);
        const ok = typeof provided === 'string'
                && provided.length === expected.length
                && crypto.timingSafeEqual(
                        Buffer.from(provided), Buffer.from(expected));
        if (!ok) {
            return reply.code(403).send({
                error: 'csrf', detail: 'missing or invalid CSRF token' });
        }
    }

    async function requireAuth(request, reply) {
        const auth = await authenticate(request);
        if (!auth) return unauthorized(reply);
        request.auth = auth;
    }

    // ---- BFF session surface (the browser's ONLY auth door) ----------------
    // Same core as the Bearer redeem endpoints above, but the access token
    // leaves as an HttpOnly Set-Cookie instead of a JSON body — so the JWT never
    // touches JS-reachable script. The browser never calls /bootstrap/redeem or
    // /invites/redeem (which stay for CLI/CI/native Bearer clients).

    // Admin login: redeem a bootstrap code → session cookie.
    fastify.post('/session/bootstrap', { schema: { hide: true } },
            async (request, reply) => {
                if (rateLimited()) {
                    return reply.code(429).send({ error: 'rate_limited' });
                }
                if (!await redeemCode((request.body ?? {}).code)) {
                    return reply.code(401).send({ error: 'invalid_code' });
                }
                const { access_token, refresh_token } = await issueTokens();
                setSession(reply, { access: access_token,
                        refresh: refresh_token, sub: 'bootstrap-admin' });
                return { ok: true };
            });

    // Invite login: redeem an invite token → non-admin session cookie. Returns
    // only the suggested entrypoint (never the token).
    fastify.post('/session/invite', { schema: { hide: true } },
            async (request, reply) => {
                if (rateLimited()) {
                    return reply.code(429).send({ error: 'rate_limited' });
                }
                const result = redeemInvite
                        ? await redeemInvite((request.body ?? {}).token)
                        : null;
                if (!result) {
                    return reply.code(401).send({ error: 'invalid_token' });
                }
                const { access_token, refresh_token } =
                        await issueTokens(result.accountId, []);
                setSession(reply, { access: access_token,
                        refresh: refresh_token, sub: result.accountId });
                return { entrypoint: result.entrypoint };
            });

    // Who am I? The SPA's replacement for decoding the JWT client-side. Also
    // (re)issues the CSRF cookie, so any live session self-heals a missing one
    // on the SPA's load-time /session fetch.
    fastify.get('/session', { schema: { hide: true } },
            async (request, reply) => {
                const auth = await authenticate(request, { cookie: true });
                if (!auth) return reply.code(401).send({ error: 'unauthenticated' });
                reply.setCookie(CSRF_COOKIE, csrfToken(auth.sub),
                        { ...sessionCookieOpts(), httpOnly: false });
                return {
                    accountId: auth.sub,
                    isAdmin: auth.roles?.includes('admin') ?? false
                };
            });

    // Logout: drop the cookies.
    fastify.delete('/session', { schema: { hide: true } },
            async (request, reply) => {
                clearSession(reply);
                return { ok: true };
            });

    // Refresh: trade the long-lived refresh cookie for a fresh access cookie so
    // an active session outlives the short access token — invisibly, no re-login.
    // Sliding (the refresh window renews too). No CSRF token needed: the refresh
    // cookie is SameSite=Lax + path-scoped, and a forced refresh only renews the
    // victim's *own* session — nothing leaks to an attacker.
    fastify.post('/session/refresh', { schema: { hide: true } },
            async (request, reply) => {
                const rt = request.cookies?.[REFRESH_COOKIE];
                if (!rt) return reply.code(401).send({ error: 'no_refresh' });
                let payload;
                try {
                    ({ payload } = await jwtVerify(rt, key,
                            { issuer, audience: refreshAud }));
                    if (payload.typ !== 'refresh') throw new Error('not refresh');
                }
                catch {
                    clearSession(reply);   // stale/invalid — stop retrying it
                    return reply.code(401).send({ error: 'invalid_refresh' });
                }
                const roles = payload.roles ?? [];
                const { access_token, refresh_token } =
                        await issueTokens(payload.sub, roles);
                setSession(reply, { access: access_token,
                        refresh: refresh_token, sub: payload.sub });
                return {
                    accountId: payload.sub,
                    isAdmin: roles.includes('admin')
                };
            });

    fastify.get('/.well-known/oauth-protected-resource', { schema: { hide: true } },
            async () => ({
                resource,
                authorization_servers: [issuer],
                bearer_methods_supported: ['header']
            }));

    // ---- MCP OAuth front-end over challenge/redeem ------------------------

    fastify.get('/.well-known/oauth-authorization-server', { schema: { hide: true } },
            async () => ({
                issuer,
                authorization_endpoint: `${issuer}/oauth/authorize`,
                token_endpoint: `${issuer}/oauth/token`,
                registration_endpoint: `${issuer}/oauth/register`,
                response_types_supported: ['code'],
                grant_types_supported: ['authorization_code', 'refresh_token'],
                code_challenge_methods_supported: ['S256'],
                token_endpoint_auth_methods_supported: ['none'],
                scopes_supported: ['mcp']
            }));

    fastify.post('/oauth/register', { schema: { hide: true } },
            async (request, reply) => {
                const body = request.body ?? {};
                reply.code(201);
                return {
                    client_id: `velvet_${base64url(crypto.randomBytes(8))}`,
                    token_endpoint_auth_method: 'none',
                    grant_types: ['authorization_code', 'refresh_token'],
                    response_types: ['code'],
                    redirect_uris: body.redirect_uris ?? []
                };
            });

    // GET renders the page AND mints a fresh code (this is the unique request
    // that returns the challenge HTML; favicon/asset noise lands on other
    // routes, so it never mints).
    fastify.get('/oauth/authorize', { schema: { hide: true } },
            async (request, reply) => {
                await mintCode();
                reply.type('text/html');
                return authorizeForm(request.query ?? {}, false);
            });

    fastify.post('/oauth/authorize', { schema: { hide: true } },
            async (request, reply) => {
                const b = request.body ?? {};

                if (rateLimited() || !await redeemCode(b.code)) {
                    await mintCode();          // give them a fresh code to retry
                    reply.code(401).type('text/html');
                    return authorizeForm(b, true);
                }
                if (b.code_challenge_method !== 'S256' || !b.code_challenge) {
                    return reply.code(400).send({ error: 'invalid_request' });
                }

                const authCode = base64url(crypto.randomBytes(24));
                authCodes.set(authCode, {
                    redirectUri: b.redirect_uri,
                    challenge: b.code_challenge,
                    exp: Date.now() + 60_000
                });

                const url = new URL(b.redirect_uri);
                url.searchParams.set('code', authCode);
                if (b.state) url.searchParams.set('state', b.state);
                return reply.redirect(url.toString());
            });

    fastify.post('/oauth/token', { schema: { hide: true } },
            async (request, reply) => {
                const b = request.body ?? {};

                if (b.grant_type === 'authorization_code') {
                    const entry = authCodes.get(b.code);
                    authCodes.delete(b.code);

                    if (!entry || entry.exp < Date.now()) {
                        return reply.code(400).send({ error: 'invalid_grant' });
                    }
                    if (entry.redirectUri !== b.redirect_uri) {
                        return reply.code(400).send({ error: 'invalid_grant',
                                error_description: 'redirect_uri mismatch' });
                    }
                    if (s256(b.code_verifier ?? '') !== entry.challenge) {
                        return reply.code(400).send({ error: 'invalid_grant',
                                error_description: 'PKCE verification failed' });
                    }
                    return issueTokens();
                }

                if (b.grant_type === 'refresh_token') {
                    try {
                        const { payload } = await jwtVerify(
                                b.refresh_token ?? '', key,
                                { issuer, audience: refreshAud });
                        if (payload.typ !== 'refresh') throw new Error('not refresh');
                        return issueTokens(payload.sub, payload.roles ?? ['admin']);
                    }
                    catch {
                        return reply.code(400).send({ error: 'invalid_grant' });
                    }
                }

                return reply.code(400).send({ error: 'unsupported_grant_type' });
            });

    return {
        authenticate,   // best-effort: resolve caller identity, never rejects
        requireAuth,    // onRequest guard for /mcp (401 + WWW-Authenticate)
        challenge: unauthorized,   // send the 401 + WWW-Authenticate response
        csrfGuard,      // onRequest guard for cookie-authenticated REST writes
        async close() { await codes.close(); }
    };
}

function printBanner(code) {
    const pretty = `${code.slice(0, 4)} ${code.slice(4)}`;
    process.stdout.write(
        '\n'
        + '  ┌─ velvet bootstrap ───────────────────────────\n'
        + '  │ A client is requesting admin access.\n'
        + '  │ Enter this code to authorize:\n'
        + '  │\n'
        + `  │     ${pretty}\n`
        + '  │\n'
        + '  │ Expires in 3 minutes. Single use.\n'
        + '  └──────────────────────────────────────────────\n\n');
}

function esc(s = '') {
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function authorizeForm(params, failed) {
    const carry = [
        'client_id', 'redirect_uri', 'state', 'scope', 'resource',
        'code_challenge', 'code_challenge_method', 'response_type'
    ];
    const hidden = carry
            .map(k => `<input type="hidden" name="${k}" value="${esc(params[k])}">`)
            .join('\n');

    return `<!doctype html><html><head><meta charset="utf-8">
<title>Velvet — authorize</title>
<style>body{font:16px system-ui;max-width:24rem;margin:4rem auto;padding:0 1rem}
input[type=text]{width:100%;padding:.5rem;margin:.5rem 0;box-sizing:border-box;
font:1.2rem ui-monospace,monospace;letter-spacing:.1em}
button{padding:.5rem 1rem}.err{color:#b00}</style></head><body>
<h1>Authorize MCP access</h1>
<p>A client wants admin access to this Velvet server. A one-time code was just
printed to the server's terminal — enter it below.</p>
${failed ? '<p class="err">Invalid or expired code. A fresh one was just printed; try again.</p>' : ''}
<form method="post" action="/oauth/authorize">
${hidden}
<label>Code from terminal<input type="text" name="code" autofocus
inputmode="latin" autocomplete="off"></label>
<button type="submit">Authorize</button>
</form></body></html>`;
}

// The /admin bootstrap-login helper page. Two steps: request a code (printed to
// the terminal), then redeem it via the BFF — establishing the session cookie.
function adminPage() {
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>velvet — admin login</title>
<style>
body{font:16px/1.5 system-ui;max-width:26rem;margin:4rem auto;padding:0 1rem}
h1{margin-bottom:.25rem}
p.sub{color:#666;margin-top:0}
button{padding:.55rem 1rem;font:inherit;cursor:pointer}
input{width:100%;padding:.55rem;margin:.5rem 0;box-sizing:border-box;
font:1.3rem ui-monospace,monospace;letter-spacing:.12em;text-align:center}
.step{margin:1.5rem 0}
#status{min-height:1.5rem;color:#666}
.err{color:#b00}.ok{color:#0a0}
a.btn{display:inline-block;text-decoration:none}
</style></head><body>
<h1>velvet</h1>
<p class="sub">Log in as an admin.</p>

<div class="step">
  <button id="request">Request a login code</button>
  <p id="status"></p>
</div>

<div class="step" id="form" hidden>
  <label>Code from the server terminal
    <input id="code" inputmode="latin" autocomplete="off" placeholder="e.g. 48f2 9a1c">
  </label>
  <button id="login">Log in</button>
</div>

<div class="step" id="done" hidden>
  <p class="ok">✓ Logged in as admin.</p>
  <a class="btn" href="/"><button>Continue to velvet →</button></a>
</div>

<script>
const $ = (id) => document.getElementById(id);
const status = (msg, cls) => { const el = $('status'); el.textContent = msg; el.className = cls || ''; };

$('request').addEventListener('click', async () => {
  status('Requesting…');
  const r = await fetch('/bootstrap/challenge', { method: 'POST' });
  if (!r.ok) return status('Could not request a code.', 'err');
  $('form').hidden = false;
  $('code').focus();
  status("A one-time code was printed in the server's terminal — enter it above.");
});

$('login').addEventListener('click', async () => {
  const code = $('code').value.trim().replace(/\\s+/g, '');
  status('Logging in…');
  // BFF: sets the HttpOnly session cookie server-side; no token comes back.
  const r = await fetch('/session/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const body = await r.json().catch(() => ({}));
  if (r.ok && body.ok) {
    $('form').hidden = true;
    $('request').closest('.step').hidden = true;
    $('done').hidden = false;
    status('');
  } else {
    status(body.error === 'rate_limited'
      ? 'Too many attempts — wait a moment and try again.'
      : 'Invalid or expired code.', 'err');
  }
});
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login').click(); });
</script>
</body></html>`;
}
