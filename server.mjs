import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { registerRest } from './rest.mjs';
import { registerMcp } from './mcp.mjs';
import { registerAuth } from './auth.mjs';

// One process, four doors into the same registry:
//   - REST routes        (registerRest)
//   - OpenAPI + docs UI  (@fastify/swagger, derived from those routes)
//   - MCP endpoint       (registerMcp), guarded by JWT validation
//   - Auth: RS + bootstrap issuer (registerAuth)
export async function startServer({ actions, close }, {
    port = 3000,
    rootPath = 'data'
} = {}) {
    const fastify = Fastify({ logger: true });

    const publicUrl = process.env.VELVET_PUBLIC_URL ?? `http://localhost:${port}`;
    const authEnabled = process.env.VELVET_AUTH !== 'off';

    await fastify.register(swagger, {
        openapi: {
            info: { title: 'Velvet', version: '1.0.0' },
            description: 'Self-hosted event management.'
        }
    });
    await fastify.register(swaggerUi, { routePrefix: '/docs' });

    let guard, requireAdmin, isAdmin, closeAuth;
    if (authEnabled) {
        const auth = await registerAuth(fastify, { publicUrl, rootPath });
        guard = auth.requireAuth;
        requireAdmin = auth.requireAdmin;
        isAdmin = auth.isAdmin;
        closeAuth = auth.close;
    }
    else {
        // Dev mode: no guards, and every caller counts as admin.
        fastify.log.warn('VELVET_AUTH=off; /mcp is UNAUTHENTICATED and all '
                + 'callers are treated as admin.');
        isAdmin = () => true;
    }

    registerRest(fastify, actions, { requireAdmin });
    registerMcp(fastify, actions, { path: '/mcp', onRequest: guard, isAdmin });

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

    return fastify;
}
