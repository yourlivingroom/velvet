import { toMcpTool } from './bind.mjs';

// A minimal, stateless MCP server projected straight off the registry. MCP is
// JSON-RPC 2.0; over the Streamable-HTTP transport the client POSTs requests to
// a single endpoint. In stateless "application/json" mode we just answer each
// POST with its JSON-RPC response — no session bookkeeping.
//
// tools/list and tools/call are literally the registry. That's the whole point:
// adding an action to logic.mjs adds an MCP tool with zero MCP-specific code.
//
// NOTE: connecting this to claude.ai as a custom connector additionally
// requires OAuth 2.1 in front of /mcp (claude.ai will not attach to an
// unauthenticated remote server). The protocol surface below is complete; only
// the auth layer is left to add.

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const FORBIDDEN = -32002;

export function registerMcp(fastify, actions, {
    path = '/mcp',
    serverInfo = { name: 'velvet', version: '1.0.0' },
    onRequest,         // optional Fastify guard (e.g. requireAuth)
    isAdmin = () => true   // resolve admin-ness of request.auth; open by default
} = {}) {
    const tools = Object.entries(actions).map(([n, a]) => toMcpTool(n, a));

    async function handle(message, isAdminCaller) {
        const { id, method, params } = message;
        const ok = result => ({ jsonrpc: '2.0', id, result });
        const err = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

        switch (method) {
            case 'initialize':
                return ok({
                    protocolVersion:
                            params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo
                });

            case 'tools/list':
                // Don't advertise admin tools to non-admin callers.
                return ok({
                    tools: tools.filter(t =>
                            !actions[t.name].requireAdmin || isAdminCaller)
                });

            case 'tools/call': {
                const action = actions[params?.name];
                if (!action) {
                    return err(-32602, `Unknown tool: ${params?.name}`);
                }
                if (action.requireAdmin && !isAdminCaller) {
                    return err(FORBIDDEN, 'Forbidden: admin role required');
                }
                try {
                    const out = await action.handler(params.arguments ?? {});
                    return ok({
                        content: [
                            { type: 'text', text: JSON.stringify(out, null, 2) }
                        ]
                    });
                }
                catch (e) {
                    // Tool errors are reported in-band (isError), not as
                    // JSON-RPC protocol errors.
                    return ok({
                        isError: true,
                        content: [{ type: 'text', text: String(e?.message ?? e) }]
                    });
                }
            }

            case 'ping':
                return ok({});

            default:
                return err(-32601, `Method not found: ${method}`);
        }
    }

    const isNotification = m => m && m.id === undefined;

    fastify.post(path, { ...(onRequest ? { onRequest } : {}) }, async (request, reply) => {
        const body = request.body;
        const isAdminCaller = isAdmin(request.auth);

        // Batched requests.
        if (Array.isArray(body)) {
            const responses = [];
            for (const m of body) {
                if (!isNotification(m)) {
                    responses.push(await handle(m, isAdminCaller));
                }
            }
            return responses.length ? responses : reply.code(202).send();
        }

        // A lone notification (e.g. notifications/initialized) gets just a 202.
        if (isNotification(body)) {
            return reply.code(202).send();
        }

        return handle(body, isAdminCaller);
    });
}
