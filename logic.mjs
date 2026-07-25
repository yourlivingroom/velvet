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

// Index events by each participating account, ordered by time. An event's
// `members` are the accounts invited to or administrating it (denormalized from
// their grants — see addEventMember/eventIdFromGrant; global `**` admins aren't
// enumerated and reach events via the scan path in events.list). The composite
// key `[accountId, startsAt, endsAt]` is stored with charwise, whose ordering
// puts null (an untimed event) before any ISO string and sorts ISO strings
// chronologically — exactly "no time" first, then by start, then end. So
// `byUser.getMany([accountId])` streams that account's events already ordered.
const EVENT_INDEXES = {
    byUser: {
        process(fileContent, emit) {
            const e = JSON.parse(fileContent);
            for (const uid of e.members ?? []) {
                emit([uid, e.startsAt ?? null, e.endsAt ?? null], e.id);
            }
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

    const events = pulpDb(EVENT_INDEXES, {
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

    // Build the ctx handlers receive: identity + resolved permissions + the
    // caller's account doc. Admins (and the CLI) get `**`; a redeemed account
    // gets whatever grants its invite conferred; anyone else nothing. Resolved
    // per-request from the account store (so grants stay revocable, not frozen
    // into the JWT). `account` is the same fetch — it carries `guestAllowance`.
    // `can` is the quiet check; `assertPermission` is the loud one (403).
    async function makeContext(auth) {
        let account = null;
        let grants = [];
        if (auth?.roles?.includes('admin')) grants = ['**'];
        else if (auth?.sub) {
            account = await accountCol.getDoc(auth.sub);
            grants = account?.grants ?? [];
        }
        return {
            auth: auth ?? null,
            isAdmin: auth?.roles?.includes('admin') ?? false,
            grants,
            account,   // caller's account (null for admin/anon); carries guestAllowance
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
        // Admin over this event (globally or event-scoped) may act on anyone's
        // reservation; a plain /join holder only on their own.
        const eventAdmin = ctx.can('/server/admin')
                || ctx.can(`/events/${eventId}/admin`);
        if (!eventAdmin && !ctx.can(`/events/${eventId}/join`)) return null; // hide

        const acctId = inputAccountId ?? ctx.auth?.sub;
        if (!acctId) {
            throw new ClientError(
                    'No account in context; specify accountId.', 400);
        }
        if (acctId !== ctx.auth?.sub && !eventAdmin) {
            throw new ClientError('Forbidden: not your reservation.', 403);
        }
        if (await eventCol.getDoc(eventId) === null) return null;   // 404

        return { acctId, key: `${eventId}~${acctId}` };
    }

    // --- event membership (denormalized, to feed the byUser index) ----------
    // A "member" of an event is an account invited to or administrating it. That
    // relationship really lives in the account's grants; we mirror the account
    // ids onto `event.members` so the events collection can be indexed by user
    // (an index's process() sees only the event doc, never accounts). awaitIndex
    // so a just-granted event shows up in the grantee's next listing.
    async function addEventMember(eventId, accountId) {
        await events.edit(`${eventId}.json`, (draft) => {
            if (!draft) return;   // no such event (e.g. deleted) — nothing to do
            const cur = draft.members ?? [];
            if (!cur.includes(accountId)) draft.members = [...cur, accountId];
        }, { awaitIndex: true });
    }
    async function removeEventMember(eventId, accountId) {
        await events.edit(`${eventId}.json`, (draft) => {
            if (!draft?.members) return;
            draft.members = draft.members.filter((m) => m !== accountId);
        }, { awaitIndex: true });
    }

    // The events a non-global caller participates in, via the byUser index —
    // already ordered by (startsAt, endsAt) with untimed events first (see
    // EVENT_INDEXES). Returns the full event docs.
    async function eventsForUser(accountId) {
        const out = [];
        const seen = new Set();
        for await (const match of events.indexes.byUser.getMany([accountId])) {
            const id = match.indexValue;
            if (seen.has(id)) continue;
            seen.add(id);
            const doc = await eventCol.getDoc(id);
            if (doc) out.push(doc);
        }
        return out;
    }

    // One-time (idempotent) backfill: rebuild every event's `members` from the
    // accounts' current grants, so events created before this index existed still
    // appear in their participants' lists. Run at server boot.
    async function backfillEventMembers() {
        const accts = await accountCol.listDocs();
        const byEvent = new Map();
        for (const a of accts) {
            for (const g of a.grants ?? []) {
                const eid = eventIdFromGrant(g);
                if (!eid) continue;
                if (!byEvent.has(eid)) byEvent.set(eid, new Set());
                byEvent.get(eid).add(a.id);
            }
        }
        for (const [eid, ids] of byEvent) {
            await events.edit(`${eid}.json`, (draft) => {
                if (!draft) return;
                const cur = new Set(draft.members ?? []);
                const merged = new Set([...cur, ...ids]);
                if (merged.size !== cur.size) draft.members = [...merged];
            });
        }
    }

    // Synthesize the guest list (RSVPs) for events, grouped by event id, in one
    // scan of the reservations (+ one of accounts, for names). Used to fold
    // "who's coming" into event reads.
    async function guestListsByEvent() {
        const [rows, accts] = await Promise.all([
            reservations.list(), accountCol.listDocs()
        ]);
        const acctById = new Map(accts.map(a => [a.id, a]));
        const byEvent = new Map();
        for (const { value } of rows) {
            if (!value?.eventId) continue;
            if (!byEvent.has(value.eventId)) byEvent.set(value.eventId, []);
            const acct = acctById.get(value.accountId);
            byEvent.get(value.eventId).push({
                id: value.accountId,
                name: acct?.name,
                avatar: acct?.avatar,   // { $blob } profile pic, if set — for name links
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
        let inviteAllowance;
        await invites.edit(match.path, (draft) => {
            if (!draft) return;
            inviteId = draft.id;
            // Snapshot plain copies — draft is an immer proxy revoked once
            // edit() returns; we use these below. (primitives are safe.)
            inviteGrants = draft.grants ? [...draft.grants] : [];
            entrypoint = draft.entrypoint;
            inviteName = draft.name;
            inviteAllowance = draft.guestAllowance;   // max guests (undefined = ∞)
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
                name: inviteName,       // seed the display name (editable later)
                guestAllowance: inviteAllowance   // max guests they may bring
            }));
            // Mirror the conferred event grants onto those events' member lists
            // (feeds the byUser index), one entry per distinct event.
            for (const eid of new Set(
                    inviteGrants.map(eventIdFromGrant).filter(Boolean))) {
                await addEventMember(eid, newAccountId);
            }
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
                    + 'for an account auto-created on first redemption. A global '
                    + 'admin may confer any grants; an event admin may mint '
                    + 'invites conferring only permissions within an event they '
                    + 'administer (so they can invite people to their own event).',
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
                    },
                    guestAllowance: {
                        type: 'integer',
                        minimum: 0,
                        description: 'Max guests the redeemer may bring to their '
                                + 'RSVPs (copied to their account at redemption). '
                                + 'Omit for unlimited.'
                    }
                }
            },
            // awaitIndex: an invite must be findable by its token the instant
            // create returns, so redemption never races the index.
            handler: ({ email, note, grants, entrypoint, name, guestAllowance }, ctx) => {
                // Authorize by what's conferred. A global admin confers anything;
                // anyone else may only mint an invite whose every grant falls
                // under an event they administer (never a bare or global-scoped
                // invite) — so an event admin can invite to their own event, but
                // no one can escalate beyond what they hold.
                if (!ctx.can('/server/admin')) {
                    const list = grants ?? [];
                    if (list.length === 0) {
                        throw new ClientError(
                                'Forbidden: only an admin may create an invite.', 403);
                    }
                    for (const g of list) {
                        const m = /^\/events\/([^/]+)\//.exec(g);
                        if (!m || !ctx.can(`/events/${m[1]}/admin`)) {
                            throw new ClientError(
                                    `Forbidden: cannot confer ${g}.`, 403);
                        }
                    }
                }
                return inviteCol.createDoc({
                    token: crypto.randomBytes(24).toString('hex'), // 192-bit
                    ...stripUndefined({ email, note, grants, entrypoint, name,
                        guestAllowance })
                }, { awaitIndex: true });
            }
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
            // startsAt/endsAt are *operative* top-level fields (see events.update),
            // distinct from the user's free-form `config`. They start null.
            // `members` (denormalized participants for the byUser index) starts
            // empty — the creator is a global admin, who reaches events via scan.
            handler: ({ config }) => eventCol.createDoc(
                    { config: config ?? {}, startsAt: null, endsAt: null,
                        members: [] })
        },

        'events.get': {
            summary: 'Fetch an event — graded by permission.',
            description: 'Admins (/events/:id/admin) get the full doc + guest '
                    + 'list; participants (/view or /join) get the user view '
                    + '(id, config, guestList); anyone else 404s (hidden). Both '
                    + 'views carry an `access` block ({ admin, join }) so a '
                    + 'client can offer only the actions the viewer may take.',
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
                const access = eventAccess(eventId, ctx);
                if (!access.participant) return null;   // 404: hide existence

                const event = await eventCol.getDoc(eventId);
                if (event === null) return null;
                const guestList = (await guestListsByEvent()).get(eventId) ?? [];
                return projectEvent(event, guestList, access);
            }
        },

        'events.list': {
            summary: 'List events you can see, ordered by time (all, for admins).',
            description: 'Your "my events": the events you participate in, ordered '
                    + 'by start then end, with untimed events first. Backed by the '
                    + 'byUser index for a scoped caller; a global admin (who can '
                    + 'see every event) is served by a full scan. Each event is '
                    + 'graded like the single GET; events you have no permission on '
                    + 'are simply omitted (not 404 — they are not "yours"). '
                    + '`when` selects upcoming (default — hides events whose start '
                    + 'AND end are both past), past (those, most-recent first), or '
                    + 'all.',
            http: { method: 'GET', path: '/events' },
            input: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    when: {
                        type: 'string',
                        enum: ['upcoming', 'past', 'all'],
                        description: 'Which events to include (default upcoming). '
                                + 'past = both start and end are before now.'
                    }
                }
            },
            handler: async ({ when = 'upcoming' }, ctx) => {
                // Global admins (`**` / wildcard) aren't enumerated in any
                // event's members, so they scan; everyone else queries the index
                // by their account id (already time-ordered).
                const source = seesAllEvents(ctx)
                        ? eventCol.listDocs()
                        : (ctx.auth?.sub ? eventsForUser(ctx.auth.sub) : []);
                const [candidates, lists] = await Promise.all([
                    source, guestListsByEvent()
                ]);
                const now = new Date();
                const nowIso = now.toISOString();
                const openCutoff =
                        new Date(now.getTime() - OPEN_ENDED_GRACE_MS).toISOString();
                const out = [];
                for (const e of candidates) {
                    const access = eventAccess(e.id, ctx);
                    if (!access.participant) continue;
                    const past = isPastEvent(e, nowIso, openCutoff);
                    if (when === 'upcoming' && past) continue;
                    if (when === 'past' && !past) continue;
                    out.push(projectEvent(e, lists.get(e.id) ?? [], access));
                }
                // Sort in-handler too, so ordering holds whether the index was
                // live (already ordered) or inline (unordered scan): untimed
                // first, then by start, then end. History reads newest-first.
                out.sort(byStartThenEnd);
                if (when === 'past') out.reverse();
                return out;
            }
        },

        'events.delete': {
            summary: 'Delete an event.',
            // Event-scoped admin gate (in-handler; see events.patch).
            http: { method: 'DELETE', path: '/events/:eventId' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' }
                }
            },
            handler: ({ eventId }, ctx) => {
                ctx.assertPermission(`/events/${eventId}/admin`);
                return eventCol.deleteDoc(eventId);
            }
        },

        'events.patch': {
            summary: "Edit an event's config via JSON Patch (RFC 6902).",
            description: 'Applies a JSON Patch document to the event config. The '
                    + 'endpoint is /events/:eventId/config, so paths are '
                    + 'relative to the config root; our metadata is not '
                    + 'reachable. Returns the updated event, or null if no such '
                    + 'event.',
            // Event-scoped admin gate: enforced in-handler (the permission is
            // per-event, so it can't be a static `requires`). Global `**` and a
            // /events/:id/admin grant both pass; nothing else does.
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
            handler: async ({ eventId, patch }, ctx) => {
                ctx.assertPermission(`/events/${eventId}/admin`);
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

        // Edit an event's *operative* top-level fields (currently the schedule).
        // Distinct from events.patch, which edits the free-form `config`: these
        // fields (startsAt/endsAt) are data we'll reason about, not just render,
        // so they live at the top level, not in config. Same event-scoped admin
        // gate as events.patch/delete (enforced in-handler).
        'events.update': {
            summary: "Set an event's schedule (startsAt/endsAt).",
            description: 'Updates operative top-level fields on an event: '
                    + '`startsAt` and `endsAt` (ISO 8601 date-times). Omit a '
                    + 'field to leave it unchanged; pass null to clear it. '
                    + 'Requires admin over the event.',
            http: { method: 'PATCH', path: '/events/:eventId' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' },
                    startsAt: {
                        type: ['string', 'null'],
                        description: 'Event start as an ISO 8601 date-time '
                                + '(null clears; omit to leave unchanged).'
                    },
                    endsAt: {
                        type: ['string', 'null'],
                        description: 'Event end as an ISO 8601 date-time '
                                + '(null clears; omit to leave unchanged).'
                    }
                }
            },
            handler: async ({ eventId, startsAt, endsAt }, ctx) => {
                ctx.assertPermission(`/events/${eventId}/admin`);
                // undefined → leave alone; null → clear; string → normalize to a
                // canonical ISO instant (rejects unparseable input).
                const norm = (v, field) => {
                    if (v === undefined || v === null) return v;
                    const d = new Date(v);
                    if (Number.isNaN(d.getTime())) {
                        throw new ClientError(
                                `Invalid ${field}: not a date-time.`, 422);
                    }
                    return d.toISOString();
                };
                const s = norm(startsAt, 'startsAt');
                const e = norm(endsAt, 'endsAt');
                let found = true;
                const { newValue } = await events.edit(`${eventId}.json`,
                        (draft) => {
                            if (draft === undefined) { found = false; return; }
                            if (s !== undefined) draft.startsAt = s;
                            if (e !== undefined) draft.endsAt = e;
                        });
                return found ? newValue : null;
            }
        },

        // Admin-only roster: every account associated with the event, resolved,
        // WITH the non-responders the public guest list omits. This is the
        // "haven't responded" visibility that stays admin-only (see events.get,
        // which hides `members` from the participant view).
        'events.members': {
            summary: "List an event's members with their RSVP status (admin).",
            description: 'Event-admin-only roster of every account associated '
                    + 'with the event (invited or administrating), each with '
                    + 'name, avatar, and current `response` — going/maybe/'
                    + 'not-going, or null for members who have not responded yet '
                    + '(the public guest list omits those). Sorted by name.',
            http: { method: 'GET', path: '/events/:eventId/members' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' }
                }
            },
            handler: async ({ eventId }, ctx) => {
                ctx.assertPermission(`/events/${eventId}/admin`);
                const event = await eventCol.getDoc(eventId);
                if (!event) return null;
                const [accts, resvRows] = await Promise.all([
                    accountCol.listDocs(), reservations.list()
                ]);
                const acctById = new Map(accts.map((a) => [a.id, a]));
                const respByAcct = new Map();
                for (const { value } of resvRows) {
                    if (value?.eventId === eventId) {
                        respByAcct.set(value.accountId, value);
                    }
                }
                const roster = (event.members ?? []).map((id) => {
                    const a = acctById.get(id);
                    const r = respByAcct.get(id);
                    return {
                        id,
                        name: a?.name ?? null,
                        avatar: a?.avatar ?? null,
                        response: r?.response ?? null,   // null = hasn't responded
                        guests: r?.guests ?? []
                    };
                });
                roster.sort((x, y) => (x.name ?? '').localeCompare(y.name ?? ''));
                return roster;
            }
        },

        // Remove a member from an event (revoke their invite): strip every grant
        // scoped to this event, drop them from members[] (byUser index), and
        // delete their reservation — a full removal. Event-admin gated.
        'events.removeMember': {
            summary: 'Remove a member from an event (revoke their invite).',
            description: "Revokes all of the account's grants for this event "
                    + '(/view, /join, /admin), removes it from the event member '
                    + 'list, and deletes its reservation — fully removing the '
                    + 'account from the event. Event-admin gated. You cannot '
                    + 'remove yourself.',
            http: {
                method: 'DELETE',
                path: '/events/:eventId/members/:accountId'
            },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId', 'accountId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' },
                    accountId: { type: 'string', description: 'Account id (acct_…).' }
                }
            },
            handler: async ({ eventId, accountId }, ctx) => {
                ctx.assertPermission(`/events/${eventId}/admin`);
                if (accountId === ctx.auth?.sub) {
                    throw new ClientError(
                            "You can't remove yourself from the event.", 400);
                }
                const account = await accountCol.getDoc(accountId);
                if (!account) return null;   // 404
                // Strip every grant scoped to this event.
                await accounts.edit(`${accountId}.json`, (draft) => {
                    if (!draft) return;
                    draft.grants = (draft.grants ?? [])
                            .filter((g) => eventIdFromGrant(g) !== eventId);
                });
                // Drop from the member list (byUser index) + delete the RSVP.
                await removeEventMember(eventId, accountId);
                await reservations.edit(`${eventId}~${accountId}.json`,
                        (draft, { delete: del }) => {
                            if (draft !== undefined) del();
                        });
                return { id: accountId, removed: true };
            }
        },

        // The "links sent, not used" cohort: invites conferring access to this
        // event that nobody has redeemed yet (no bound account). Event-admin
        // gated; secret tokens omitted (shown once at creation).
        'events.invites': {
            summary: "List an event's open (unredeemed) invites (admin).",
            description: 'Event-admin-only list of invites that confer access to '
                    + 'this event and have not been redeemed yet (no bound '
                    + 'account). Secret `token`s are omitted; the non-secret `id` '
                    + '(nvt_…) identifies each for events.revokeInvite. Newest '
                    + 'first.',
            http: { method: 'GET', path: '/events/:eventId/invites' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' }
                }
            },
            handler: async ({ eventId }, ctx) => {
                ctx.assertPermission(`/events/${eventId}/admin`);
                const all = await inviteCol.listDocs();
                return all
                        .filter((v) => !v.accountId   // open = not yet redeemed
                                && (v.grants ?? []).some(
                                        (g) => eventIdFromGrant(g) === eventId))
                        .map(withoutToken)
                        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
            }
        },

        // Invalidate an open invite's link by deleting it. Event-admin gated;
        // only invites that actually confer access to this event are reachable.
        'events.revokeInvite': {
            summary: 'Invalidate an invite for an event (admin).',
            description: "Deletes the invite by id, invalidating its link, if it "
                    + 'confers access to this event. Event-admin gated. Returns '
                    + 'the deleted invite (token omitted), or null if not found / '
                    + 'unrelated to this event. (For an *already-redeemed* member '
                    + 'use events.removeMember — deleting the invite record does '
                    + "not revoke an account's existing grants.)",
            http: {
                method: 'DELETE', path: '/events/:eventId/invites/:inviteId'
            },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId', 'inviteId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' },
                    inviteId: { type: 'string', description: 'Invite id (nvt_…).' }
                }
            },
            handler: async ({ eventId, inviteId }, ctx) => {
                ctx.assertPermission(`/events/${eventId}/admin`);
                const invite = await inviteCol.getDoc(inviteId);
                if (!invite || !(invite.grants ?? [])
                        .some((g) => eventIdFromGrant(g) === eventId)) {
                    return null;   // absent or not this event's invite — hide
                }
                const deleted = await inviteCol.deleteDoc(inviteId);
                return deleted ? withoutToken(deleted) : null;
            }
        },

        // Edit an open invite's label + guest allowance from the admin screen.
        // Event-admin gated; only invites conferring access to this event are
        // reachable. Affects future redemptions (allowance is copied to the
        // account at redeem time).
        'events.updateInvite': {
            summary: "Edit an invite's name / guest allowance (admin).",
            description: 'Updates the `name` and/or `guestAllowance` of an invite '
                    + 'that confers access to this event. Event-admin gated. '
                    + '`guestAllowance` null clears it (unlimited); omit a field '
                    + 'to leave it unchanged. Returns the invite (token omitted).',
            http: { method: 'PATCH', path: '/events/:eventId/invites/:inviteId' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['eventId', 'inviteId'],
                properties: {
                    eventId: { type: 'string', description: 'Event id (evt_…).' },
                    inviteId: { type: 'string', description: 'Invite id (nvt_…).' },
                    name: { type: 'string', description: 'Display name / label.' },
                    guestAllowance: {
                        type: ['integer', 'null'],
                        minimum: 0,
                        description: 'Max guests (null = unlimited; omit = unchanged).'
                    }
                }
            },
            handler: async ({ eventId, inviteId, name, guestAllowance }, ctx) => {
                ctx.assertPermission(`/events/${eventId}/admin`);
                const invite = await inviteCol.getDoc(inviteId);
                if (!invite || !(invite.grants ?? [])
                        .some((g) => eventIdFromGrant(g) === eventId)) {
                    return null;   // absent or not this event's invite — hide
                }
                const { newValue } = await invites.edit(`${inviteId}.json`,
                        (draft) => {
                            if (!draft) return;
                            if (name !== undefined) draft.name = name;
                            if (guestAllowance !== undefined) {
                                if (guestAllowance === null) delete draft.guestAllowance;
                                else draft.guestAllowance = guestAllowance;
                            }
                        });
                return newValue ? withoutToken(newValue) : null;
            }
        },

        // Owner-or-admin: you can read/edit your own account; admin, any.
        'accounts.get': {
            summary: 'Fetch an account — full for owner/admin, public view else.',
            description: 'Owner or admin get the full account; any other '
                    + 'signed-in caller gets a whitelisted public view '
                    + '({ id, name }) — names are already visible via guest '
                    + 'lists, but grants and bindings never leak. Anonymous '
                    + 'callers (and unknown ids) → 404.',
            http: { method: 'GET', path: '/accounts/:accountId' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['accountId'],
                properties: {
                    accountId: { type: 'string', description: 'Account id (acct_…).' }
                }
            },
            handler: async ({ accountId }, ctx) => {
                const account = await accountCol.getDoc(accountId);
                if (!account) return null;                       // 404
                if (ownAccountOrAdmin(accountId, ctx)) return account;
                if (!ctx.auth?.sub) return null;                 // must be signed in
                // Public view: name + avatar already surface via guest lists.
                return { id: account.id, name: account.name, avatar: account.avatar };
            }
        },

        'accounts.update': {
            summary: 'Edit an account — its display name and profile picture.',
            http: { method: 'PATCH', path: '/accounts/:accountId' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['accountId'],
                properties: {
                    accountId: { type: 'string', description: 'Account id (acct_…).' },
                    name: { type: 'string', description: 'Display name.' },
                    avatar: {
                        type: ['string', 'null'],
                        description: "Profile-picture blob ref (a $blob path in "
                                + "the account's own accounts/<id> bucket), or "
                                + 'null to clear. Omit to leave unchanged.'
                    }
                }
            },
            // Only `name`/`avatar` are settable here — never grants (no
            // self-escalation). The avatar must reference the account's OWN
            // bucket (cheap string check; blob reads are permission-gated anyway).
            handler: async ({ accountId, name, avatar }, ctx) => {
                if (!ownAccountOrAdmin(accountId, ctx)) return null;   // 404 hide
                if (avatar) {
                    const own = new RegExp(
                            `^accounts/${accountId}/blb_[0-9a-f]+$`).test(avatar);
                    if (!own) {
                        throw new ClientError(
                                "avatar must reference this account's own bucket",
                                422);
                    }
                }
                const { newValue } = await accounts.edit(
                        `${accountId}.json`, (draft) => {
                            if (!draft) return;
                            if (name !== undefined) draft.name = name;
                            if (avatar !== undefined) {
                                if (avatar) draft.avatar = { $blob: avatar };
                                else delete draft.avatar;   // '' or null clears
                            }
                        });
                return newValue ?? null;
            }
        },

        'accounts.grant': {
            summary: 'Grant a permission to an account.',
            description: 'Adds a grant (a permission glob) to the account. You '
                    + 'may confer only a permission you yourself hold — a '
                    + 'super-admin (`**`) can grant anything, an event admin '
                    + '(`/events/:id/admin`) can grant that event\'s admin but '
                    + 'no global power. Idempotent. Takes effect on the '
                    + "account's next request (grants aren't baked into a JWT). "
                    + 'Returns the account (grants included only for owner/admin).',
            http: { method: 'POST', path: '/accounts/:accountId/grants' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['accountId', 'grant'],
                properties: {
                    accountId: { type: 'string', description: 'Account id (acct_…).' },
                    grant: {
                        type: 'string',
                        minLength: 1,
                        description: 'Permission glob to grant, e.g. '
                                + '"/events/evt_1/admin" or "**".'
                    }
                }
            },
            handler: async ({ accountId, grant }, ctx) => {
                ctx.assertPermission(grant);        // confer only what you hold
                const account = await accountCol.getDoc(accountId);
                if (!account) return null;          // 404
                const { newValue } = await accounts.edit(
                        `${accountId}.json`, (draft) => {
                            if (!draft) return;
                            if (!(draft.grants ?? []).includes(grant)) {
                                draft.grants = [...(draft.grants ?? []), grant];
                            }
                        });
                // Keep the event's member list (byUser index) in step.
                const eid = eventIdFromGrant(grant);
                if (eid) await addEventMember(eid, accountId);
                return ownAccountOrAdmin(accountId, ctx)
                        ? newValue : { id: newValue.id, name: newValue.name };
            }
        },

        'accounts.revoke': {
            summary: 'Revoke a permission from an account.',
            description: 'Removes a grant from the account. Same authority rule '
                    + 'as accounts.grant: you may revoke only a permission you '
                    + 'yourself hold. Idempotent.',
            http: { method: 'DELETE', path: '/accounts/:accountId/grants' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['accountId', 'grant'],
                properties: {
                    accountId: { type: 'string', description: 'Account id (acct_…).' },
                    grant: {
                        type: 'string',
                        minLength: 1,
                        description: 'Permission glob to revoke.'
                    }
                }
            },
            handler: async ({ accountId, grant }, ctx) => {
                ctx.assertPermission(grant);        // symmetric with grant
                const account = await accountCol.getDoc(accountId);
                if (!account) return null;          // 404
                const { newValue } = await accounts.edit(
                        `${accountId}.json`, (draft) => {
                            if (!draft) return;
                            draft.grants = (draft.grants ?? [])
                                    .filter((g) => g !== grant);
                        });
                // Drop event membership only if no other grant still ties this
                // account to the event (it may hold /view and /join separately).
                const eid = eventIdFromGrant(grant);
                if (eid && !(newValue.grants ?? [])
                        .some((g) => eventIdFromGrant(g) === eid)) {
                    await removeEventMember(eid, accountId);
                }
                return ownAccountOrAdmin(accountId, ctx)
                        ? newValue : { id: newValue.id, name: newValue.name };
            }
        },

        'accounts.reconnect': {
            summary: 'Mint a one-time link to re-establish a session for an '
                    + 'existing account.',
            description: 'Creates an invite token **pre-bound to this account**: '
                    + 'redeeming it logs the holder in AS this account (with its '
                    + 'existing grants), rather than creating a new one — for '
                    + 'helping someone who was logged out reconnect under their '
                    + 'existing profile. Because the link confers full access to '
                    + 'the account, it is **global-admin only** (not event '
                    + 'admins). The secret `token` is shown once, here (put it in '
                    + 'a /invites/?t=… link).',
            requires: '/server/admin',
            http: { method: 'POST', path: '/accounts/:accountId/reconnect' },
            input: {
                type: 'object',
                additionalProperties: false,
                required: ['accountId'],
                properties: {
                    accountId: { type: 'string', description: 'Account id (acct_…).' },
                    entrypoint: {
                        type: 'string',
                        pattern: '^/(?!/)',
                        description: 'Same-origin relative path to land on after '
                                + 'redeem (optional; defaults to /).'
                    }
                }
            },
            // `requires` already gated global admin. Pre-set `accountId` so
            // redeemInvite takes its already-bound branch (returns this account,
            // creates none). awaitIndex so the fresh token is redeemable at once.
            handler: async ({ accountId, entrypoint }, ctx) => {
                const account = await accountCol.getDoc(accountId);
                if (!account) return null;   // 404
                return inviteCol.createDoc({
                    token: crypto.randomBytes(24).toString('hex'),
                    accountId,
                    ...stripUndefined({ entrypoint })
                }, { awaitIndex: true });
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
                const list = guests ?? [];
                // Enforce the reserver's guest allowance — unless the caller is
                // an admin over this event (they may seat any party size). A
                // non-admin only reaches here for their OWN reservation, so the
                // cap is on ctx.account (the caller's own).
                const eventAdmin = ctx.can('/server/admin')
                        || ctx.can(`/events/${eventId}/admin`);
                const allowance = ctx.account?.guestAllowance;
                if (!eventAdmin && allowance != null && list.length > allowance) {
                    throw new ClientError(
                            `You may bring at most ${allowance} guest`
                            + `${allowance === 1 ? '' : 's'}.`, 422);
                }
                const { newValue } = await reservations.edit(
                        `${t.key}.json`, (draft) => ({
                            id: t.key,
                            eventId,
                            accountId: t.acctId,
                            response,
                            guests: list,
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
        backfillEventMembers,
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

// The concrete event id a grant confers access to, or null. Only literal
// `/events/<evt_…>/…` grants map to a member entry; wildcard/`**` holders aren't
// enumerated per-event (they're handled by the scan path — see seesAllEvents).
function eventIdFromGrant(grant) {
    const m = /^\/events\/(evt_[0-9a-f]+)(?:\/|$)/.exec(grant ?? '');
    return m ? m[1] : null;
}

// Does this caller effectively see *every* event (a `**` or `/events/*` holder)?
// Probe with an id that is not a real event: only a wildcard grant can match it.
// Such callers aren't in any event's `members`, so events.list scans for them.
function seesAllEvents(ctx) {
    return ctx.can('/events/__any__/admin')
            || ctx.can('/events/__any__/view')
            || ctx.can('/events/__any__/join');
}

// Order events for a listing: untimed (null) first, then by start, then end.
// ISO date-time strings compare lexicographically = chronologically.
function cmpTimeNullFirst(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
}
function byStartThenEnd(a, b) {
    return cmpTimeNullFirst(a.startsAt, b.startsAt)
            || cmpTimeNullFirst(a.endsAt, b.endsAt);
}

// How long an open-ended event (a start, no end) lingers as "current" before we
// consider it over.
const OPEN_ENDED_GRACE_MS = 48 * 60 * 60 * 1000;

// "Past" (for the events listing): a fully-timed event whose start AND end are
// both before now, OR an open-ended event (start, no end) whose start is more
// than 48h ago. An untimed event (no start) is never past. `now`/`openCutoff`
// are ISO strings (stored times are canonical UTC ISO, so lexical compare is
// chronological); `openCutoff` is `now - 48h`.
function isPastEvent(event, now, openCutoff) {
    const { startsAt, endsAt } = event;
    if (startsAt == null) return false;                  // untimed → never past
    if (endsAt != null) return startsAt < now && endsAt < now;
    return startsAt < openCutoff;                        // open-ended, start stale
}

// How a caller may see an event: `admin` (full doc) if they hold its /admin
// permission; `join` (may RSVP) if they hold /join; `participant` (user view)
// if they hold /admin, /view, or /join. (An admin's `**` matches every one.)
function eventAccess(eventId, ctx) {
    const admin = ctx.can(`/events/${eventId}/admin`);
    const join = ctx.can(`/events/${eventId}/join`);
    return {
        admin,
        join,
        participant: admin || join || ctx.can(`/events/${eventId}/view`),
        // The viewer's effective guest allowance (null = unlimited). Admins over
        // the event are exempt; everyone else is capped by their account. Lets
        // the client stop offering "Add guest" past the limit (server enforces).
        guestAllowance: admin ? null : (ctx.account?.guestAllowance ?? null)
    };
}

// Admins see our metadata; participants a whitelisted user view (so new
// admin-only fields never leak by default). Both get the guest list, plus an
// `access` block telling the viewer what they may do (e.g. drive the RSVP UI).
function projectEvent(event, guestList, access) {
    // Operative fields are visible to any participant (they drive display), and
    // normalized to null so events created before they existed read uniformly.
    const times = {
        startsAt: event.startsAt ?? null,
        endsAt: event.endsAt ?? null
    };
    const view = access.admin
            ? { ...event, ...times, guestList }
            : { id: event.id, ...times, config: event.config, guestList };
    return {
        ...view,
        access: {
            admin: access.admin,
            join: access.join,
            guestAllowance: access.guestAllowance
        }
    };
}
