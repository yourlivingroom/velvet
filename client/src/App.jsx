import React, { useContext, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

// Fetches from the same paths the app is mounted at — Accept: application/json
// keeps the server from handing back the SPA shell. Auth rides the HttpOnly
// `velvet_session` cookie the BFF sets at login; being same-origin, the browser
// attaches it automatically, and JS can't read it (that's the point).
//
// For writes we complete the CSRF double-submit: read the (readable) velvet_csrf
// cookie and echo it in X-CSRF-Token. A cross-site attacker can send the session
// cookie but can't set this header (CORS preflight) nor read the token, so the
// server's HMAC check rejects the forgery.
function csrfHeaders(method) {
    if (!method || method.toUpperCase() === 'GET') return {};
    const m = document.cookie.match(/(?:^|;\s*)velvet_csrf=([^;]*)/);
    return m ? { 'X-CSRF-Token': decodeURIComponent(m[1]) } : {};
}

// One shared in-flight refresh, so a burst of 401s triggers a single
// POST /session/refresh (which re-mints the access cookie server-side).
let refreshing = null;
function refreshSession() {
    if (!refreshing) {
        refreshing = fetch('/session/refresh', {
            method: 'POST', headers: { Accept: 'application/json' }
        }).then((r) => r.ok).catch(() => false).finally(() => { refreshing = null; });
    }
    return refreshing;
}

// On a 401 the access cookie has likely expired; try one transparent refresh and
// replay the request. If refresh fails (refresh cookie gone/expired) the 401
// stands and the caller falls through to the logged-out path.
async function api(path, opts = {}) {
    const send = () => fetch(path, {
        ...opts,
        headers: { Accept: 'application/json', ...csrfHeaders(opts.method), ...opts.headers }
    });
    let r = await send();
    if (r.status === 401 && path !== '/session/refresh' && await refreshSession()) {
        r = await send();
    }
    return r.json();
}

// Who's signed in — resolved once from GET /session (the server decodes the
// cookie; the client can't). `{ accountId, isAdmin }`, or null when logged out.
// Provided by <App>; read via useSession() anywhere below it.
const SessionContext = React.createContext(null);
const useSession = () => useContext(SessionContext);

const wrap = {
    font: '16px/1.5 system-ui', maxWidth: 640, margin: '3rem auto', padding: '0 1rem'
};
const dim = { fontSize: '1rem', color: '#666' };
const label = { display: 'block', color: '#666', fontSize: '.9rem' };
const input = {
    width: '100%', padding: '.5rem', margin: '.35rem 0 1rem',
    boxSizing: 'border-box', font: 'inherit'
};
const iconBtn = {
    border: 'none', background: 'none', cursor: 'pointer', fontSize: '1.3rem',
    lineHeight: 1, padding: '.25rem'
};
const overlay = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20
};
const dialog = {
    background: '#fff', borderRadius: 8, padding: '1.5rem',
    width: 'min(90vw, 360px)', boxShadow: '0 8px 32px rgba(0,0,0,.2)'
};
const menu = {
    position: 'absolute', top: '100%', right: 0, marginTop: '.35rem',
    background: '#fff', border: '1px solid #ddd', borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0,0,0,.12)', minWidth: 150, overflow: 'hidden'
};
const menuItem = {
    display: 'block', width: '100%', textAlign: 'left', border: 'none',
    background: 'none', cursor: 'pointer', font: 'inherit', padding: '.6rem .9rem',
    color: 'inherit', textDecoration: 'none', boxSizing: 'border-box'
};
const rsvpStrip = {
    display: 'inline-flex', border: '1px solid #ccc', borderRadius: 8, overflow: 'hidden'
};
const rsvpBtn = {
    border: 'none', background: '#fff', cursor: 'pointer', font: 'inherit',
    padding: '.5rem 1.1rem'
};
const rsvpBtnActive = { background: '#2563eb', color: '#fff' };

function EventList() {
    const [events, setEvents] = useState(null);
    useEffect(() => {
        api('/events').then(setEvents).catch(() => setEvents([]));
    }, []);

    return (
        <main style={wrap}>
            <h1>velvet</h1>
            <h2 style={dim}>Your events</h2>
            {events === null ? (
                <p>Loading…</p>
            ) : events.length === 0 ? (
                <p>No events yet.</p>
            ) : (
                <ul>
                    {events.map((e) => (
                        <li key={e.id}>
                            <a href={`/events/${e.id}`}>{e.config?.title || e.id}</a>
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
}

const RSVP_OPTIONS = [
    { value: 'going', label: 'Going' },
    { value: 'maybe', label: 'Maybe' },
    { value: 'not-going', label: 'Not going' }
];
// Status wording for a read-out (vs the button strip); missing → No Response.
const RSVP_LABELS = { going: 'Going', maybe: 'Maybe', 'not-going': 'Not Going' };

// Segmented RSVP control, shown to anyone with /join. `current` is the viewer's
// response (from the guest list); `guests` their existing +N names, preserved
// so flipping the response doesn't drop them.
function RsvpStrip({ eventId, current, guests, onDone }) {
    const [saving, setSaving] = useState(false);
    const set = async (response) => {
        if (saving || response === current) return;
        setSaving(true);
        await api(`/events/${eventId}/reservation`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ response, guests })
        });
        await onDone();
        setSaving(false);
    };
    return (
        <div style={{ margin: '1.25rem 0' }}>
            <div style={rsvpStrip}>
                {RSVP_OPTIONS.map((o, i) => {
                    const active = o.value === current;
                    return (
                        <button key={o.value} onClick={() => set(o.value)}
                            disabled={saving} aria-pressed={active}
                            style={{
                                ...rsvpBtn,
                                ...(i > 0 ? { borderLeft: '1px solid #ccc' } : {}),
                                ...(active ? rsvpBtnActive : {})
                            }}>
                            {o.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function EventDetail({ id }) {
    const session = useSession();
    const [event, setEvent] = useState(undefined);
    const [editing, setEditing] = useState(false);
    const [form, setForm] = useState({ title: '', description: '' });
    const [saving, setSaving] = useState(false);

    const load = () => api(`/events/${id}`).then(setEvent).catch(() => setEvent(null));
    useEffect(() => { load(); }, [id]);

    if (event === undefined) {
        return <main style={wrap}><p>Loading…</p></main>;
    }
    if (!event || event.error) {
        return (
            <main style={wrap}>
                <p><a href="/events">← events</a></p>
                <p>Event not found.</p>
            </main>
        );
    }

    const config = event.config ?? {};
    const guests = event.guestList ?? [];
    // My own RSVP (if any) — the guest list is keyed by account id.
    const mine = guests.find((g) => g.id === session.accountId);

    const startEdit = () => {
        setForm({ title: config.title ?? '', description: config.description ?? '' });
        setEditing(true);
    };

    const save = async () => {
        setSaving(true);
        // JSON Patch against the event's config (paths relative to config root).
        const patch = [{ op: 'add', path: '/title', value: form.title }];
        if (form.description) {
            patch.push({ op: 'add', path: '/description', value: form.description });
        } else if (config.description !== undefined) {
            patch.push({ op: 'remove', path: '/description' });
        }
        await api(`/events/${id}/config`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json-patch+json' },
            body: JSON.stringify(patch)
        });
        await load();
        setSaving(false);
        setEditing(false);
    };

    return (
        <main style={wrap}>
            <p><a href="/events">← events</a></p>

            {editing ? (
                <div>
                    <label style={label}>Title
                        <input style={input} value={form.title} autoFocus
                            onChange={(e) => setForm({ ...form, title: e.target.value })} />
                    </label>
                    <label style={label}>Description
                        <textarea style={{ ...input, minHeight: '5rem' }} value={form.description}
                            onChange={(e) => setForm({ ...form, description: e.target.value })} />
                    </label>
                    <div>
                        <button onClick={save} disabled={saving}>Save</button>{' '}
                        <button onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                    <div>
                        <h1 style={{ margin: 0 }}>{config.title || event.id}</h1>
                        {config.description && <p style={{ marginTop: '.5rem' }}>{config.description}</p>}
                    </div>
                    {event.access?.admin && (
                        <button onClick={startEdit} style={iconBtn} title="Edit" aria-label="Edit">
                            ✏️
                        </button>
                    )}
                </div>
            )}

            {event.access?.join && (
                <RsvpStrip eventId={id} current={mine?.response}
                    guests={mine?.guests ?? []} onDone={load} />
            )}

            {event.access?.admin && <AdminActions eventId={id} />}

            <h2 style={dim}>Who's coming ({guests.length})</h2>
            {guests.length === 0 ? (
                <p>No RSVPs yet.</p>
            ) : (
                <ul>
                    {guests.map((g) => (
                        <li key={g.id}>
                            <a href={`/accounts/${g.id}?event=${id}`}>{g.name ?? g.id}</a> — {g.response ?? 'no response'}
                            {g.guests?.length ? ` (+${g.guests.length})` : ''}
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
}

function AdminActions({ eventId }) {
    const [inviting, setInviting] = useState(false);
    return (
        <details style={{ margin: '1.5rem 0' }}>
            <summary style={{ ...dim, cursor: 'pointer', fontWeight: 600 }}>
                Admin actions
            </summary>
            <div style={{ padding: '.75rem 0' }}>
                <button onClick={() => setInviting(true)}>Create invite</button>
            </div>
            {inviting && (
                <CreateInviteModal eventId={eventId} onClose={() => setInviting(false)} />
            )}
        </details>
    );
}

function CreateInviteModal({ eventId, onClose }) {
    const [step, setStep] = useState('name'); // name | creating | done
    const [name, setName] = useState('');
    const [invite, setInvite] = useState(null);
    const [copied, setCopied] = useState(false);

    const create = async () => {
        setStep('creating');
        // Invite scoped to this event: the redeemer's account can view it and
        // RSVP. `entrypoint` lands them here; `name` seeds their display name.
        const result = await api('/invites', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: name || undefined,
                entrypoint: `/events/${eventId}`,
                grants: [`/events/${eventId}/view`, `/events/${eventId}/join`]
            })
        });
        setInvite(result);
        setStep('done');
    };

    // The link a redeemer follows: the /invites/ page redeems `t`, sets up their
    // auth, then forwards to the invite's configured entrypoint (this event).
    const link = invite
        ? `${window.location.origin}/invites/?t=${invite.token}`
        : '';

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable — the field is selectable */ }
    };

    return (
        <div style={overlay} onClick={onClose}>
            <div style={dialog} onClick={(e) => e.stopPropagation()}>
                {step === 'done' ? (
                    <div>
                        <h2 style={{ marginTop: 0 }}>Invite ready</h2>
                        <div style={{ display: 'flex', justifyContent: 'center', margin: '1rem 0' }}>
                            <QRCodeSVG value={link} size={180} includeMargin />
                        </div>
                        <label style={label}>Invite link</label>
                        <div style={{ display: 'flex', gap: '.5rem', margin: '.35rem 0 1rem' }}>
                            <input style={{ ...input, margin: 0 }} readOnly value={link}
                                onFocus={(e) => e.target.select()} />
                            <button onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                            <button onClick={onClose}>Close</button>
                        </div>
                    </div>
                ) : (
                    <div>
                        <h2 style={{ marginTop: 0 }}>Create invite</h2>
                        <label style={label}>Name
                            <input style={input} value={name} autoFocus
                                disabled={step === 'creating'}
                                placeholder="Who's this invite for?"
                                onChange={(e) => setName(e.target.value)} />
                        </label>
                        <div style={{ textAlign: 'right' }}>
                            <button onClick={onClose} disabled={step === 'creating'}>Cancel</button>{' '}
                            <button onClick={create} disabled={step === 'creating'}>Create</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// One grant a viewing admin can confer/revoke. `grants` is the target's grant
// list when we're allowed to see it (owner/admin) — then we show current state
// and a single toggle; otherwise (event admin, who only sees {id,name}) we show
// both idempotent actions blind.
function GrantRow({ label, path, accountId, grants, onChange }) {
    const [busy, setBusy] = useState(false);
    const known = Array.isArray(grants);
    const has = known && grants.includes(path);
    const act = async (opts) => {
        setBusy(true);
        await api(`/accounts/${accountId}/grants${opts.query ?? ''}`, opts.req);
        await onChange();
        setBusy(false);
    };
    const grant = () => act({
        req: {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ grant: path })
        }
    });
    const revoke = () => act({
        query: `?grant=${encodeURIComponent(path)}`, req: { method: 'DELETE' }
    });
    return (
        <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', margin: '.4rem 0' }}>
            <span style={{ minWidth: 150 }}>
                {label}{known && has ? ' — granted' : ''}
            </span>
            {known ? (
                has
                    ? <button onClick={revoke} disabled={busy}>Revoke</button>
                    : <button onClick={grant} disabled={busy}>Grant</button>
            ) : (
                <span>
                    <button onClick={grant} disabled={busy}>Grant</button>{' '}
                    <button onClick={revoke} disabled={busy}>Revoke</button>
                </span>
            )}
        </div>
    );
}

// Full profile page at /accounts/:accountId. For now just the display name.
// Editable only when it's your own account; others see a read-only view (the
// server hands peers just { id, name }). A ?event=<eventId> renders the page
// relative to that event, adding the account's RSVP status below the name and
// (for an admin of that event) an event-admin grant control.
function AccountPage({ accountId }) {
    const [name, setName] = useState('');
    const [grants, setGrants] = useState(undefined); // array iff we may see it
    const [state, setState] = useState('loading'); // loading | ready | missing | saving
    // undefined = no event context / not resolvable; { response } once known.
    const [eventRsvp, setEventRsvp] = useState(undefined);
    const [eventAdmin, setEventAdmin] = useState(false); // do *I* admin this event?
    const session = useSession();
    const mine = session.accountId === accountId;
    const eventId = new URLSearchParams(window.location.search).get('event');

    const loadAccount = () => api(`/accounts/${accountId}`)
        .then((a) => {
            if (!a || a.error) { setState('missing'); return; }
            setName(a.name ?? '');
            setGrants(a.grants);   // present only in the owner/admin full view
            setState('ready');
        })
        .catch(() => setState('missing'));
    useEffect(() => { loadAccount(); }, [accountId]);

    // Event context: read this account's RSVP out of the event's guest list
    // (which we can see as a participant), and note whether *we* admin it.
    useEffect(() => {
        if (!eventId) return;
        api(`/events/${eventId}`)
            .then((e) => {
                if (!e || e.error) return;
                setEventAdmin(!!e.access?.admin);
                const entry = (e.guestList ?? []).find((g) => g.id === accountId);
                setEventRsvp({ response: entry?.response ?? null });
            })
            .catch(() => {});
    }, [eventId, accountId]);

    const rsvpLine = eventId && eventRsvp ? (
        <p style={{ margin: '.35rem 0 1rem', color: '#666' }}>
            {RSVP_LABELS[eventRsvp.response] ?? 'No Response'}
        </p>
    ) : null;

    // Grant affordances: never on your own profile. Full admin needs `**` (i.e.
    // a global admin); event admin needs to admin *this* event.
    const adminControls = !mine && (session.isAdmin || (eventId && eventAdmin)) ? (
        <div style={{ marginTop: '2rem' }}>
            <hr />
            <h2 style={dim}>Admin</h2>
            {eventId && eventAdmin && (
                <GrantRow label="Event admin" path={`/events/${eventId}/admin`}
                    accountId={accountId} grants={grants} onChange={loadAccount} />
            )}
            {session.isAdmin && (
                <GrantRow label="Full admin (**)" path="**"
                    accountId={accountId} grants={grants} onChange={loadAccount} />
            )}
        </div>
    ) : null;

    // Return where they came from (the menu lives on every page), falling back
    // to the events list on a fresh navigation with no history.
    const goBack = () =>
        window.history.length > 1 ? window.history.back() : (window.location.href = '/');

    const save = async () => {
        setState('saving');
        await api(`/accounts/${accountId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name })
        });
        goBack();
    };

    return (
        <main style={wrap}>
            <h1>Profile</h1>
            {state === 'loading' ? (
                <p>Loading…</p>
            ) : state === 'missing' ? (
                <p>Profile not found.</p>
            ) : mine ? (
                <div>
                    <label style={label}>Display name
                        <input style={input} value={name} autoFocus
                            onChange={(e) => setName(e.target.value)} />
                    </label>
                    {rsvpLine}
                    <div>
                        <button onClick={save} disabled={state === 'saving'}>Save</button>{' '}
                        <button onClick={goBack} disabled={state === 'saving'}>Cancel</button>
                    </div>
                </div>
            ) : (
                <div>
                    <p style={label}>Display name</p>
                    <p style={{ margin: '.35rem 0 .25rem' }}>{name || 'Unnamed'}</p>
                    {rsvpLine}
                    <button onClick={goBack}>← Back</button>
                    {adminControls}
                </div>
            )}
        </main>
    );
}

function LogoutModal({ onClose }) {
    const logout = async () => {
        await api('/session', { method: 'DELETE' });   // clears the cookie server-side
        window.location.href = '/';
    };
    return (
        <div style={overlay} onClick={onClose}>
            <div style={dialog} onClick={(e) => e.stopPropagation()}>
                <h2 style={{ marginTop: 0 }}>Really log out?</h2>
                <p>You will need to be re-invited.</p>
                <div style={{ textAlign: 'right' }}>
                    <button onClick={onClose}>Cancel</button>{' '}
                    <button onClick={logout}>Log out</button>
                </div>
            </div>
        </div>
    );
}

function ProfileMenu() {
    const [open, setOpen] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);

    // Close the dropdown on any outside click.
    useEffect(() => {
        if (!open) return;
        const onDoc = () => setOpen(false);
        document.addEventListener('click', onDoc);
        return () => document.removeEventListener('click', onDoc);
    }, [open]);

    const me = useSession();
    if (!me) return null; // only offer a profile when signed in

    return (
        <div style={{ position: 'fixed', top: '1rem', right: '1rem', zIndex: 10 }}
            onClick={(e) => e.stopPropagation()}>
            <button style={iconBtn} title="Profile" aria-label="Profile"
                aria-haspopup="menu" aria-expanded={open}
                onClick={() => setOpen((v) => !v)}>
                👤
            </button>
            {open && (
                <div style={menu} role="menu">
                    <a style={menuItem} role="menuitem" href={`/accounts/${me.accountId}`}>
                        Edit profile
                    </a>
                    <button style={menuItem} role="menuitem"
                        onClick={() => { setOpen(false); setLoggingOut(true); }}>
                        Log out
                    </button>
                </div>
            )}
            {loggingOut && <LogoutModal onClose={() => setLoggingOut(false)} />}
        </div>
    );
}

// The invite landing page (`/invites/?t=<token>`). Trades the token via the BFF
// (`/session/invite`), which sets the session cookie server-side, then forwards
// to the invite's entrypoint. Using replace() keeps the token out of history,
// and no JWT ever reaches JS.
function RedeemInvite() {
    const [error, setError] = useState(null);
    useEffect(() => {
        const token = new URLSearchParams(window.location.search).get('t');
        if (!token) { setError('This invite link is missing its token.'); return; }
        api('/session/invite', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token })
        }).then((r) => {
            if (!r || r.error) {
                setError('This invite is invalid or has already been used.');
                return;
            }
            window.location.replace(r.entrypoint || '/');
        }).catch(() => setError('Something went wrong redeeming this invite.'));
    }, []);

    return (
        <main style={wrap}>
            <h1>velvet</h1>
            <p>{error ?? 'Signing you in…'}</p>
        </main>
    );
}

// Shown in place of any permissioned page when there's no live token — an
// expired/missing session otherwise renders as a silent empty list or a
// misleading "not found".
function NotLoggedIn() {
    return (
        <main style={wrap}>
            <h1>velvet</h1>
            <p>You are not logged in.</p>
            <p style={dim}>
                Your session may have expired. <a href="/admin">Log in as admin</a>,
                or open a fresh invite link.
            </p>
        </main>
    );
}

// Signed-in routes, gated on the session resolved from GET /session. The invite
// landing page is handled by <App> before this (it *is* how you log in).
function Shell({ path }) {
    // undefined = still asking the server; null = logged out; object = identity.
    const [session, setSession] = useState(undefined);
    useEffect(() => {
        api('/session')
            .then((s) => setSession(s && !s.error ? s : null))
            .catch(() => setSession(null));
    }, []);

    if (session === undefined) {
        return <main style={wrap}><p>Loading…</p></main>;
    }
    if (!session) return <NotLoggedIn />;

    const account = path.match(/^\/accounts\/([^/]+)$/);
    const event = path.match(/^\/events\/([^/]+)$/);
    return (
        <SessionContext.Provider value={session}>
            <ProfileMenu />
            {account ? <AccountPage accountId={account[1]} />
                : event ? <EventDetail id={event[1]} />
                : <EventList />}
        </SessionContext.Provider>
    );
}

export default function App() {
    // Tiny path router: /invites/ → redeem landing (ungated); everything else is
    // a signed-in route rendered by <Shell> once the session resolves.
    const path = window.location.pathname;
    if (/^\/invites\/?$/.test(path)) return <RedeemInvite />;
    return <Shell path={path} />;
}
