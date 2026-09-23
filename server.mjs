import fs from 'fs';
import pathLib from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { registerRest } from './rest.mjs';
import { registerMcp } from './mcp.mjs';
import { registerAuth } from './auth.mjs';
import { registerBlobs } from './blobs.mjs';
import { registerSpa } from './spa.mjs';

// One process, four doors into the same registry:
//   - REST routes        (registerRest)
//   - OpenAPI + docs UI  (@fastify/swagger, derived from those routes)
//   - MCP endpoint       (registerMcp), guarded by JWT validation
//   - Auth: RS + bootstrap issuer (registerAuth)
//
// Assemble the whole app onto a Fastify instance but DON'T bind a port — so
// tests can drive it with fastify.inject() (no socket, no port conflict with a
// running --dev server). startServer() is this plus listen() + the banner.
export async function buildServer(
    { actions, close, redeemInvite, makeContext, backfillEventMembers }, {
        port = 3000,
        rootPath = 'data',
        logger = true
    } = {}) {
    const fastify = Fastify({ logger });

    // Shared URLs are content-negotiated on `Accept` — the SPA shell and the
    // JSON API live at the same paths (see spa.mjs). Advertise that to caches so
    // a fetch's cached JSON is never replayed for a browser navigation to the
    // same URL (which showed the raw event JSON on a back-navigation). Added
    // before the routes so it covers every response. Registered first so it runs
    // for all routes regardless of their own registration order.
    fastify.addHook('onSend', async (req, reply, payload) => {
        const existing = reply.getHeader('vary');
        if (!existing) reply.header('vary', 'Accept');
        else if (!/(^|,\s*)accept(\s*,|$)/i.test(existing)) {
            reply.header('vary', `${existing}, Accept`);
        }
        return payload;
    });

    // Cookie parsing (request.cookies) + setting (reply.setCookie). The BFF
    // session cookie (auth.mjs) is the browser's only credential; no signing
    // secret needed — its value is a self-authenticating JWT.
    await fastify.register(cookie);

    const publicUrl = process.env.VELVET_PUBLIC_URL ?? `http://localhost:${port}`;
    const authEnabled = process.env.VELVET_AUTH !== 'off';

    await fastify.register(swagger, {
        openapi: {
            info: { title: 'Velvet', version: '1.0.0' },
            description: 'Self-hosted event management.'
        }
    });
    await fastify.register(swaggerUi, { routePrefix: '/docs' });

    let guard, authenticate, challenge, csrfGuard, closeAuth;
    let ctxFor = makeContext;
    if (authEnabled) {
        const auth = await registerAuth(fastify,
                { publicUrl, rootPath, redeemInvite });
        guard = auth.requireAuth;
        authenticate = auth.authenticate;
        challenge = auth.challenge;
        csrfGuard = auth.csrfGuard;
        closeAuth = auth.close;
    }
    else {
        // Dev mode: no guards, and every caller is admin (grants `**`).
        fastify.log.warn('VELVET_AUTH=off; /mcp is UNAUTHENTICATED and all '
                + 'callers are treated as admin.');
        ctxFor = () => makeContext({ roles: ['admin'] });
    }

    registerRest(fastify, actions,
            { authenticate, challenge, csrfGuard, makeContext: ctxFor });
    registerMcp(fastify, actions,
            { path: '/mcp', onRequest: guard, makeContext: ctxFor });

    // Binary storage: permissioned buckets + the resumable upload/download
    // protocol JSON refers to via `{ $blob }`. A REST-native surface (like auth),
    // not registry actions. Cookie-auth + CSRF for writes ride the same guards.
    await registerBlobs(fastify,
            { authenticate, csrfGuard, makeContext: ctxFor, rootPath });

    // Operator theme override: an optional data/theme.css served *after* the
    // SPA's base theme so an operator reskins the app without a rebuild (see
    // CLAUDE.md → Frontend → Theming). Empty when absent. Registered
    // unconditionally so it works in --dev too (Vite proxies /theme.css here);
    // no-cache so a dropped-in file shows up on the next reload.
    const themeFile = pathLib.join(rootPath, 'theme.css');
    fastify.get('/theme.css', { schema: { hide: true } }, async (request, reply) => {
        reply.type('text/css').header('cache-control', 'no-cache');
        try {
            return await fs.promises.readFile(themeFile, 'utf8');
        }
        catch (e) {
            if (e.code === 'ENOENT') return '';   // no operator theme yet
            throw e;
        }
    });

    // The built React client (if present), content-negotiated onto the API
    // URLs. In `--dev` the Vite dev server serves the client and proxies here,
    // so the backend stays API-only.
    const dev = process.env.VELVET_DEV === '1';
    if (!dev) {
        const clientDist = pathLib.join(
                pathLib.dirname(fileURLToPath(import.meta.url)), 'client', 'dist');
        await registerSpa(fastify, { clientDist });
    }

    // One-time reconciliation: rebuild event.members from account grants so
    // events predating the byUser index still list for their participants.
    // Idempotent, so it's safe to run every boot.
    if (backfillEventMembers) await backfillEventMembers();

    fastify.addHook('onClose', async () => {
        await close();
        if (closeAuth) await closeAuth();
    });

    return fastify;
}

// The runnable server: build the app, then bind the port and point the operator
// at the login page.
export async function startServer(logic, opts = {}) {
    const { port = 3000 } = opts;
    const fastify = await buildServer(logic, opts);

    const publicUrl = process.env.VELVET_PUBLIC_URL ?? `http://localhost:${port}`;
    const authEnabled = process.env.VELVET_AUTH !== 'off';
    const dev = process.env.VELVET_DEV === '1';

    try {
        await fastify.listen({ port, host: '0.0.0.0' });
    }
    catch (e) {
        fastify.log.error(e);
        await logic.close();
        process.exit(1);
    }

    // A friendly pointer for the operator — straight into logging in as admin.
    // (In --dev the supervisor prints the dev URLs instead.)
    if (!dev) {
        process.stdout.write('\n  velvet is running.\n'
                + (authEnabled
                    ? `  Log in as admin:  ${publicUrl}/admin\n\n`
                    : '  VELVET_AUTH=off — every caller is admin (no login needed).\n\n'));
    }

    return fastify;
}
