import React, { useEffect, useState } from 'react';

// Fetches from the same paths the app is mounted at — Accept: application/json
// keeps the server from handing back the SPA shell. The admin token (if any) is
// stashed in localStorage by the /admin login helper.
const api = (path, opts = {}) => {
    const token = localStorage.getItem('velvet.accessToken');
    return fetch(path, {
        ...opts,
        headers: {
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...opts.headers
        }
    }).then((r) => r.json());
};

// Am I logged in as an admin? (Read the JWT's roles claim — no verification, we
// only need it to decide whether to offer the edit affordance.)
function isAdmin() {
    const token = localStorage.getItem('velvet.accessToken');
    if (!token) return false;
    try {
        const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = '='.repeat((4 - (b64.length % 4)) % 4);
        return (JSON.parse(atob(b64 + pad)).roles ?? []).includes('admin');
    } catch {
        return false;
    }
}

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
                <p>No events yet — you may not be signed in.</p>
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

function EventDetail({ id }) {
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
                    {isAdmin() && (
                        <button onClick={startEdit} style={iconBtn} title="Edit" aria-label="Edit">
                            ✏️
                        </button>
                    )}
                </div>
            )}

            <h2 style={dim}>Who's coming ({guests.length})</h2>
            {guests.length === 0 ? (
                <p>No RSVPs yet.</p>
            ) : (
                <ul>
                    {guests.map((g) => (
                        <li key={g.id}>
                            {g.name ?? g.id} — {g.response ?? 'no response'}
                            {g.guests?.length ? ` (+${g.guests.length})` : ''}
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
}

export default function App() {
    // Tiny path router: /events/:id → detail, everything else → the list.
    const match = window.location.pathname.match(/^\/events\/([^/]+)$/);
    return match ? <EventDetail id={match[1]} /> : <EventList />;
}
