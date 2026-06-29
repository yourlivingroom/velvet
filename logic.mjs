import crypto from 'crypto';
import pulpDb from '@livingroom/pulp-db';

// The single source of truth for what velvet can do.
//
// Each action is a self-describing descriptor:
//
//   {
//     summary, description,        // human text (CLI help, MCP/OpenAPI docs)
//     http: { method, path },      // REST binding; `:name` segments are path
//                                  //   params, drawn from `input` properties
//     input:  <JSON Schema>,       // a FLAT object of scalars/arrays, so it
//                                  //   renders losslessly to CLI flags, an
//                                  //   HTTP body/query, and an MCP toolschema
//     output: <JSON Schema>,       // optional, for docs/result hints
//     handler: async (input, ctx) // the actual work
//   }
//
// The three interfaces (cli.mjs, the REST server, the MCP server) are thin
// adapters that consume this registry; no interface hand-writes an action.

export default function velvetLogic(rootPath = 'data') {
    const invites = pulpDb({}, {
        dataPath: `${rootPath}/invites`,
        indexPath: `${rootPath}/indexes/invites`
    });

    const sessions = pulpDb({}, {
        dataPath: `${rootPath}/sessions`,
        indexPath: `${rootPath}/indexes/sessions`
    });

    function collection(store, prefix) {
        return {
            async createDoc(extra) {
                const id = randomId(prefix);
                const { newValue } = await store.edit(`${id}.json`, () => ({
                    id,
                    createdAt: new Date().toISOString(),
                    ...extra
                }));
                return newValue;
            },
            async getDoc(id) {
                return (await store.get(`${id}.json`)) ?? null;
            },
            async listDocs() {
                const rows = await store.list();
                return rows.map(r => r.value);
            }
        };
    }

    const inviteCol = collection(invites, 'nvt');
    const sessionCol = collection(sessions, 'sssn');

    const actions = {
        'invites.create': {
            summary: 'Create a new invite.',
            requireAdmin: true,
            http: { method: 'POST', path: '/invites' },
            input: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    email: {
                        type: 'string',
                        description: 'Address to invite (optional).'
                    },
                    note: {
                        type: 'string',
                        description: 'Freeform note stored on the invite.'
                    }
                }
            },
            handler: ({ email, note }) =>
                    inviteCol.createDoc(stripUndefined({ email, note }))
        },

        'invites.get': {
            summary: 'Fetch a single invite by id.',
            http: { method: 'GET', path: '/invites/:id' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: {
                    id: { type: 'string', description: 'Invite id.' }
                }
            },
            handler: ({ id }) => inviteCol.getDoc(id)
        },

        'invites.list': {
            summary: 'List all invites.',
            requireAdmin: true,
            http: { method: 'GET', path: '/invites' },
            input: { type: 'object', additionalProperties: false, properties: {} },
            handler: () => inviteCol.listDocs()
        },

        'sessions.create': {
            summary: 'Create a new session.',
            requireAdmin: true,
            http: { method: 'POST', path: '/sessions' },
            input: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    inviteId: {
                        type: 'string',
                        description: 'Invite this session belongs to (optional).'
                    }
                }
            },
            handler: ({ inviteId }) =>
                    sessionCol.createDoc(stripUndefined({ inviteId }))
        },

        'sessions.get': {
            summary: 'Fetch a single session by id.',
            http: { method: 'GET', path: '/sessions/:id' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: {
                    id: { type: 'string', description: 'Session id.' }
                }
            },
            handler: ({ id }) => sessionCol.getDoc(id)
        },

        'sessions.list': {
            summary: 'List all sessions.',
            requireAdmin: true,
            http: { method: 'GET', path: '/sessions' },
            input: { type: 'object', additionalProperties: false, properties: {} },
            handler: () => sessionCol.listDocs()
        }
    };

    return {
        actions,
        async close() {
            await invites.close();
            await sessions.close();
        }
    };
}

function randomId(prefix) {
    return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function stripUndefined(obj) {
    return Object.fromEntries(
            Object.entries(obj).filter(([, v]) => v !== undefined));
}
