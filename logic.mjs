import crypto from 'crypto';
import pulpDb from '@livingroom/pulp-db';
import jsonpatch from 'fast-json-patch';
import { ClientError } from './errors.mjs';

const { applyPatch } = jsonpatch;

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

    const events = pulpDb({}, {
        dataPath: `${rootPath}/events`,
        indexPath: `${rootPath}/indexes/events`
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
            },
            async deleteDoc(id) {
                let deleted = null;
                await store.edit(`${id}.json`, (draft, { delete: del }) => {
                    if (draft === undefined) return;
                    deleted = JSON.parse(JSON.stringify(draft)); // plain snapshot
                    del();
                });
                return deleted;
            }
        };
    }

    const inviteCol = collection(invites, 'nvt');
    const sessionCol = collection(sessions, 'sssn');
    const eventCol = collection(events, 'evt');

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
        },

        // Events. The stored doc separates OUR metadata (top-level: id,
        // createdAt, later permissions) from the USER's `config` — an arbitrary
        // JSON document. Only `config` is user-editable, and only via JSON Patch.
        'events.create': {
            summary: 'Create a new event.',
            requireAdmin: true,
            http: { method: 'POST', path: '/events' },
            input: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    config: {
                        type: 'object',
                        additionalProperties: true,
                        description: 'Initial user config document.'
                    }
                }
            },
            handler: ({ config }) => eventCol.createDoc({ config: config ?? {} })
        },

        'events.get': {
            summary: 'Fetch a single event by id.',
            http: { method: 'GET', path: '/events/:eventId' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' }
                }
            },
            handler: ({ eventId }) => eventCol.getDoc(eventId)
        },

        'events.getConfig': {
            summary: "Fetch just an event's config document.",
            http: { method: 'GET', path: '/events/:eventId/config' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' }
                }
            },
            handler: async ({ eventId }) => {
                const event = await eventCol.getDoc(eventId);
                return event === null ? null : event.config;
            }
        },

        'events.list': {
            summary: 'List all events.',
            requireAdmin: true,
            http: { method: 'GET', path: '/events' },
            input: { type: 'object', additionalProperties: false, properties: {} },
            handler: () => eventCol.listDocs()
        },

        'events.delete': {
            summary: 'Delete an event.',
            requireAdmin: true,
            http: { method: 'DELETE', path: '/events/:eventId' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' }
                }
            },
            handler: ({ eventId }) => eventCol.deleteDoc(eventId)
        },

        'events.patch': {
            summary: "Edit an event's config via JSON Patch (RFC 6902).",
            description: 'Applies a JSON Patch document to the event config. The '
                    + 'endpoint is /events/:eventId/config, so paths are '
                    + 'relative to the config root; our metadata is not '
                    + 'reachable. Returns the updated event, or null if no such '
                    + 'event.',
            requireAdmin: true,
            // `patch` is this action's *payload* — a single top-level value,
            // not one named field among several. Each interface renders that
            // naturally: REST puts it in the request body (as the mediaType
            // below), the CLI takes it as the trailing positional, MCP passes
            // it by name. `eventId` remains addressing (a path param).
            payload: 'patch',
            http: {
                method: 'PATCH', path: '/events/:eventId/config',
                mediaType: 'application/json-patch+json'
            },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId', 'patch'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' },
                    patch: {
                        type: 'array',
                        description: 'JSON Patch operations (RFC 6902).',
                        items: {
                            type: 'object',
                            required: ['op', 'path'],
                            additionalProperties: false,
                            properties: {
                                op: {
                                    type: 'string',
                                    enum: ['add', 'remove', 'replace',
                                            'move', 'copy', 'test']
                                },
                                path: { type: 'string' },
                                from: { type: 'string' },
                                value: {}   // arbitrary JSON
                            }
                        }
                    }
                }
            },
            handler: async ({ eventId, patch }) => {
                let found = true;
                const { newValue } = await events.edit(`${eventId}.json`,
                        (draft) => {
                            if (draft === undefined) { found = false; return; }
                            // Patch a plain clone of config so root ops ("") and
                            // move/copy behave per spec, then assign it back.
                            const clone = JSON.parse(
                                    JSON.stringify(draft.config ?? {}));
                            let results;
                            try {
                                results = applyPatch(clone, patch, true, true);
                            }
                            catch (e) {
                                // fast-json-patch messages are multi-line; the
                                // first line is the useful part.
                                throw new ClientError('Invalid JSON Patch: '
                                        + e.message.split('\n')[0], 422);
                            }
                            draft.config = results.length
                                    ? results[results.length - 1].newDocument
                                    : clone;
                        });
                return found ? newValue : null;
            }
        }
    };

    return {
        actions,
        async close() {
            await invites.close();
            await sessions.close();
            await events.close();
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
