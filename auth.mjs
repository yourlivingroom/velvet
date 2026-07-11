import crypto from 'crypto';
import fs from 'fs/promises';
import pathLib from 'path';
import pulpDb from '@livingroom/pulp-db';
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
const REFRESH_TTL = '30d';
const REDEEM_LIMIT_PER_MIN = 20;

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
        const rows = await codes.list();
        await Promise.all(rows
                .filter(r => !r.value || r.value.expiresAt <= now)
                .map(r => codes.edit(r.path, (cur, { delete: del }) => {
                    if (cur) del();
                })));
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
        await codes.edit(`${code}.json`, (cur, { delete: del }) => {
            if (!cur) return;
            if (cur.expiresAt > Date.now()) valid = true;
            del();
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

    // REST front-end: no browser, no PKCE — terminal possession is the proof.
    // A standalone helper page (not an API door): drives the bootstrap flow so
    // the operator can log the browser in as admin without curling. It requests
    // a code (printed to the terminal), redeems it, and stashes the admin JWT in
    // localStorage for the SPA to use.
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
    // invalid. Both guards build on this.
    async function authenticate(request) {
        const m = /^Bearer (.+)$/i.exec(request.headers.authorization ?? '');
        if (!m) return null;
        try {
            return await verify(m[1]);
        }
        catch {
            return null;
        }
    }

    async function requireAuth(request, reply) {
        const auth = await authenticate(request);
        if (!auth) return unauthorized(reply);
        request.auth = auth;
    }

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
// the terminal), then redeem it — storing the admin JWT for the SPA.
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
  const r = await fetch('/bootstrap/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const body = await r.json().catch(() => ({}));
  if (r.ok && body.access_token) {
    localStorage.setItem('velvet.accessToken', body.access_token);
    if (body.refresh_token) localStorage.setItem('velvet.refreshToken', body.refresh_token);
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
