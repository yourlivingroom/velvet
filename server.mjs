import pathLib from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { registerRest } from './rest.mjs';
import { registerMcp } from './mcp.mjs';
import { registerAuth } from './auth.mjs';
import { registerSpa } from './spa.mjs';

// One process, four doors into the same registry:
//   - REST routes        (registerRest)
//   - OpenAPI + docs UI  (@fastify/swagger, derived from those routes)
//   - MCP endpoint       (registerMcp), guarded by JWT validation
//   - Auth: RS + bootstrap issuer (registerAuth)
export async function startServer({ actions, close, redeemInvite, makeContext }, {
    port = 3000,
    rootPath = 'data'
} = {}) {
    const fastify = Fastify({ logger: true });

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

    const publicUrl = process.env.VELVET_PUBLIC_URL ?? `http://localhost:${port}`;
    const authEnabled = process.env.VELVET_AUTH !== 'off';

    await fastify.register(swagger, {
        openapi: {
            info: { title: 'Velvet', version: '1.0.0' },
            description: 'Self-hosted event management.'
        }
    });
    await fastify.register(swaggerUi, { routePrefix: '/docs' });

    let guard, authenticate, challenge, closeAuth;
    let ctxFor = makeContext;
    if (authEnabled) {
        const auth = await registerAuth(fastify,
                { publicUrl, rootPath, redeemInvite });
        guard = auth.requireAuth;
        authenticate = auth.authenticate;
        challenge = auth.challenge;
        closeAuth = auth.close;
    }
    else {
        // Dev mode: no guards, and every caller is admin (grants `**`).
        fastify.log.warn('VELVET_AUTH=off; /mcp is UNAUTHENTICATED and all '
                + 'callers are treated as admin.');
        ctxFor = () => makeContext({ roles: ['admin'] });
    }

    registerRest(fastify, actions,
            { authenticate, challenge, makeContext: ctxFor });
    registerMcp(fastify, actions,
            { path: '/mcp', onRequest: guard, makeContext: ctxFor });

    // The built React client (if present), content-negotiated onto the API
    // URLs. In `--dev` the Vite dev server serves the client and proxies here,
    // so the backend stays API-only.
    const dev = process.env.VELVET_DEV === '1';
    if (!dev) {
        const clientDist = pathLib.join(
                pathLib.dirname(fileURLToPath(import.meta.url)), 'client', 'dist');
        await registerSpa(fastify, { clientDist });
    }

    fastify.addHook('onClose', async () => {
        await close();
        if (closeAuth) await closeAuth();
    });

    try {
        await fastify.listen({ port, host: '0.0.0.0' });
    }
    catch (e) {
        fastify.log.error(e);
        await close();
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
