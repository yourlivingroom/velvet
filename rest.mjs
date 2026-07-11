import { splitInput } from './bind.mjs';
import { ClientError } from './errors.mjs';

// Project the action registry onto Fastify routes. Each action's input schema
// becomes the route's params/body/querystring schema, which (a) gives us
// validation for free and (b) is what @fastify/swagger reads to emit OpenAPI.
//
// requireAdmin actions get the admin guard attached as an onRequest hook (loud:
// 401 anon / 403 non-admin). Every *other* route best-effort authenticates so
// the handler still learns who's calling — that's how a handler can quietly
// 404 the unauthorized (hide existence) rather than challenge them.
export function registerRest(fastify, actions,
        { requireAdmin, authenticate, isAdmin = () => false } = {}) {
    // Populate request.auth from the Bearer token if present; never rejects.
    const attachAuth = authenticate
            ? async (request) => { request.auth = await authenticate(request); }
            : null;

    // Register a JSON parser for every custom payload media type an action
    // declares (e.g. application/json-patch+json), which Fastify won't parse
    // out of the box.
    const registered = new Set();
    for (const action of Object.values(actions)) {
        const mt = action.http.mediaType;
        if (mt && mt !== 'application/json' && !registered.has(mt)) {
            registered.add(mt);
            fastify.addContentTypeParser(mt, { parseAs: 'string' },
                    (req, body, done) => {
                        try {
                            done(null, body === '' ? undefined : JSON.parse(body));
                        }
                        catch (e) {
                            e.statusCode = 400;
                            done(e);
                        }
                    });
        }
    }

    for (const [name, action] of Object.entries(actions)) {
        const { method, path } = action.http;
        const { pathProps, restProps, requiredPath, requiredRest } =
                splitInput(action);
        const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);

        // A payload action carries its input as a single top-level value: the
        // request body *is* that property's bare value (e.g. a JSON Patch ops
        // array), not an object of named properties.
        const bodyProp = action.payload;

        const schema = { summary: action.summary, operationId: name };

        if (Object.keys(pathProps).length) {
            schema.params = {
                type: 'object',
                properties: pathProps,
                required: requiredPath
            };
        }

        if (bodyProp) {
            schema.body = action.input.properties[bodyProp];
            // Advertise the idiomatic media type in OpenAPI (we also accept
            // plain application/json leniently).
            if (action.http.mediaType) {
                schema.consumes = [action.http.mediaType, 'application/json'];
            }
        }
        else if (Object.keys(restProps).length) {
            const restSchema = {
                type: 'object',
                additionalProperties: false,
                properties: restProps,
                required: requiredRest
            };
            if (hasBody) schema.body = restSchema;
            else schema.querystring = restSchema;   // GET (DELETE here has none)
        }

        const onRequest = action.requireAdmin && requireAdmin
                ? requireAdmin
                : attachAuth;

        fastify.route({
            method,
            url: path,
            schema,
            ...(onRequest ? { onRequest } : {}),
            handler: async (request, reply) => {
                const input = { ...request.params };
                if (bodyProp) {
                    input[bodyProp] = request.body;
                }
                else {
                    Object.assign(input, hasBody ? request.body : request.query);
                }

                const ctx = {
                    auth: request.auth ?? null,
                    isAdmin: isAdmin(request.auth)
                };

                let result;
                try {
                    result = await action.handler(input, ctx);
                }
                catch (e) {
                    if (e instanceof ClientError) {
                        reply.code(e.statusCode);
                        return { error: e.message };
                    }
                    throw e;
                }

                // Convention: a handler returning null means "not found".
                if (result === null) {
                    reply.code(404);
                    return { error: 'Not found' };
                }

                return result;
            }
        });
    }
}
