import React, { useContext, useEffect, useRef, useState } from 'react';
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

// Deterministic hue from a string, so a given name always gets the same
// placeholder color. Handed to CSS as the `--avatar-hue` custom property (a data
// hook, not a baked look) so a theme decides how — or whether — to use it.
function hashHue(s) {
    let h = 0;
    for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
}

// A round profile picture, or — with no picture — the name's first initial in a
// colored circle. `avatar` is the stored `{ $blob }` ref (or falsy).
function Avatar({ name, avatar, size = 24 }) {
    const cls = `avatar${size >= 48 ? ' avatar--lg' : ''}`;
    if (avatar?.$blob) {
        return <img className={cls} src={`/blobs/${avatar.$blob}`} alt="" />;
    }
    const initial = (name || '').trim().charAt(0).toUpperCase() || '?';
    return (
        <span className={`${cls} avatar--placeholder`}
            style={{ '--avatar-hue': hashHue(name) }}>
            {initial}
        </span>
    );
}

// A name link: mini avatar + display name, linking to the profile page. Pass
// `event` to render the profile relative to an event (RSVP line + grant control).
function UserLink({ id, name, avatar, event, size = 24 }) {
    const href = `/accounts/${id}${event ? `?event=${event}` : ''}`;
    return (
        <a className="user-link" href={href}>
            <Avatar name={name} avatar={avatar} size={size} />
            <span className="user-link__name">{name || id}</span>
        </a>
    );
}

function EventList() {
    const session = useSession();
    // `?when=past` renders the historical list; otherwise the upcoming list
    // (which hides events whose start AND end are both past — server-filtered).
    const past = new URLSearchParams(window.location.search).get('when') === 'past';
    const [events, setEvents] = useState(null);
    const [creating, setCreating] = useState(false);
    useEffect(() => {
        api(`/events?when=${past ? 'past' : 'upcoming'}`)
            .then(setEvents).catch(() => setEvents([]));
    }, [past]);

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
        <main>
            <h1>velvet</h1>
            <div className="list-head">
                <h2>{past ? 'Previous events' : 'Your events'}</h2>
                {!past && session.isAdmin && (
                    <button onClick={create} disabled={creating}>
                        {creating ? 'Creating…' : 'Create event'}
                    </button>
                )}
            </div>
            {events === null ? (
                <p>Loading…</p>
            ) : events.length === 0 ? (
                <p>{past ? 'No previous events.' : 'No upcoming events.'}</p>
            ) : (
                <ul>
                    {events.map((e) => (
                        <li key={e.id}>
                            <a href={`/events/${e.id}`}>{e.config?.title || e.id}</a>
                            {formatWhen(e.startsAt, e.endsAt) && (
                                <span className="event-list__time">
                                    — {formatWhen(e.startsAt, e.endsAt)}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            <p className="list-nav">
                {past
                    ? <a href="/events">← Upcoming events</a>
                    : <a href="/events?when=past">Previous events →</a>}
            </p>
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

// Parse a "guest slots" field: blank → the `empty` sentinel (undefined on create
// = "unset/unlimited", null on update = "clear to unlimited"); else an int ≥ 0.
const parseSlots = (v, empty) =>
    String(v).trim() === '' ? empty : Math.max(0, parseInt(v, 10) || 0);

// Only surface a config-supplied URL as a link if it's a safe scheme — config is
// set by event admins but rendered to invitees, so a `javascript:`/`data:` href
// would be stored XSS. Returns the url when safe, else null (render as plain text).
function safeHref(url) {
    return typeof url === 'string' && /^(https?:|mailto:|geo:|tel:)/i.test(url.trim())
        ? url.trim() : null;
}

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

// Inline trash icon — stroke=currentColor so it inherits the button's color
// (and recolors on hover), and scales with font-size. Fully CSS-themeable.
const TrashIcon = () => (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <line x1="10" y1="11" x2="10" y2="17" />
        <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
);

// Inline "add person" icon — currentColor + font-relative, like TrashIcon.
const UserPlusIcon = () => (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="19" y1="8" x2="19" y2="14" />
        <line x1="22" y1="11" x2="16" y2="11" />
    </svg>
);

// Inline "edit" pencil — currentColor + font-relative, like TrashIcon.
const PencilIcon = () => (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
);

// An image field that *is* its own preview: a click-anywhere frame showing the
// picked image (or a placeholder when empty), with replace/remove icon buttons
// overlaid once there's something to act on. The native file input is visually
// hidden — we can't use its built-in label anyway, since the pick handlers clear
// `value` after each choice (so re-picking the same file still fires a change)
// and the browser resets that text with it. `name` is only the alt text; the
// picture itself is the feedback. `progress` (0..1, or null) shows an upload.
// The overlay is a *sibling* of the frame label, not a child, so a click on an
// icon button doesn't also open the file dialog.
function ImagePicker({ accept = 'image/*', src, name, onChange, onRemove,
        disabled, progress = null, placeholder = 'Click to add an image…',
        className = '' }) {
    return (
        <div className={`image-picker ${className}`.trim()}>
            <label className="image-picker__frame" title={src ? 'Replace image' : 'Add an image'}>
                <input type="file" accept={accept} onChange={onChange} disabled={disabled} />
                {src
                    ? <img className="image-picker__preview" src={src} alt={name || ''} />
                    : <span className="image-picker__placeholder">{placeholder}</span>}
            </label>
            {src && (
                <div className="image-picker__actions">
                    <label className="icon-button" title="Replace image">
                        <input type="file" accept={accept} onChange={onChange} disabled={disabled} />
                        <PencilIcon />
                        <span className="sr-only">Replace image</span>
                    </label>
                    <button type="button" className="icon-button" title="Remove image"
                        onClick={onRemove} disabled={disabled}>
                        <TrashIcon />
                        <span className="sr-only">Remove image</span>
                    </button>
                </div>
            )}
            {progress !== null && (
                <progress className="image-picker__progress" value={progress} max={1} />
            )}
        </div>
    );
}

// Segmented RSVP control (shown to anyone with /join) + guest management. When
// the viewer is going/maybe they can add named guests: each is a clickable name
// that opens an inline editor (text box + Save + Remove). `current` is the
// viewer's response; `guests` their saved guest names — preserved across a
// response flip, and the whole reservation is re-PUT on any guest edit.
// `accountId` targets a specific account (an event admin managing someone else's
// RSVP from their profile page); omit for the caller's own. `showAllowanceNote`
// shows the second-person "you may bring…" line — off when an admin manages
// someone (the copy doesn't fit, and admins aren't capped anyway).
// `manage` turns on the admin controls (a "No response" option that clears the
// reservation, and a Revoke-invite button via `onRevoke`).
function RsvpStrip({ eventId, accountId, current, guests, allowance,
        showAllowanceNote = true, manage = false, onRevoke, onDone }) {
    const [saving, setSaving] = useState(false);
    const [editIdx, setEditIdx] = useState(null);   // null | index | 'new'
    const [editValue, setEditValue] = useState('');
    const [revoking, setRevoking] = useState(false);
    // allowance null = unlimited; a number caps how many guests you may bring.
    const atLimit = allowance != null && guests.length >= allowance;

    const put = async (response, nextGuests) => {
        setSaving(true);
        await api(`/events/${eventId}/reservation`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accountId, response, guests: nextGuests })
        });
        await onDone();
        setSaving(false);
    };

    // "No response" — delete the reservation so they're back to unanswered.
    const clearRsvp = async () => {
        if (current == null) return;
        setSaving(true);
        await api(`/events/${eventId}/reservation`
            + (accountId ? `?accountId=${accountId}` : ''), { method: 'DELETE' });
        await onDone();
        setSaving(false);
    };

    const setResponse = (response) => {
        if (saving || response === current) return;
        put(response, guests);
    };

    const commitGuests = (next) => { setEditIdx(null); put(current, next); };
    const startEdit = (idx, val) => { setEditIdx(idx); setEditValue(val); };
    const cancelEdit = () => setEditIdx(null);
    const saveEdit = () => {
        const v = editValue.trim();
        if (!v) return;   // Save is disabled while empty; guard anyway
        commitGuests(editIdx === 'new'
            ? [...guests, v]
            : guests.map((g, j) => (j === editIdx ? v : g)));
    };
    const removeGuest = (idx) => commitGuests(guests.filter((_, j) => j !== idx));

    // The inline editor row: text box + primary Save + Cancel, plus a red ✕ Remove
    // for an existing guest (a not-yet-saved new one is dropped via Cancel). Sized
    // to match the display chip's height so opening it doesn't shift the layout.
    const editRow = (idx) => (
        <span className="guest-edit">
            <input value={editValue} autoFocus aria-label="Guest name"
                placeholder="Guest name"
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); }} />
            <button className="primary" onClick={saveEdit}
                disabled={saving || !editValue.trim()}>Save</button>
            <button onClick={cancelEdit} disabled={saving}>Cancel</button>
            {idx !== 'new' && (
                <button className="danger" onClick={() => removeGuest(idx)}
                    disabled={saving} aria-label="Remove guest" title="Remove">
                    <TrashIcon />
                </button>
            )}
        </span>
    );

    const attending = current === 'going' || current === 'maybe';

    return (
        <div className="rsvp-block">
            <div className="rsvp">
                {RSVP_OPTIONS.map((o) => {
                    const active = o.value === current;
                    return (
                        <button key={o.value} onClick={() => setResponse(o.value)}
                            disabled={saving} aria-pressed={active}
                            className={`rsvp__option${active ? ' rsvp__option--active' : ''}`}>
                            {o.label}
                        </button>
                    );
                })}
                {manage && (
                    <button onClick={clearRsvp} disabled={saving}
                        aria-pressed={current == null}
                        className={`rsvp__option${current == null ? ' rsvp__option--active' : ''}`}>
                        No response
                    </button>
                )}
            </div>
            {attending && (
                <div className="guests">
                    {guests.length > 0 && <h3 className="guests__heading">Your Guests</h3>}
                    <ul className="guest-list">
                        {guests.map((g, i) => (
                            <li key={i} className="guest">
                                {editIdx === i ? editRow(i) : (
                                    <button className="guest__name" onClick={() => startEdit(i, g)}>
                                        {g || '(unnamed)'}
                                    </button>
                                )}
                            </li>
                        ))}
                        {editIdx === 'new' && (
                            <li className="guest">{editRow('new')}</li>
                        )}
                    </ul>
                    {!atLimit && editIdx !== 'new' && (
                        <button className="subtle" onClick={() => startEdit('new', '')}
                            disabled={saving}>
                            <UserPlusIcon />
                            Add guest
                        </button>
                    )}
                    {showAllowanceNote && (
                        <p className="muted guests__limit">
                            {allowance == null
                                ? 'You are welcome to bring guests!'
                                : allowance === 0
                                    ? 'Unfortunately, no +1s are allowed.'
                                    : allowance === 1
                                        ? 'You are welcome to bring a guest!'
                                        : `You are welcome to bring up to ${allowance} guests!`}
                        </p>
                    )}
                </div>
            )}
            {manage && onRevoke && (
                <div className="rsvp__admin">
                    <button className="danger" onClick={() => setRevoking(true)}>
                        Revoke invite
                    </button>
                    {revoking && (
                        <ConfirmModal title="Revoke invite?"
                            message="This removes them from the event entirely — their RSVP, guests, and access."
                            confirmLabel="Revoke invite" danger busy={saving}
                            onConfirm={async () => { setSaving(true); await onRevoke(); }}
                            onClose={() => setRevoking(false)} />
                    )}
                </div>
            )}
        </div>
    );
}

// The event cover as a full-view wallpaper. It fills the viewport in "cover" mode;
// but if the image is too small to cover without noticeable upscaling, it's shown
// centered at its natural size over a blurred, enlarged copy of itself. Whether
// it's "too small" is a measurement (image natural size vs viewport) — a JS datum
// handed to CSS as `data-fit`; CSS owns every actual look (cover, blur, scale,
// scrim), tunable via --wallpaper-blur / --event-scrim etc.
const WALLPAPER_UPSCALE_LIMIT = 1.1;   // tolerate a slight cover upscale before switching to center+blur
function EventWallpaper({ src }) {
    const [fit, setFit] = useState('cover');   // 'cover' | 'center'
    useEffect(() => {
        if (!src) return;
        const img = new Image();
        img.src = src;
        const decide = () => {
            if (!img.naturalWidth) return;
            const coverScale = Math.max(
                window.innerWidth / img.naturalWidth,
                window.innerHeight / img.naturalHeight);
            setFit(coverScale > WALLPAPER_UPSCALE_LIMIT ? 'center' : 'cover');
        };
        img.onload = decide;
        if (img.complete) decide();                 // already cached
        window.addEventListener('resize', decide);   // re-decide on viewport change
        return () => window.removeEventListener('resize', decide);
    }, [src]);
    // No cover → a default gradient wallpaper (themeable via --event-gradient).
    if (!src) {
        return <div className="event-wallpaper event-wallpaper--gradient" aria-hidden="true" />;
    }
    return (
        <div className="event-wallpaper" data-fit={fit} aria-hidden="true"
            style={{ '--wallpaper': `url("${src}")` }}>
            <div className="event-wallpaper__backdrop" />
            <img className="event-wallpaper__fg" src={src} alt="" />
        </div>
    );
}

// The dedicated event editor at /events/:id/edit — just the edit form, no
// event display. It keeps EventDetail's "card over the cover" chrome (wallpaper
// behind, event-body panel in front) so an admin gets a live feel for the theme
// and cover photo while editing; the wallpaper tracks the *pending* pick so a new
// cover previews before Save. Save/Cancel navigate back to the event.
function EventEdit({ id }) {
    const [event, setEvent] = useState(undefined);
    const [form, setForm] = useState({
        title: '', description: '', startsAt: '', endsAt: '', picture: '',
        location: '', locationHref: ''
    });
    const [saving, setSaving] = useState(false);
    const [uploadPct, setUploadPct] = useState(null);   // null = idle, 0..1 = busy
    const [pickedName, setPickedName] = useState('');  // filename we show ourselves

    const back = `/events/${id}`;

    // Unsaved-changes guard. Because navigation here is full page loads (the back
    // link, browser back, tab close), the browser's native beforeunload prompt is
    // the right seam. `pristineRef` is the form as loaded; the form is "dirty" when
    // it diverges. Save/Cancel are the *explicit* exits, so they raise `bypassRef`
    // to suppress the prompt on their own navigation. Refs (not state) so the
    // once-registered listener always reads the latest values without re-binding.
    const pristineRef = useRef(null);
    const dirtyRef = useRef(false);
    const bypassRef = useRef(false);
    dirtyRef.current = pristineRef.current !== null
        && JSON.stringify(form) !== pristineRef.current;

    useEffect(() => {
        const onBeforeUnload = (e) => {
            if (dirtyRef.current && !bypassRef.current) {
                e.preventDefault();
                e.returnValue = '';   // legacy browsers require a set returnValue
            }
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, []);

    useEffect(() => {
        api(`/events/${id}`)
            .then((e) => {
                setEvent(e);
                const config = e?.config ?? {};
                const loaded = {
                    title: config.title ?? '',
                    description: config.description ?? '',
                    startsAt: toLocalInput(e?.startsAt),
                    endsAt: toLocalInput(e?.endsAt),
                    picture: config.picture?.$blob ?? '',   // the current cover's ref
                    location: config.location ?? '',
                    locationHref: config.locationHref ?? ''
                };
                setForm(loaded);
                pristineRef.current = JSON.stringify(loaded);
            })
            .catch(() => setEvent(null));
    }, [id]);

    if (event === undefined) {
        return <main><p>Loading…</p></main>;
    }
    if (!event || event.error || !event.access?.admin) {
        return (
            <main>
                <p className="back"><a href={back}>← event</a></p>
                <p>{!event || event.error ? 'Event not found.'
                    : 'You don’t have permission to edit this event.'}</p>
            </main>
        );
    }

    const config = event.config ?? {};

    // Cover image: upload to this event's bucket (event admins can write it),
    // then stash the returned $blob ref in the form — persisted on Save.
    const pickImage = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';   // allow re-picking the same file
        if (!file) return;
        setPickedName(file.name);
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
        if (form.location) {
            patch.push({ op: 'add', path: '/location', value: form.location });
        } else if (config.location !== undefined) {
            patch.push({ op: 'remove', path: '/location' });
        }
        // Only keep a link if there's a location to attach it to.
        if (form.location && form.locationHref) {
            patch.push({ op: 'add', path: '/locationHref', value: form.locationHref });
        } else if (config.locationHref !== undefined) {
            patch.push({ op: 'remove', path: '/locationHref' });
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
        bypassRef.current = true;   // an explicit save — don't prompt on the way out
        window.location.href = back;
    };

    // The wallpaper tracks the *pending* pick (form.picture) so a new cover
    // live-previews. No cover → EventWallpaper falls back to the default gradient.
    const coverUrl = form.picture ? `/blobs/${form.picture}` : null;

    return (
        <main className="event-page">
            <EventWallpaper src={coverUrl} />
            <p className="back"><a href={back}>← event</a></p>
            <div className="event-body">
                <label>Title
                    <input value={form.title} autoFocus
                        onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </label>
                <label>Description
                    <textarea value={form.description}
                        onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </label>
                <label>Location
                    <input value={form.location}
                        placeholder="e.g. Grandma's house"
                        onChange={(e) => setForm({ ...form, location: e.target.value })} />
                </label>
                <label>Location link (optional)
                    <input type="url" value={form.locationHref}
                        placeholder="https://maps.example.com/…"
                        disabled={!form.location}
                        onChange={(e) => setForm({ ...form, locationHref: e.target.value })} />
                </label>
                <label>Starts
                    <input type="datetime-local" value={form.startsAt}
                        onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
                </label>
                <label>Ends
                    <input type="datetime-local" value={form.endsAt}
                        onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
                </label>
                <label>Cover image</label>
                <div className="cover-edit">
                    <ImagePicker
                        src={form.picture ? `/blobs/${form.picture}` : null}
                        name={pickedName} onChange={pickImage}
                        onRemove={() => { setForm({ ...form, picture: '' }); setPickedName(''); }}
                        disabled={uploadPct !== null} progress={uploadPct} />
                </div>
                <div className="actions">
                    <button onClick={save} disabled={saving || uploadPct !== null}>Save</button>
                    <button onClick={() => { bypassRef.current = true; window.location.href = back; }}
                        disabled={saving}>Cancel</button>
                </div>
            </div>
        </main>
    );
}

function EventDetail({ id }) {
    const session = useSession();
    const [event, setEvent] = useState(undefined);

    const load = () => api(`/events/${id}`).then(setEvent).catch(() => setEvent(null));
    useEffect(() => { load(); }, [id]);

    if (event === undefined) {
        return <main><p>Loading…</p></main>;
    }
    if (!event || event.error) {
        return (
            <main>
                <p className="back"><a href="/events">← events</a></p>
                <p>Event not found.</p>
            </main>
        );
    }

    const config = event.config ?? {};
    const guests = event.guestList ?? [];
    // My own RSVP (if any) — the guest list is keyed by account id.
    const mine = guests.find((g) => g.id === session.accountId);

    // No cover → EventWallpaper falls back to the default gradient.
    const coverRef = config.picture?.$blob ?? '';
    const coverUrl = coverRef ? `/blobs/${coverRef}` : null;

    return (
        <main className="event-page">
            <EventWallpaper src={coverUrl} />
            <p className="back"><a href="/events">← events</a></p>
            <div className="event-body">

            <div className="event-detail__header">
                <div>
                    {/* the cover is the full-view wallpaper (behind) */}
                    <h1>{config.title || event.id}</h1>
                    {formatWhen(event.startsAt, event.endsAt) && (
                        <p className="event-when">{formatWhen(event.startsAt, event.endsAt)}</p>
                    )}
                    {config.location && (
                        <p className="event-location">
                            {safeHref(config.locationHref) ? (
                                <a href={safeHref(config.locationHref)}
                                    target="_blank" rel="noopener noreferrer">
                                    {config.location}
                                </a>
                            ) : config.location}
                        </p>
                    )}
                    {config.description && (
                        <p className="event-description">{config.description}</p>
                    )}
                </div>
                {event.access?.admin && (
                    <a className="icon-button" href={`/events/${id}/edit`}
                        title="Edit" aria-label="Edit">
                        ✏️
                    </a>
                )}
            </div>

            {event.access?.join && (
                <RsvpStrip eventId={id} current={mine?.response}
                    guests={mine?.guests ?? []}
                    allowance={event.access?.guestAllowance} onDone={load} />
            )}

            {event.access?.admin && <AdminActions eventId={id} />}

            <Rsvps guests={guests} eventId={id} />
            </div>
        </main>
    );
}

// The RSVP roster, split by response. "Who's Going" holds the going responses
// then the maybes (tagged "(maybe going)"); a second tab holds the "Can't go"
// declines. (No-response invitees aren't shown here — see User management.)
function Rsvps({ guests, eventId }) {
    const [tab, setTab] = useState('going'); // 'going' | 'cant'
    const going = guests.filter((g) => g.response === 'going');
    const maybe = guests.filter((g) => g.response === 'maybe');
    const notGoing = guests.filter((g) => g.response === 'not-going');
    // Head count = each attendee plus their guests.
    const heads = (list) => list.reduce((n, g) => n + 1 + (g.guests?.length ?? 0), 0);

    const row = (g, note) => (
        <li key={g.id} className="roster__item">
            <UserLink id={g.id} name={g.name} avatar={g.avatar} event={eventId} />
            {note ? <span className="muted">{note}</span> : null}
            {g.guests?.length ? <span className="muted">(+{g.guests.length})</span> : null}
        </li>
    );
    const tabBtn = (key, text, count) => (
        <button onClick={() => setTab(key)}
            className={`tab${tab === key ? ' tab--active' : ''}`}>
            {text} ({count})
        </button>
    );

    return (
        <div>
            <div className="tabs">
                {tabBtn('going', "Who's Going", heads(going) + heads(maybe))}
                {tabBtn('cant', "Can't go", notGoing.length)}
            </div>
            {tab === 'going' ? (
                going.length + maybe.length === 0 ? (
                    <p>No RSVPs yet.</p>
                ) : (
                    <ul className="roster">
                        {going.map((g) => row(g))}
                        {maybe.map((g) => row(g, '(maybe going)'))}
                    </ul>
                )
            ) : (
                notGoing.length === 0 ? (
                    <p>Nobody has declined.</p>
                ) : (
                    <ul className="roster">{notGoing.map((g) => row(g))}</ul>
                )
            )}
        </div>
    );
}

// Admin-only user-management page (/events/:id/users): every account associated
// with the event — including those who haven't responded — with their current
// RSVP and a control to revoke their invite (remove them from the event).
function EventUsers({ eventId }) {
    const session = useSession();
    const [roster, setRoster] = useState(undefined); // undefined=loading, null=no access
    const load = () => api(`/events/${eventId}/members`)
        .then((r) => setRoster(Array.isArray(r) ? r : null))
        .catch(() => setRoster(null));
    useEffect(() => { load(); }, [eventId]);

    const revoke = async (accountId) => {
        await api(`/events/${eventId}/members/${accountId}`, { method: 'DELETE' });
        await load();
    };

    if (roster === undefined) {
        return <main><p>Loading…</p></main>;
    }
    if (roster === null) {
        return (
            <main>
                <p className="back"><a href={`/events/${eventId}`}>← event</a></p>
                <p>You don't have access to manage this event.</p>
            </main>
        );
    }
    return (
        <main>
            <p className="back"><a href={`/events/${eventId}`}>← event</a></p>
            <h1>User management</h1>
            {roster.length === 0 ? (
                <p>No one is associated with this event yet.</p>
            ) : (
                <ul className="roster">
                    {roster.map((u) => (
                        <RosterRow key={u.id} user={u} eventId={eventId}
                            onRevoke={revoke}
                            canRevoke={u.id !== session.accountId} />
                    ))}
                </ul>
            )}
        </main>
    );
}

// One roster row: identity + RSVP status, with a "Revoke invite" that removes
// their event access and RSVP — confirmed via ConfirmModal.
function RosterRow({ user, eventId, onRevoke, canRevoke }) {
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const status = RSVP_LABELS[user.response] ?? 'No response';
    return (
        <li className="roster__item">
            <UserLink id={user.id} name={user.name} avatar={user.avatar} event={eventId} />
            <span className="roster__status">
                {status}{user.guests?.length ? ` (+${user.guests.length})` : ''}
            </span>
            {canRevoke && (
                <span className="roster__actions">
                    <button className="danger" onClick={() => setConfirming(true)}>Revoke invite</button>
                </span>
            )}
            {confirming && (
                <ConfirmModal title="Revoke invite?"
                    message={`This removes ${user.name || 'this person'} from the event — their RSVP, guests, and access.`}
                    confirmLabel="Revoke invite" danger busy={busy}
                    onConfirm={async () => { setBusy(true); await onRevoke(user.id); }}
                    onClose={() => setConfirming(false)} />
            )}
        </li>
    );
}

// Admin-only open-invites page (/events/:id/invites): invite links that have
// been created for the event but not yet redeemed, each invalidatable.
function EventInvites({ eventId }) {
    const [invites, setInvites] = useState(undefined); // undefined=loading, null=no access
    const load = () => api(`/events/${eventId}/invites`)
        .then((r) => setInvites(Array.isArray(r) ? r : null))
        .catch(() => setInvites(null));
    useEffect(() => { load(); }, [eventId]);

    const invalidate = async (inviteId) => {
        await api(`/events/${eventId}/invites/${inviteId}`, { method: 'DELETE' });
        await load();
    };
    const update = async (inviteId, patch) => {
        await api(`/events/${eventId}/invites/${inviteId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch)
        });
        await load();
    };

    if (invites === undefined) {
        return <main><p>Loading…</p></main>;
    }
    if (invites === null) {
        return (
            <main>
                <p className="back"><a href={`/events/${eventId}`}>← event</a></p>
                <p>You don't have access to manage this event.</p>
            </main>
        );
    }
    return (
        <main>
            <p className="back"><a href={`/events/${eventId}`}>← event</a></p>
            <h1>Open invites</h1>
            {invites.length === 0 ? (
                <p>No open invites — every link has been redeemed (or none created
                    yet). Create one from the event's Admin actions.</p>
            ) : (
                <ul className="roster">
                    {invites.map((inv) => (
                        <InviteRow key={inv.id} invite={inv}
                            onInvalidate={invalidate} onUpdate={update} />
                    ))}
                </ul>
            )}
        </main>
    );
}

// One open-invite row: name + guest allowance + created date, with Edit (name +
// guest slots) and a two-click Invalidate (deletes the invite so its link dies).
function InviteRow({ invite, onInvalidate, onUpdate }) {
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState('');
    const [slots, setSlots] = useState('');
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const created = invite.createdAt
        ? new Date(invite.createdAt).toLocaleDateString() : null;
    const allowanceLabel = invite.guestAllowance == null
        ? 'unlimited guests'
        : `${invite.guestAllowance} guest${invite.guestAllowance === 1 ? '' : 's'}`;

    const startEdit = () => {
        setName(invite.name ?? '');
        setSlots(invite.guestAllowance ?? '');
        setEditing(true);
    };
    const save = async () => {
        setBusy(true);
        await onUpdate(invite.id, { name, guestAllowance: parseSlots(slots, null) });
        setBusy(false);
        setEditing(false);
    };

    if (editing) {
        return (
            <li className="roster__item invite-edit">
                <input aria-label="Invite name" value={name} placeholder="Name"
                    onChange={(e) => setName(e.target.value)} />
                <input aria-label="Guest slots" type="number" min="0" value={slots}
                    placeholder="unlimited" onChange={(e) => setSlots(e.target.value)} />
                <span className="roster__actions">
                    <button className="primary" onClick={save} disabled={busy}>Save</button>
                    <button onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
                </span>
            </li>
        );
    }
    return (
        <li className="roster__item">
            <span>{invite.name || 'Unnamed invite'}</span>
            <span className="muted">
                {allowanceLabel}{created ? ` · created ${created}` : ''}
            </span>
            <span className="roster__actions">
                <button onClick={startEdit}>Edit</button>
                <button className="danger" onClick={() => setConfirming(true)}>Invalidate</button>
            </span>
            {confirming && (
                <ConfirmModal title="Invalidate invite?"
                    message={`The link for "${invite.name || 'this invite'}" will stop working.`}
                    confirmLabel="Invalidate" danger busy={busy}
                    onConfirm={async () => { setBusy(true); await onInvalidate(invite.id); }}
                    onClose={() => setConfirming(false)} />
            )}
        </li>
    );
}

function AdminActions({ eventId }) {
    const [inviting, setInviting] = useState(false);
    return (
        <details className="admin-actions">
            <summary>Admin actions</summary>
            <div className="admin-actions__links">
                <button onClick={() => setInviting(true)}>Create invite</button>
                <a href={`/events/${eventId}/users`}>User management</a>
                <a href={`/events/${eventId}/invites`}>Open invites</a>
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
        <div className="overlay" onClick={onClose}>
            <div className="dialog" onClick={(e) => e.stopPropagation()}>
                <h2>{title}</h2>
                <div className="qr">
                    {/* fgColor=currentColor + transparent bg hands the QR's colors
                        to CSS (.qr svg): themeable via --qr-fg/--qr-bg, reactive,
                        no JS. Only the module *shapes* stay lib-controlled. */}
                    <QRCodeSVG value={link} size={180} includeMargin
                        fgColor="currentColor" bgColor="transparent" />
                </div>
                <label>Invite link</label>
                <div className="copy-row">
                    <input readOnly value={link} onFocus={(e) => e.target.select()} />
                    <button onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
                </div>
                <div className="actions actions--end">
                    <button onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}

function CreateInviteModal({ eventId, onClose }) {
    const [step, setStep] = useState('name'); // name | creating | done
    const [name, setName] = useState('');
    const [slots, setSlots] = useState('');   // '' = unlimited guests
    const [invite, setInvite] = useState(null);

    const create = async () => {
        setStep('creating');
        // Invite scoped to this event: the redeemer's account can view it and
        // RSVP. `entrypoint` lands them here; `name` seeds their display name;
        // `guestAllowance` caps how many guests they may bring (blank = unlimited).
        const result = await api('/invites', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: name || undefined,
                entrypoint: `/events/${eventId}`,
                grants: [`/events/${eventId}/view`, `/events/${eventId}/join`],
                guestAllowance: parseSlots(slots, undefined)
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
        <div className="overlay" onClick={onClose}>
            <div className="dialog" onClick={(e) => e.stopPropagation()}>
                <h2>Create invite</h2>
                <label>Name
                    <input value={name} autoFocus
                        disabled={step === 'creating'}
                        placeholder="Who's this invite for?"
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
                </label>
                <label>Guest slots
                    <input type="number" min="0" value={slots}
                        disabled={step === 'creating'}
                        placeholder="unlimited"
                        onChange={(e) => setSlots(e.target.value)} />
                </label>
                <div className="actions actions--end">
                    <button onClick={onClose} disabled={step === 'creating'}>Cancel</button>
                    <button className="primary" onClick={create} disabled={step === 'creating'}>Create</button>
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
        <div className="reconnect">
            <button onClick={create} disabled={state === 'creating'}>
                {state === 'creating' ? 'Creating…' : 'New invite link'}
            </button>{' '}
            <span className="muted">Reconnect this person under their existing profile.</span>
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
        <div className="grant-row">
            <span className="grant-row__label">
                {label}{known && has ? ' — granted' : ''}
            </span>
            {known ? (
                has
                    ? <button onClick={revoke} disabled={busy}>Revoke</button>
                    : <button onClick={grant} disabled={busy}>Grant</button>
            ) : (
                <span className="roster__actions">
                    <button onClick={grant} disabled={busy}>Grant</button>
                    <button onClick={revoke} disabled={busy}>Revoke</button>
                </span>
            )}
        </div>
    );
}

// Full profile page at /accounts/:accountId. Display name + profile picture.
// Editable only when it's your own account; others see a read-only view (the
// server hands peers just { id, name, avatar }). A ?event=<eventId> renders the
// page relative to that event, adding the account's RSVP status below the name
// and (for an admin of that event) an event-admin grant control.
function AccountPage({ accountId }) {
    const [name, setName] = useState('');
    const [avatar, setAvatar] = useState('');        // current pic ref, '' if none
    const [uploadPct, setUploadPct] = useState(null); // null = idle, 0..1 = busy
    const [pickedName, setPickedName] = useState('');  // filename we show ourselves
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
        setPickedName(file.name);
        setUploadPct(0);
        try {
            const ref = await uploadBlob(`accounts/${accountId}`, file, setUploadPct);
            setAvatar(ref);
        }
        catch { /* keep the prior picture */ }
        setUploadPct(null);
    };

    // Event context: read this account's RSVP (response + guests) out of the
    // event's guest list, and note whether *we* admin it. Reloaded after an admin
    // edits the RSVP via the strip below.
    const loadEventRsvp = () => {
        if (!eventId) return Promise.resolve();
        return api(`/events/${eventId}`)
            .then((e) => {
                if (!e || e.error) return;
                setEventAdmin(!!e.access?.admin);
                const entry = (e.guestList ?? []).find((g) => g.id === accountId);
                setEventRsvp({
                    response: entry?.response ?? null,
                    guests: entry?.guests ?? []
                });
            })
            .catch(() => {});
    };
    useEffect(() => { loadEventRsvp(); }, [eventId, accountId]);

    // Revoke: remove this account from the event entirely, then land on the
    // event's user-management list (they'll be gone from it).
    const revokeMember = async () => {
        await api(`/events/${eventId}/members/${accountId}`, { method: 'DELETE' });
        window.location.href = `/events/${eventId}/users`;
    };

    // An event admin viewing someone else's profile gets the full RSVP system so
    // they can set that person's status and guests (admins aren't guest-capped),
    // clear it ("No response"), or revoke the invite; everyone else sees the
    // read-out line.
    const rsvpSection = !(eventId && eventRsvp) ? null
        : (eventAdmin && !mine) ? (
            <RsvpStrip eventId={eventId} accountId={accountId}
                current={eventRsvp.response} guests={eventRsvp.guests ?? []}
                allowance={null} showAllowanceNote={false} manage
                onRevoke={revokeMember} onDone={loadEventRsvp} />
        ) : (
            <p className="rsvp-status">{RSVP_LABELS[eventRsvp.response] ?? 'No Response'}</p>
        );

    // Grant affordances: never on your own profile. Full admin needs `**` (i.e.
    // a global admin); event admin needs to admin *this* event.
    const adminControls = !mine && (session.isAdmin || (eventId && eventAdmin)) ? (
        <div>
            <hr />
            <h2>Admin</h2>
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

    const avatarObj = avatar ? { $blob: avatar } : null;

    return (
        <main>
            <h1>Profile</h1>
            {state === 'loading' ? (
                <p>Loading…</p>
            ) : state === 'missing' ? (
                <p>Profile not found.</p>
            ) : mine ? (
                <div>
                    <div className="profile__head">
                        <ImagePicker className="image-picker--avatar"
                            src={avatar ? `/blobs/${avatar}` : null}
                            name={pickedName} onChange={pickImage}
                            onRemove={() => { setAvatar(''); setPickedName(''); }}
                            disabled={uploadPct !== null} progress={uploadPct}
                            placeholder={<Avatar name={name} avatar={null} size={72} />} />
                    </div>
                    <label>Display name
                        <input value={name} autoFocus
                            onChange={(e) => setName(e.target.value)} />
                    </label>
                    {rsvpSection}
                    <div className="actions">
                        <button onClick={save} disabled={state === 'saving' || uploadPct !== null}>Save</button>
                        <button onClick={goBack} disabled={state === 'saving'}>Cancel</button>
                    </div>
                </div>
            ) : (
                <div>
                    <div className="profile__head">
                        <Avatar name={name} avatar={avatarObj} size={72} />
                        <p className="profile__name">{name || 'Unnamed'}</p>
                    </div>
                    {rsvpSection}
                    <p><button onClick={goBack}>← Back</button></p>
                    {adminControls}
                </div>
            )}
        </main>
    );
}

// Reusable "Are you sure?" confirmation modal. `danger` styles the confirm as a
// destructive action; `busy` disables the buttons while the action runs.
function ConfirmModal({ title, message, confirmLabel = 'Confirm', danger,
        busy, onConfirm, onClose }) {
    return (
        <div className="overlay" onClick={busy ? undefined : onClose}>
            <div className="dialog" onClick={(e) => e.stopPropagation()}>
                <h2>{title}</h2>
                {message && <p>{message}</p>}
                <div className="actions actions--end">
                    <button onClick={onClose} disabled={busy}>Cancel</button>
                    <button className={danger ? 'danger' : 'primary'}
                        onClick={onConfirm} disabled={busy}>
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}

function LogoutModal({ onClose }) {
    const [busy, setBusy] = useState(false);
    const logout = async () => {
        setBusy(true);
        await api('/session', { method: 'DELETE' });   // clears the cookie server-side
        window.location.href = '/';
    };
    return (
        <ConfirmModal title="Really log out?"
            message="You will need to be re-invited."
            confirmLabel="Log out" busy={busy}
            onConfirm={logout} onClose={onClose} />
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
        <div className="profile-menu" onClick={(e) => e.stopPropagation()}>
            <button className="icon-button" title="Profile" aria-label="Profile"
                aria-haspopup="menu" aria-expanded={open}
                onClick={() => setOpen((v) => !v)}>
                👤
            </button>
            {open && (
                <div className="menu" role="menu">
                    <a className="menu__item" role="menuitem" href={`/accounts/${me.accountId}`}>
                        Edit profile
                    </a>
                    <button className="menu__item" role="menuitem"
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
        <main>
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
        <main>
            <h1>velvet</h1>
            <p>You are not logged in.</p>
            <p className="muted">
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
        return <main><p>Loading…</p></main>;
    }
    if (!session) return <NotLoggedIn />;

    const account = path.match(/^\/accounts\/([^/]+)$/);
    const eventUsers = path.match(/^\/events\/([^/]+)\/users$/);
    const eventInvites = path.match(/^\/events\/([^/]+)\/invites$/);
    const eventEdit = path.match(/^\/events\/([^/]+)\/edit$/);
    const event = path.match(/^\/events\/([^/]+)$/);
    return (
        <SessionContext.Provider value={session}>
            <ProfileMenu />
            {account ? <AccountPage accountId={account[1]} />
                : eventUsers ? <EventUsers eventId={eventUsers[1]} />
                : eventInvites ? <EventInvites eventId={eventInvites[1]} />
                : eventEdit ? <EventEdit id={eventEdit[1]} />
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
