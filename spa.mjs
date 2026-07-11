import fs from 'fs';
import pathLib from 'path';
import fastifyStatic from '@fastify/static';

// Serve a built Vite/React SPA off the SAME URLs as the API, negotiated by the
// `Accept` header:
//   - a browser navigation (Accept: text/html) to a non-server path gets the
//     app shell — so RESTful URLs double as client routes;
//   - an API client (our fetch sends Accept: application/json; curl sends */*)
//     falls through to the JSON route handler.
//
// No-op if the client isn't built yet (dev / API-only). Register AFTER the API
// routes and auth so its onRequest/notFound only affect what's left.

// Paths that are the server's own surface — never the SPA. `/admin` is the
// standalone bootstrap-login helper page, not a client route.
const NON_SPA = [/^\/mcp/, /^\/oauth/, /^\/bootstrap/, /^\/\.well-known/,
        /^\/docs/, /^\/assets/, /^\/admin(?:\/|$)/];

export async function registerSpa(fastify, { clientDist }) {
    const indexPath = pathLib.join(clientDist, 'index.html');
    if (!fs.existsSync(indexPath)) {
        fastify.log.warn(`No client build at ${clientDist} — serving API only. `
                + '(cd client && npm install && npm run build)');
        return false;
    }

    const indexHtml = fs.readFileSync(indexPath, 'utf8');

    // Serve the real build files by path (wildcard:false → one route per file,
    // no catch-all that would swallow API routes or the SPA fallback).
    await fastify.register(fastifyStatic, {
        root: clientDist, prefix: '/', wildcard: false, index: false
    });

    // Is this a browser navigation we should answer with the app shell?
    const isSpaNav = (req) =>
            req.method === 'GET'
            && (req.headers.accept ?? '').includes('text/html')
            && !NON_SPA.some(re => re.test(req.url.split('?')[0]));

    // Browser navigations to real API routes (e.g. GET /events): short-circuit
    // before the JSON handler and hand back the shell.
    fastify.addHook('onRequest', async (req, reply) => {
        if (isSpaNav(req)) return reply.type('text/html').send(indexHtml);
    });

    // Browser navigations to client-only routes (no server route): the shell.
    // Everything else keeps the normal JSON 404.
    fastify.setNotFoundHandler((req, reply) =>
            isSpaNav(req)
                    ? reply.type('text/html').send(indexHtml)
                    : reply.code(404).send({ error: 'Not found' }));

    fastify.log.info(`Serving SPA from ${clientDist}`);
    return true;
}
