import crypto from 'crypto';
import pulpDb from '@livingroom/pulp-db';
import jsonpatch from 'fast-json-patch';
import { ClientError } from './errors.mjs';
import { can } from './permissions.mjs';

const { applyPatch } = jsonpatch;

// Index invites by their secret token so redemption can look one up. Defined
// once, materialized per context: the server keeps a live cardcatalog/LevelDB
// index (eventually consistent, watched); a short-lived CLI answers the same
// query by scanning on demand. Same query API either way.
const INVITE_INDEXES = {
    byToken: {
        process(fileContent, emit) {
            const doc = JSON.parse(fileContent);
            if (doc.token) emit(doc.token, doc.id);
        }
    }
};

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

// The long-running server keeps live indexes (inline:false); short-lived,
// filesystem-trust callers like the CLI pass inline:true so they answer index
// queries by scanning and never grab the LevelDB lock — letting them run beside
// a live server on the same data dir.
export default function velvetLogic(rootPath = 'data', { inline = false } = {}) {
    const invites = pulpDb(INVITE_INDEXES, {
        dataPath: `${rootPath}/invites`,
        indexPath: `${rootPath}/indexes/invites`,
        inline
    });

    const sessions = pulpDb({}, {
        dataPath: `${rootPath}/sessions`,
        indexPath: `${rootPath}/indexes/sessions`,
        inline
    });

    const events = pulpDb({}, {
        dataPath: `${rootPath}/events`,
        indexPath: `${rootPath}/indexes/events`,
        inline
    });

    // Accounts: non-admin identities, auto-created when an invite token is
    // first redeemed (see redeemInvite). A JWT's `sub` is an account id.
    const accounts = pulpDb({}, {
        dataPath: `${rootPath}/accounts`,
        indexPath: `${rootPath}/indexes/accounts`,
        inline
    });

    // Reservations: one RSVP per (event, account), keyed `<eventId>~<accountId>`.
    const reservations = pulpDb({}, {
        dataPath: `${rootPath}/reservations`,
        indexPath: `${rootPath}/indexes/reservations`,
        inline
    });

    function collection(store, prefix) {
        return {
            async createDoc(extra, opts = {}) {
                const id = randomId(prefix);
                const { newValue } = await store.edit(`${id}.json`, () => ({
                    id,
                    createdAt: new Date().toISOString(),
                    ...extra
                }), opts);
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
    const accountCol = collection(accounts, 'acct');

    // Resolve a caller's grants (glob patterns). Admins (and the CLI) get `**`;
    // a redeemed account gets whatever grants its invite conferred; anyone else
    // gets nothing. Looked up per-request from the account store, so grants stay
    // revocable rather than frozen into the JWT.
    async function resolveGrants(auth) {
        if (!auth) return [];
        if (auth.roles?.includes('admin')) return ['**'];
        if (auth.sub) {
            const account = await accountCol.getDoc(auth.sub);
            return account?.grants ?? [];
        }
        return [];
    }

    // Build the ctx handlers receive: identity + resolved permissions. `can` is
    // the quiet check (caller decides how to react); `assertPermission` is the
    // loud one (403 via ClientError).
    async function makeContext(auth) {
        const grants = await resolveGrants(auth);
        return {
            auth: auth ?? null,
            isAdmin: auth?.roles?.includes('admin') ?? false,
            grants,
            can: (path) => can(grants, path),
            assertPermission: (path) => {
                if (!can(grants, path)) {
                    throw new ClientError(
                            `Forbidden: no permission for ${path}`, 403);
                }
            }
        };
    }

    // You may act on your own account, or on any account if you're an admin.
    function ownAccountOrAdmin(accountId, ctx) {
        return ctx.can('/server/admin') || accountId === ctx.auth?.sub;
    }

    // Resolve which (event, account) a reservation op targets, and authorize it.
    // Returns { acctId, key } or null (→ 404: no join permission, or no such
    // event — both hidden). Throws ClientError (403/400) for a caller trying to
    // touch someone else's reservation without admin, or with no account at all.
    async function reservationTarget(eventId, inputAccountId, ctx) {
        if (!ctx.can(`/events/${eventId}/join`)) return null;   // 404: hide

        const acctId = inputAccountId ?? ctx.auth?.sub;
        if (!acctId) {
            throw new ClientError(
                    'No account in context; specify accountId.', 400);
        }
        if (acctId !== ctx.auth?.sub && !ctx.can('/server/admin')) {
            throw new ClientError('Forbidden: not your reservation.', 403);
        }
        if (await eventCol.getDoc(eventId) === null) return null;   // 404

        return { acctId, key: `${eventId}~${acctId}` };
    }

    // Synthesize the guest list (RSVPs) for events, grouped by event id, in one
    // scan of the reservations (+ one of accounts, for names). Used to fold
    // "who's coming" into event reads.
    async function guestListsByEvent() {
        const [rows, accts] = await Promise.all([
            reservations.list(), accountCol.listDocs()
        ]);
        const nameById = new Map(accts.map(a => [a.id, a.name]));
        const byEvent = new Map();
        for (const { value } of rows) {
            if (!value?.eventId) continue;
            if (!byEvent.has(value.eventId)) byEvent.set(value.eventId, []);
            byEvent.get(value.eventId).push({
                id: value.accountId,
                name: nameById.get(value.accountId),
                response: value.response,
                guests: value.guests ?? []
            });
        }
        return byEvent;
    }

    // Redeem an invite by its secret token, via the byToken index (materialized
    // on-demand — see INVITE_INDEXES). (future: reject here if expired or
    // already consumed / single-use.)
    async function redeemInvite(token) {
        if (typeof token !== 'string' || !token) return null;

        let match;
        try {
            match = await invites.indexes.byToken.get(token);
        }
        catch {
            return null;   // ambiguous match (shouldn't happen — tokens unique)
        }
        if (!match) return null;

        // Atomically bind an account to the invite. pulp-db serializes edits per
        // path, so only one racer sets accountId (already-redeemed invites just
        // return their bound account); the winner then writes the account doc.
        const newAccountId = randomId('acct');
        let boundId;
        let inviteId;
        let inviteGrants = [];
        let entrypoint;
        let inviteName;
        await invites.edit(match.path, (draft) => {
            if (!draft) return;
            inviteId = draft.id;
            // Snapshot plain copies — draft is an immer proxy revoked once
            // edit() returns; we use these below. (primitives are safe.)
            inviteGrants = draft.grants ? [...draft.grants] : [];
            entrypoint = draft.entrypoint;
            inviteName = draft.name;
            if (draft.accountId) { boundId = draft.accountId; return; }
            draft.accountId = newAccountId;
            boundId = newAccountId;
        });
        if (!boundId) return null;
        if (boundId === newAccountId) {
            await accounts.edit(`${newAccountId}.json`, () => stripUndefined({
                id: newAccountId,
                createdAt: new Date().toISOString(),
                invite: inviteId,
                grants: inviteGrants,   // what this account is permitted to do
                name: inviteName        // seed the display name (editable later)
            }));
        }
        return { accountId: boundId, entrypoint };
    }

    const actions = {
        'invites.create': {
            summary: 'Create a new invite token.',
            description: 'Creates an invite. The returned `token` is the secret '
                    + 'bearer credential — put it in the link you send. The `id` '
                    + '(nvt_…) is a non-secret handle for management. Redeeming '
                    + 'the token (POST /invites/redeem) yields a non-admin JWT '
                    + 'for an account auto-created on first redemption.',
            requires: '/server/admin',
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
                    },
                    grants: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Permission grants (globs) conferred on the '
                                + 'account when this invite is redeemed, e.g. '
                                + '["/events/evt_123/view"].'
                    },
                    entrypoint: {
                        type: 'string',
                        pattern: '^/(?!/)',
                        description: 'A same-origin relative path suggesting where '
                                + 'the redeemer should start, e.g. '
                                + '"/events/evt_123". Echoed back by redeem.'
                    },
                    name: {
                        type: 'string',
                        description: "Display name to seed on the redeemer's "
                                + 'account (they can edit it later).'
                    }
                }
            },
            // awaitIndex: an invite must be findable by its token the instant
            // create returns, so redemption never races the index.
            handler: ({ email, note, grants, entrypoint, name }) =>
                    inviteCol.createDoc({
                        token: crypto.randomBytes(24).toString('hex'), // 192-bit
                        ...stripUndefined(
                                { email, note, grants, entrypoint, name })
                    }, { awaitIndex: true })
        },

        'invites.get': {
            summary: 'Fetch a single invite by id (secret token omitted).',
            requires: '/server/admin',
            http: { method: 'GET', path: '/invites/:id' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: {
                    id: { type: 'string', description: 'Invite id.' }
                }
            },
            handler: async ({ id }) => {
                const invite = await inviteCol.getDoc(id);
                return invite && withoutToken(invite);
            }
        },

        'invites.list': {
            summary: 'List all invites (secret tokens omitted).',
            requires: '/server/admin',
            http: { method: 'GET', path: '/invites' },
            input: { type: 'object', additionalProperties: false, properties: {} },
            handler: async () =>
                    (await inviteCol.listDocs()).map(withoutToken)
        },

        'sessions.create': {
            summary: 'Create a new session.',
            requires: '/server/admin',
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
            requires: '/server/admin',
            http: { method: 'GET', path: '/sessions' },
            input: { type: 'object', additionalProperties: false, properties: {} },
            handler: () => sessionCol.listDocs()
        },

        // Events. The stored doc separates OUR metadata (top-level: id,
        // createdAt, later permissions) from the USER's `config` — an arbitrary
        // JSON document. Only `config` is user-editable, and only via JSON Patch.
        'events.create': {
            summary: 'Create a new event.',
            requires: '/server/admin',
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
            summary: 'Fetch an event — graded by permission.',
            description: 'Admins (/events/:id/admin) get the full doc + guest '
                    + 'list; participants (/view or /join) get the user view '
                    + '(id, config, guestList); anyone else 404s (hidden).',
            http: { method: 'GET', path: '/events/:eventId' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' }
                }
            },
            handler: async ({ eventId }, ctx) => {
                const { admin, participant } = eventAccess(eventId, ctx);
                if (!participant) return null;          // 404: hide existence

                const event = await eventCol.getDoc(eventId);
                if (event === null) return null;
                const guestList = (await guestListsByEvent()).get(eventId) ?? [];
                return projectEvent(event, guestList, admin);
            }
        },

        'events.list': {
            summary: 'List events you can see (all of them, for admins).',
            http: { method: 'GET', path: '/events' },
            input: { type: 'object', additionalProperties: false, properties: {} },
            // Each event graded like the single get; events you have no
            // permission on are simply omitted (not 404 — they're not "yours").
            handler: async (_input, ctx) => {
                const [events, lists] = await Promise.all([
                    eventCol.listDocs(), guestListsByEvent()
                ]);
                const out = [];
                for (const e of events) {
                    const { admin, participant } = eventAccess(e.id, ctx);
                    if (!participant) continue;
                    out.push(projectEvent(e, lists.get(e.id) ?? [], admin));
                }
                return out;
            }
        },

        'events.delete': {
            summary: 'Delete an event.',
            requires: '/server/admin',
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
            requires: '/server/admin',
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
        },

        // Owner-or-admin: you can read/edit your own account; admin, any.
        'accounts.get': {
            summary: 'Fetch an account (your own, or any with admin).',
            http: { method: 'GET', path: '/accounts/:accountId' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['accountId'],
                properties: {
                    accountId: { type: 'string', description: 'Account id (acct_…).' }
                }
            },
            handler: ({ accountId }, ctx) =>
                    ownAccountOrAdmin(accountId, ctx)
                            ? accountCol.getDoc(accountId) : null
        },

        'accounts.update': {
            summary: 'Edit an account — currently just its display name.',
            http: { method: 'PATCH', path: '/accounts/:accountId' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['accountId'],
                properties: {
                    accountId: { type: 'string', description: 'Account id (acct_…).' },
                    name: { type: 'string', description: 'Display name.' }
                }
            },
            // Only `name` is settable here — never grants (no self-escalation).
            handler: async ({ accountId, name }, ctx) => {
                if (!ownAccountOrAdmin(accountId, ctx)) return null;   // 404 hide
                const { newValue } = await accounts.edit(
                        `${accountId}.json`, (draft) => {
                            if (!draft) return;
                            if (name !== undefined) draft.name = name;
                        });
                return newValue ?? null;
            }
        },

        'accounts.list': {
            summary: 'List all accounts.',
            requires: '/server/admin',
            http: { method: 'GET', path: '/accounts' },
            input: { type: 'object', additionalProperties: false, properties: {} },
            handler: () => accountCol.listDocs()
        },

        // Reservations — an account's RSVP to an event. Gated (in-handler, per
        // event) on `/events/:eventId/join`; the account defaults to the caller.
        'reservations.set': {
            summary: 'Create or update a reservation (RSVP) for an event.',
            http: { method: 'PUT', path: '/events/:eventId/reservation' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId', 'response'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' },
                    accountId: {
                        type: 'string',
                        description: 'Account reserving (defaults to the caller; '
                                + 'another account requires admin).'
                    },
                    response: {
                        type: 'string',
                        enum: ['going', 'maybe', 'not-going'],
                        description: 'RSVP response.'
                    },
                    guests: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Guest names, each possibly empty.'
                    }
                }
            },
            handler: async ({ eventId, accountId, response, guests }, ctx) => {
                const t = await reservationTarget(eventId, accountId, ctx);
                if (!t) return null;
                const { newValue } = await reservations.edit(
                        `${t.key}.json`, (draft) => ({
                            id: t.key,
                            eventId,
                            accountId: t.acctId,
                            response,
                            guests: guests ?? [],
                            createdAt: draft?.createdAt
                                    ?? new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        }));
                return newValue;
            }
        },

        'reservations.get': {
            summary: "Fetch an account's reservation for an event.",
            http: { method: 'GET', path: '/events/:eventId/reservation' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' },
                    accountId: {
                        type: 'string',
                        description: 'Defaults to the caller; another requires admin.'
                    }
                }
            },
            handler: async ({ eventId, accountId }, ctx) => {
                const t = await reservationTarget(eventId, accountId, ctx);
                if (!t) return null;
                return (await reservations.get(`${t.key}.json`)) ?? null;
            }
        },

        'reservations.delete': {
            summary: "Delete an account's reservation for an event.",
            http: { method: 'DELETE', path: '/events/:eventId/reservation' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' },
                    accountId: {
                        type: 'string',
                        description: 'Defaults to the caller; another requires admin.'
                    }
                }
            },
            handler: async ({ eventId, accountId }, ctx) => {
                const t = await reservationTarget(eventId, accountId, ctx);
                if (!t) return null;
                let deleted = null;
                await reservations.edit(`${t.key}.json`,
                        (draft, { delete: del }) => {
                            if (draft === undefined) return;
                            deleted = JSON.parse(JSON.stringify(draft));
                            del();
                        });
                return deleted;
            }
        }
    };

    return {
        actions,
        redeemInvite,
        makeContext,
        async close() {
            await invites.close();
            await sessions.close();
            await events.close();
            await accounts.close();
            await reservations.close();
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

// The secret token is shown once, in the create response; reads omit it.
function withoutToken({ token, ...rest }) {
    return rest;
}

// How a caller may see an event: `admin` (full doc) if they hold its /admin
// permission; `participant` (user view) if they hold /admin, /view, or /join.
// (An admin's `**` matches /admin for every event.)
function eventAccess(eventId, ctx) {
    const admin = ctx.can(`/events/${eventId}/admin`);
    return {
        admin,
        participant: admin
                || ctx.can(`/events/${eventId}/view`)
                || ctx.can(`/events/${eventId}/join`)
    };
}

// Admins see our metadata; participants a whitelisted user view (so new
// admin-only fields never leak by default). Both get the guest list.
function projectEvent(event, guestList, admin) {
    return admin
            ? { ...event, guestList }
            : { id: event.id, config: event.config, guestList };
}
