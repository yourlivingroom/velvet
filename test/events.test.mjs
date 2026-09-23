import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeLogic, makeServer, seedEvent, seedAccount, grantTo, body
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// events — handler seam (behavior: shape, grading, schedule, config, list,
// members) and server seam (the `requires:/server/admin` route gate on create,
// which is enforced at the REST layer, not in the handler).
// ---------------------------------------------------------------------------

test('create: shape — metadata split from config, operative fields null', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h, { config: { title: 'Party' } });
    assert.match(ev.id, /^evt_/);
    assert.equal(ev.config.title, 'Party');
    assert.equal(ev.startsAt, null);
    assert.equal(ev.endsAt, null);
    assert.deepEqual(ev.members, []);
    assert.ok(ev.createdAt);
});

test('get: graded — admin full doc, view→user view, none→404(null)', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h, { config: { title: 'P', secretNote: 'x' } });

    // Admin sees the whole doc + an access block.
    const asAdmin = await h.actions['events.get'].handler(
            { eventId: ev.id }, await h.adminCtx());
    assert.equal(asAdmin.config.secretNote, 'x');
    assert.equal(asAdmin.access.admin, true);

    // A /view participant gets the whitelisted user view (no members leak).
    const { accountId: viewer } = await seedAccount(h,
            { grants: [`/events/${ev.id}/view`] });
    const asViewer = await h.actions['events.get'].handler(
            { eventId: ev.id }, await h.accountCtx(viewer));
    assert.deepEqual(Object.keys(asViewer).sort(),
            ['access', 'config', 'endsAt', 'guestList', 'id', 'startsAt']);
    assert.equal(asViewer.access.admin, false);
    assert.equal(asViewer.access.join, false);

    // A non-participant can't tell it exists.
    const { accountId: stranger } = await seedAccount(h, { grants: [] });
    assert.equal(await h.actions['events.get'].handler(
            { eventId: ev.id }, await h.accountCtx(stranger)), null);

    // A missing id is also null (→ 404).
    assert.equal(await h.actions['events.get'].handler(
            { eventId: 'evt_missing' }, await h.adminCtx()), null);
});

test('update: normalizes schedule, clears with null, rejects garbage', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const admin = await h.adminCtx();

    const set = await h.actions['events.update'].handler(
            { eventId: ev.id, startsAt: '2026-01-02T03:04:05Z' }, admin);
    assert.equal(set.startsAt, '2026-01-02T03:04:05.000Z');   // canonicalized
    assert.equal(set.endsAt, null);

    // Omitting startsAt leaves it; null clears endsAt.
    const set2 = await h.actions['events.update'].handler(
            { eventId: ev.id, endsAt: null }, admin);
    assert.equal(set2.startsAt, '2026-01-02T03:04:05.000Z');
    assert.equal(set2.endsAt, null);

    // Unparseable → 422.
    await assert.rejects(
            () => h.actions['events.update'].handler(
                    { eventId: ev.id, startsAt: 'not-a-date' }, admin),
            (e) => e.statusCode === 422);
});

test('update/patch/delete: gated in-handler on /events/:id/admin', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);

    // A bare account (no grant) is forbidden on every write.
    const { accountId } = await seedAccount(h, { grants: [] });
    const nobody = await h.accountCtx(accountId);
    for (const [name, input] of [
        ['events.update', { eventId: ev.id, startsAt: null }],
        ['events.patch', { eventId: ev.id, patch: [] }],
        ['events.delete', { eventId: ev.id }]
    ]) {
        await assert.rejects(async () => h.actions[name].handler(input, nobody),
                (e) => e.statusCode === 403, `${name} should 403`);
    }

    // Grant event-admin → the same writes now succeed.
    await grantTo(h, accountId, `/events/${ev.id}/admin`);
    const eventAdmin = await h.accountCtx(accountId);
    const patched = await h.actions['events.patch'].handler(
            { eventId: ev.id, patch: [{ op: 'add', path: '/venue', value: 'Hall' }] },
            eventAdmin);
    assert.equal(patched.config.venue, 'Hall');
});

test('patch: invalid JSON Patch → 422', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const admin = await h.adminCtx();
    await assert.rejects(
            () => h.actions['events.patch'].handler(
                    // 'test' op that fails a value comparison.
                    { eventId: ev.id, patch: [{ op: 'test', path: '/nope', value: 1 }] },
                    admin),
            (e) => e.statusCode === 422);
});

test('list: "my events" — participants only, time-ordered, when-scoped', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();

    // Three events: untimed, an upcoming one, and a fully-past one.
    const untimed = await seedEvent(h, { config: { t: 'untimed' } });
    const upcoming = await seedEvent(h, { config: { t: 'up' } });
    await h.actions['events.update'].handler(
            { eventId: upcoming.id, startsAt: '2099-01-01T00:00:00Z',
              endsAt: '2099-01-02T00:00:00Z' }, admin);
    const past = await seedEvent(h, { config: { t: 'past' } });
    await h.actions['events.update'].handler(
            { eventId: past.id, startsAt: '2000-01-01T00:00:00Z',
              endsAt: '2000-01-02T00:00:00Z' }, admin);

    // Admin (sees all): upcoming default hides the past one; untimed sorts first.
    const up = await h.actions['events.list'].handler({}, admin);
    assert.deepEqual(up.map((e) => e.id), [untimed.id, upcoming.id]);

    const pastList = await h.actions['events.list'].handler({ when: 'past' }, admin);
    assert.deepEqual(pastList.map((e) => e.id), [past.id]);

    const all = await h.actions['events.list'].handler({ when: 'all' }, admin);
    assert.equal(all.length, 3);
    assert.equal(all[0].id, untimed.id);   // untimed first under 'all' too

    // A scoped account sees only the events it participates in (byUser index).
    const { accountId } = await seedAccount(h, { grants: [] });
    await grantTo(h, accountId, `/events/${upcoming.id}/view`);
    const mine = await h.actions['events.list'].handler(
            { when: 'all' }, await h.accountCtx(accountId));
    assert.deepEqual(mine.map((e) => e.id), [upcoming.id]);
});

test('members: admin roster includes non-responders; hidden from non-admins', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedAccount(h, { name: 'Ada', grants: [] });
    await grantTo(h, accountId, `/events/${ev.id}/join`);

    const roster = await h.actions['events.members'].handler(
            { eventId: ev.id }, await h.adminCtx());
    const ada = roster.find((r) => r.id === accountId);
    assert.equal(ada.name, 'Ada');
    assert.equal(ada.response, null);       // invited, hasn't RSVP'd yet

    // A plain participant may not read the roster.
    const participant = await h.accountCtx(accountId);
    await assert.rejects(
            () => h.actions['events.members'].handler(
                    { eventId: ev.id }, participant),
            (e) => e.statusCode === 403);
});

// ---- server seam: the create route's /server/admin gate -------------------

test('server: POST /events requires admin (401 anon, 403 account, 200 admin)', async (t) => {
    const s = await makeServer(t);

    const anon = await s.anon().post('/events', { config: {} });
    assert.equal(anon.statusCode, 401);

    const account = await s.as('acct_x', []).post('/events', { config: {} });
    assert.equal(account.statusCode, 403);

    const admin = await s.asAdmin().post('/events', { config: {} });
    assert.equal(admin.statusCode, 200);
    assert.match(body(admin).id, /^evt_/);
});

test('server: event write gate maps ClientError 403 over HTTP', async (t) => {
    const s = await makeServer(t);
    const created = body(await s.asAdmin().post('/events', { config: {} }));

    // An account with no grant → in-handler assertPermission → 403 JSON.
    const res = await s.as('acct_y', []).patch(`/events/${created.id}`,
            { startsAt: null });
    assert.equal(res.statusCode, 403);
    assert.match(body(res).error, /Forbidden/);
});
