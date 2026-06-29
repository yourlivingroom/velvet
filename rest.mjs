import { splitInput } from './bind.mjs';

// Project the action registry onto Fastify routes. Each action's input schema
// becomes the route's params/body/querystring schema, which (a) gives us
// validation for free and (b) is what @fastify/swagger reads to emit OpenAPI.
//
// requireAdmin actions get the admin guard attached as an onRequest hook. If no
// guard is supplied (auth disabled), those routes are left open (dev mode).
export function registerRest(fastify, actions, { requireAdmin } = {}) {
    for (const [name, action] of Object.entries(actions)) {
        const { method, path } = action.http;
        const { pathProps, restProps, requiredPath, requiredRest } =
                splitInput(action);
        const isWrite = method !== 'GET';

        const schema = { summary: action.summary, operationId: name };

        if (Object.keys(pathProps).length) {
            schema.params = {
                type: 'object',
                properties: pathProps,
                required: requiredPath
            };
        }

        if (Object.keys(restProps).length || isWrite) {
            const restSchema = {
                type: 'object',
                additionalProperties: false,
                properties: restProps,
                required: requiredRest
            };
            if (isWrite) schema.body = restSchema;
            else schema.querystring = restSchema;
        }

        fastify.route({
            method,
            url: path,
            schema,
            ...(action.requireAdmin && requireAdmin
                    ? { onRequest: requireAdmin } : {}),
            handler: async (request, reply) => {
                const input = {
                    ...request.params,
                    ...(isWrite ? request.body : request.query)
                };

                const result = await action.handler(input);

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
