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

// Upload a File to a permissioned blob bucket via the resumable protocol:
// create a session, then PATCH the bytes in chunks at the running offset. Chunked
// so we can report progress (and, later, resume). Returns the `$blob` ref string
// (`<bucket>/blb_<id>`). Uses fetch directly (not api()) — the responses are
// 201/204 with header state, not JSON envelopes — but still echoes the CSRF
// token on these cookie-authenticated writes.
const BLOB_CHUNK = 1024 * 1024;   // 1 MB
async function uploadBlob(bucket, file, onProgress) {
    const create = await fetch(`/blobs/${bucket}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json',
            ...csrfHeaders('POST') },
        body: JSON.stringify({
            size: file.size,
            contentType: file.type || 'application/octet-stream',
            filename: file.name
        })
    });
    if (!create.ok) throw new Error('could not start upload');
    const { ref } = await create.json();

    let offset = 0;
    while (offset < file.size) {
        const end = Math.min(offset + BLOB_CHUNK, file.size);
        const res = await fetch(`/blobs/${ref}`, {
            method: 'PATCH',
            headers: {
                'content-type': 'application/offset+octet-stream',
                'upload-offset': String(offset),
                ...csrfHeaders('PATCH')
            },
            body: file.slice(offset, end)
        });
        if (res.status === 409) {
            // Server and client disagree on the offset — resync and retry.
            offset = Number(res.headers.get('upload-offset')) || 0;
            continue;
        }
        if (!res.ok) throw new Error('upload failed');
        offset = Number(res.headers.get('upload-offset')) || end;
        onProgress?.(offset / file.size);
    }
    return ref;
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

// Deterministic hue from a string, so a given name always gets the same
// placeholder color.
function hashHue(s) {
    let h = 0;
    for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
}

// A round profile picture, or — with no picture — the name's first initial in a
// colored circle. `avatar` is the stored `{ $blob }` ref (or falsy).
function Avatar({ name, avatar, size = 24 }) {
    const base = {
        width: size, height: size, borderRadius: '50%',
        flex: '0 0 auto', objectFit: 'cover', display: 'inline-block'
    };
    if (avatar?.$blob) {
        return <img src={`/blobs/${avatar.$blob}`} alt="" style={base} />;
    }
    const initial = (name || '').trim().charAt(0).toUpperCase() || '?';
    return (
        <span style={{
            ...base, display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', background: `hsl(${hashHue(name)} 55% 45%)`,
            color: '#fff', fontWeight: 600, fontSize: Math.round(size * 0.5),
            lineHeight: 1, userSelect: 'none'
        }}>{initial}</span>
    );
}

// A name link: mini avatar + display name, linking to the profile page. Pass
// `event` to render the profile relative to an event (RSVP line + grant control).
function UserLink({ id, name, avatar, event, size = 24 }) {
    const href = `/accounts/${id}${event ? `?event=${event}` : ''}`;
    return (
        <a href={href} style={{
            display: 'inline-flex', alignItems: 'center', gap: '.45rem',
            textDecoration: 'none', color: 'inherit'
        }}>
            <Avatar name={name} avatar={avatar} size={size} />
            <span>{name || id}</span>
        </a>
    );
}

function EventList() {
    const session = useSession();
    const [events, setEvents] = useState(null);
    const [creating, setCreating] = useState(false);
    useEffect(() => {
        api('/events').then(setEvents).catch(() => setEvents([]));
    }, []);

    // Admins can spin up a blank event, then click through to fill it in. The
    // server defaults config to {}, so no body is needed beyond an empty object.
    const create = async () => {
        setCreating(true);
        const e = await api('/events', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        });
        if (e && e.id) window.location.href = `/events/${e.id}`;
        else setCreating(false);
    };

    return (
        <main style={wrap}>
            <h1>velvet</h1>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h2 style={dim}>Your events</h2>
                {session.isAdmin && (
                    <button onClick={create} disabled={creating}>
                        {creating ? 'Creating…' : 'Create event'}
                    </button>
                )}
            </div>
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

// An ISO instant → the value a <input type="datetime-local"> wants
// (YYYY-MM-DDTHH:mm in *local* time). Empty string for null/unset.
function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// A datetime-local value (local, no zone) → a full ISO instant, or null.
// new Date(local).toISOString() anchors it to the viewer's timezone.
const localInputToIso = (v) => (v ? new Date(v).toISOString() : null);

// Human-readable schedule line, or null when neither bound is set.
function formatWhen(startsAt, endsAt) {
    const fmt = (iso) => new Date(iso).toLocaleString([], {
        dateStyle: 'medium', timeStyle: 'short'
    });
    if (startsAt && endsAt) return `${fmt(startsAt)} – ${fmt(endsAt)}`;
    if (startsAt) return `Starts ${fmt(startsAt)}`;
    if (endsAt) return `Ends ${fmt(endsAt)}`;
    return null;
}

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
    const [form, setForm] = useState({
        title: '', description: '', startsAt: '', endsAt: '', picture: ''
    });
    const [saving, setSaving] = useState(false);
    const [uploadPct, setUploadPct] = useState(null);   // null = idle, 0..1 = busy

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
        setForm({
            title: config.title ?? '',
            description: config.description ?? '',
            startsAt: toLocalInput(event.startsAt),
            endsAt: toLocalInput(event.endsAt),
            picture: config.picture?.$blob ?? ''   // the current cover's ref
        });
        setEditing(true);
    };

    // Cover image: upload to this event's bucket (event admins can write it),
    // then stash the returned $blob ref in the form — persisted on Save.
    const pickImage = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';   // allow re-picking the same file
        if (!file) return;
        setUploadPct(0);
        try {
            const ref = await uploadBlob(`events/${id}`, file, setUploadPct);
            setForm((f) => ({ ...f, picture: ref }));
        }
        catch { /* leave the prior picture; the input is still usable */ }
        setUploadPct(null);
    };

    const save = async () => {
        setSaving(true);
        // Two surfaces: the free-form config (JSON Patch, paths relative to the
        // config root) and the operative schedule (top-level PATCH on the event).
        const patch = [{ op: 'add', path: '/title', value: form.title }];
        if (form.description) {
            patch.push({ op: 'add', path: '/description', value: form.description });
        } else if (config.description !== undefined) {
            patch.push({ op: 'remove', path: '/description' });
        }
        // Cover image ref (`add` also replaces an existing member per RFC 6902).
        if (form.picture) {
            patch.push({ op: 'add', path: '/picture', value: { $blob: form.picture } });
        } else if (config.picture !== undefined) {
            patch.push({ op: 'remove', path: '/picture' });
        }
        await api(`/events/${id}/config`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json-patch+json' },
            body: JSON.stringify(patch)
        });
        await api(`/events/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                startsAt: localInputToIso(form.startsAt),
                endsAt: localInputToIso(form.endsAt)
            })
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
                    <label style={label}>Starts
                        <input style={input} type="datetime-local" value={form.startsAt}
                            onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
                    </label>
                    <label style={label}>Ends
                        <input style={input} type="datetime-local" value={form.endsAt}
                            onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
                    </label>
                    <label style={label}>Cover image</label>
                    <div style={{ margin: '.35rem 0 1rem' }}>
                        {form.picture && (
                            <img src={`/blobs/${form.picture}`} alt="Cover preview"
                                style={{ display: 'block', maxWidth: '100%',
                                    borderRadius: 6, marginBottom: '.5rem' }} />
                        )}
                        {uploadPct !== null ? (
                            <progress value={uploadPct} max={1}
                                style={{ width: '100%' }} />
                        ) : (
                            <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                                <input type="file" accept="image/*" onChange={pickImage} />
                                {form.picture && (
                                    <button type="button"
                                        onClick={() => setForm({ ...form, picture: '' })}>
                                        Remove
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                    <div>
                        <button onClick={save} disabled={saving || uploadPct !== null}>Save</button>{' '}
                        <button onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                    <div>
                        {config.picture?.$blob && (
                            <img src={`/blobs/${config.picture.$blob}`} alt=""
                                style={{ display: 'block', maxWidth: '100%',
                                    borderRadius: 8, marginBottom: '.75rem' }} />
                        )}
                        <h1 style={{ margin: 0 }}>{config.title || event.id}</h1>
                        {formatWhen(event.startsAt, event.endsAt) && (
                            <p style={{ ...dim, margin: '.4rem 0 0' }}>
                                {formatWhen(event.startsAt, event.endsAt)}
                            </p>
                        )}
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
                        <li key={g.id} style={{ margin: '.4rem 0' }}>
                            <UserLink id={g.id} name={g.name} avatar={g.avatar} event={id} />
                            {' — '}{g.response ?? 'no response'}
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

// Shared "here's your link" modal: QR + a read-only field + copy. Any flow that
// mints an invite token (event invite, account reconnect) shows its link here.
function InviteLinkDialog({ link, title, onClose }) {
    const [copied, setCopied] = useState(false);
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
                <h2 style={{ marginTop: 0 }}>{title}</h2>
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
        </div>
    );
}

function CreateInviteModal({ eventId, onClose }) {
    const [step, setStep] = useState('name'); // name | creating | done
    const [name, setName] = useState('');
    const [invite, setInvite] = useState(null);

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

    if (step === 'done') {
        // The link a redeemer follows: /invites/ redeems `t`, sets up their auth,
        // then forwards to the invite's configured entrypoint (this event).
        const link = `${window.location.origin}/invites/?t=${invite.token}`;
        return <InviteLinkDialog link={link} title="Invite ready" onClose={onClose} />;
    }

    return (
        <div style={overlay} onClick={onClose}>
            <div style={dialog} onClick={(e) => e.stopPropagation()}>
                <div>
                    <h2 style={{ marginTop: 0 }}>Create invite</h2>
                    <label style={label}>Name
                        <input style={input} value={name} autoFocus
                            disabled={step === 'creating'}
                            placeholder="Who's this invite for?"
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
                    </label>
                    <div style={{ textAlign: 'right' }}>
                        <button onClick={onClose} disabled={step === 'creating'}>Cancel</button>{' '}
                        <button onClick={create} disabled={step === 'creating'}>Create</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// Admin affordance on a profile page: mint a link that re-establishes a session
// for THIS account (redeeming logs in as them, existing grants intact) — for
// helping a logged-out person reconnect under their profile. Global-admin only
// (see accounts.reconnect); the link is shown once via InviteLinkDialog.
function ReconnectButton({ accountId }) {
    const [state, setState] = useState('idle'); // idle | creating | done
    const [invite, setInvite] = useState(null);

    const create = async () => {
        setState('creating');
        const r = await api(`/accounts/${accountId}/reconnect`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        });
        if (!r || r.error) { setState('idle'); return; }
        setInvite(r);
        setState('done');
    };

    return (
        <div style={{ margin: '.6rem 0' }}>
            <button onClick={create} disabled={state === 'creating'}>
                {state === 'creating' ? 'Creating…' : 'New invite link'}
            </button>
            {' '}<span style={dim}>Reconnect this person under their existing profile.</span>
            {state === 'done' && (
                <InviteLinkDialog title="Reconnect link"
                    link={`${window.location.origin}/invites/?t=${invite.token}`}
                    onClose={() => setState('idle')} />
            )}
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
    const [avatar, setAvatar] = useState('');        // current pic ref, '' if none
    const [uploadPct, setUploadPct] = useState(null); // null = idle, 0..1 = busy
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
            setAvatar(a.avatar?.$blob ?? '');   // present in full + public views
            setGrants(a.grants);   // present only in the owner/admin full view
            setState('ready');
        })
        .catch(() => setState('missing'));
    useEffect(() => { loadAccount(); }, [accountId]);

    // Profile picture: upload to this account's own bucket (owner-or-admin
    // writes), stash the ref, persist on Save. The 2 MB evict-oldest bucket
    // means old pictures purge themselves as you upload new ones.
    const pickImage = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setUploadPct(0);
        try {
            const ref = await uploadBlob(`accounts/${accountId}`, file, setUploadPct);
            setAvatar(ref);
        }
        catch { /* keep the prior picture */ }
        setUploadPct(null);
    };

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
            {session.isAdmin && <ReconnectButton accountId={accountId} />}
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
            body: JSON.stringify({ name, avatar: avatar || null })
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
                        <Avatar name={name} avatar={avatar ? { $blob: avatar } : null} size={72} />
                        <div>
                            {uploadPct !== null ? (
                                <progress value={uploadPct} max={1} style={{ width: '12rem' }} />
                            ) : (
                                <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                                    <input type="file" accept="image/*" onChange={pickImage} />
                                    {avatar && (
                                        <button type="button" onClick={() => setAvatar('')}>Remove</button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                    <label style={label}>Display name
                        <input style={input} value={name} autoFocus
                            onChange={(e) => setName(e.target.value)} />
                    </label>
                    {rsvpLine}
                    <div>
                        <button onClick={save} disabled={state === 'saving' || uploadPct !== null}>Save</button>{' '}
                        <button onClick={goBack} disabled={state === 'saving'}>Cancel</button>
                    </div>
                </div>
            ) : (
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <Avatar name={name} avatar={avatar ? { $blob: avatar } : null} size={72} />
                        <p style={{ margin: 0, fontSize: '1.25rem' }}>{name || 'Unnamed'}</p>
                    </div>
                    {rsvpLine}
                    <p><button onClick={goBack}>← Back</button></p>
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
