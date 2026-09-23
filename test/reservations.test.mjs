import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeLogic, makeServer, seedEvent, seedAccount, grantTo, body
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// reservations — an account's RSVP to an event. Every op routes through
// reservationTarget (logic.mjs ~174): gated in-handler on /events/:id/join
// (plus admin-over-event for acting on someone else). Denials THROW ClientError
// (403/400/422); "hidden" (no join grant, or no such event) returns null (→404).
// reservations.set additionally enforces the reserver's guestAllowance.
// ---------------------------------------------------------------------------

// A join-holding account, freshly seeded and granted. Sugar over the seed pair.
async function seedJoiner(h, eventId, opts = {}) {
    const { accountId, invite } = await seedAccount(h, opts);
    await grantTo(h, accountId, `/events/${eventId}/join`);
    return { accountId, invite };
}

// ---- happy path -----------------------------------------------------------

test('set: happy path — join-holder RSVPs for self; get reads it back', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedJoiner(h, ev.id);
    const ctx = await h.accountCtx(accountId);

    const saved = await h.actions['reservations.set'].handler(
            { eventId: ev.id, response: 'going', guests: ['Bob'] }, ctx);
    assert.equal(saved.eventId, ev.id);
    assert.equal(saved.accountId, accountId);   // defaults to the caller
    assert.equal(saved.response, 'going');
    assert.deepEqual(saved.guests, ['Bob']);
    assert.equal(saved.id, `${ev.id}~${accountId}`);
    assert.ok(saved.createdAt);
    assert.ok(saved.updatedAt);

    const got = await h.actions['reservations.get'].handler(
            { eventId: ev.id }, await h.accountCtx(accountId));
    assert.deepEqual(got.guests, ['Bob']);
    assert.equal(got.response, 'going');
});

test('set: accepts each response value; update overwrites, preserves createdAt', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedJoiner(h, ev.id);

    let prevCreatedAt;
    for (const response of ['going', 'maybe', 'not-going']) {
        const r = await h.actions['reservations.set'].handler(
                { eventId: ev.id, response }, await h.accountCtx(accountId));
        assert.equal(r.response, response);
        assert.deepEqual(r.guests, []);          // guests omitted → []
        if (prevCreatedAt) assert.equal(r.createdAt, prevCreatedAt);
        prevCreatedAt = r.createdAt;
    }
});

// ---- hiding (null → 404) --------------------------------------------------

test('hide: no join grant → set/get/delete return null (→404)', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedAccount(h, { grants: [] });   // no join
    const ctx = await h.accountCtx(accountId);

    assert.equal(await h.actions['reservations.set'].handler(
            { eventId: ev.id, response: 'going' }, ctx), null);
    assert.equal(await h.actions['reservations.get'].handler(
            { eventId: ev.id }, await h.accountCtx(accountId)), null);
    assert.equal(await h.actions['reservations.delete'].handler(
            { eventId: ev.id }, await h.accountCtx(accountId)), null);
});

test('hide: join-holder targeting a non-existent event → null', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    // Grant join on the real event, then aim at a bogus id we also "join"-hold.
    const { accountId } = await seedAccount(h, { grants: [] });
    await grantTo(h, accountId, '/events/evt_missing/join');
    const ctx = await h.accountCtx(accountId);

    assert.equal(await h.actions['reservations.set'].handler(
            { eventId: 'evt_missing', response: 'going' }, ctx), null);
    assert.equal(await h.actions['reservations.get'].handler(
            { eventId: 'evt_missing' }, await h.accountCtx(accountId)), null);
});

test('hide: anonymous caller → null (hide path, not a 400)', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    // Anon has no grants, so reservationTarget hides before the acctId check.
    assert.equal(await h.actions['reservations.get'].handler(
            { eventId: ev.id }, await h.anonCtx()), null);
});

// ---- guest allowance ------------------------------------------------------

test('set: guest allowance — capped account 422s over its cap, ok at/under', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedJoiner(h, ev.id, { guestAllowance: 1 });

    // Two guests over a cap of one → 422.
    await assert.rejects(
            async () => h.actions['reservations.set'].handler(
                    { eventId: ev.id, response: 'going', guests: ['A', 'B'] },
                    await h.accountCtx(accountId)),
            (e) => e.statusCode === 422);

    // One guest is fine.
    const one = await h.actions['reservations.set'].handler(
            { eventId: ev.id, response: 'going', guests: ['A'] },
            await h.accountCtx(accountId));
    assert.deepEqual(one.guests, ['A']);

    // Zero guests is fine.
    const none = await h.actions['reservations.set'].handler(
            { eventId: ev.id, response: 'maybe', guests: [] },
            await h.accountCtx(accountId));
    assert.deepEqual(none.guests, []);
});

test('set: unlimited allowance (omitted) may seat many guests', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    // guestAllowance omitted → null → no cap.
    const { accountId } = await seedJoiner(h, ev.id);
    const many = ['A', 'B', 'C', 'D', 'E'];
    const r = await h.actions['reservations.set'].handler(
            { eventId: ev.id, response: 'going', guests: many },
            await h.accountCtx(accountId));
    assert.deepEqual(r.guests, many);
});

// ---- admin exemption from the cap -----------------------------------------

test('set: global admin seats any party size for a capped account (exempt)', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedJoiner(h, ev.id, { guestAllowance: 1 });

    // Admin acts on behalf of the capped account, over its cap — no 422.
    const r = await h.actions['reservations.set'].handler(
            { eventId: ev.id, accountId, response: 'going',
              guests: ['A', 'B', 'C'] }, await h.adminCtx());
    assert.equal(r.accountId, accountId);
    assert.deepEqual(r.guests, ['A', 'B', 'C']);
});

test('set: event admin seats any party size for a capped account (exempt)', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedJoiner(h, ev.id, { guestAllowance: 1 });

    // A per-event admin account (not global) is likewise exempt.
    const { accountId: adminAcct } = await seedAccount(h, { grants: [] });
    await grantTo(h, adminAcct, `/events/${ev.id}/admin`);

    const r = await h.actions['reservations.set'].handler(
            { eventId: ev.id, accountId, response: 'maybe',
              guests: ['A', 'B', 'C', 'D'] }, await h.accountCtx(adminAcct));
    assert.equal(r.accountId, accountId);
    assert.deepEqual(r.guests, ['A', 'B', 'C', 'D']);
});

// ---- acting on someone else's reservation ---------------------------------

test('set/get/delete: plain join-holder touching another account → 403', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId: alice } = await seedJoiner(h, ev.id);
    const { accountId: bob } = await seedJoiner(h, ev.id);

    // Alice (a plain /join holder) may not act on Bob's reservation.
    for (const [name, input] of [
        ['reservations.set', { eventId: ev.id, accountId: bob, response: 'going' }],
        ['reservations.get', { eventId: ev.id, accountId: bob }],
        ['reservations.delete', { eventId: ev.id, accountId: bob }]
    ]) {
        await assert.rejects(
                async () => h.actions[name].handler(input, await h.accountCtx(alice)),
                (e) => e.statusCode === 403, `${name} should 403`);
    }
});

test('get: event admin (and global admin) may read anyone\'s reservation', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId: alice } = await seedJoiner(h, ev.id);
    await h.actions['reservations.set'].handler(
            { eventId: ev.id, response: 'going', guests: ['G'] },
            await h.accountCtx(alice));

    // Global admin reads Alice's.
    const asAdmin = await h.actions['reservations.get'].handler(
            { eventId: ev.id, accountId: alice }, await h.adminCtx());
    assert.deepEqual(asAdmin.guests, ['G']);

    // Per-event admin reads Alice's too.
    const { accountId: adminAcct } = await seedAccount(h, { grants: [] });
    await grantTo(h, adminAcct, `/events/${ev.id}/admin`);
    const asEventAdmin = await h.actions['reservations.get'].handler(
            { eventId: ev.id, accountId: alice }, await h.accountCtx(adminAcct));
    assert.equal(asEventAdmin.response, 'going');
});

test('target: admin caller with no sub and no accountId → 400', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    // '**' grants (admin) but no subject → reservationTarget can't resolve an
    // account and there's no accountId to fall back on → the 400 branch.
    const ctx = await h.logic.makeContext({ roles: ['admin'], sub: undefined });
    await assert.rejects(
            async () => h.actions['reservations.get'].handler(
                    { eventId: ev.id }, ctx),
            (e) => e.statusCode === 400);
});

// ---- delete ---------------------------------------------------------------

test('delete: join-holder removes own reservation; get afterward → null', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedJoiner(h, ev.id);
    await h.actions['reservations.set'].handler(
            { eventId: ev.id, response: 'going', guests: ['X'] },
            await h.accountCtx(accountId));

    const deleted = await h.actions['reservations.delete'].handler(
            { eventId: ev.id }, await h.accountCtx(accountId));
    assert.equal(deleted.accountId, accountId);   // returns the removed doc
    assert.deepEqual(deleted.guests, ['X']);

    const after = await h.actions['reservations.get'].handler(
            { eventId: ev.id }, await h.accountCtx(accountId));
    assert.equal(after, null);
});

test('delete: no existing reservation → null (nothing removed)', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedJoiner(h, ev.id);
    assert.equal(await h.actions['reservations.delete'].handler(
            { eventId: ev.id }, await h.accountCtx(accountId)), null);
});

// ---- server seam (HTTP wiring) --------------------------------------------

test('server: account cookie with a join grant can PUT then GET its reservation', async (t) => {
    const s = await makeServer(t);
    const admin = await s.logic.makeContext({ roles: ['admin'], sub: 'bootstrap-admin' });

    // Create an event, then mint+redeem an invite conferring /join so a real
    // account (with stored grants) exists; forge a cookie for that account id.
    const ev = await s.logic.actions['events.create'].handler({ config: {} }, admin);
    const invite = await s.logic.actions['invites.create'].handler(
            { grants: [`/events/${ev.id}/join`] }, admin);
    const { accountId } = await s.logic.redeemInvite(invite.token);

    const put = await s.as(accountId, []).put(`/events/${ev.id}/reservation`,
            { response: 'going', guests: ['Pat'] });
    assert.equal(put.statusCode, 200);
    assert.equal(body(put).response, 'going');
    assert.deepEqual(body(put).guests, ['Pat']);

    const get = await s.as(accountId, []).get(`/events/${ev.id}/reservation`);
    assert.equal(get.statusCode, 200);
    assert.equal(body(get).accountId, accountId);
    assert.deepEqual(body(get).guests, ['Pat']);
});

test('server: a join-holder cannot RSVP for another account → 403', async (t) => {
    const s = await makeServer(t);
    const admin = await s.logic.makeContext({ roles: ['admin'], sub: 'bootstrap-admin' });
    const ev = await s.logic.actions['events.create'].handler({ config: {} }, admin);
    const invite = await s.logic.actions['invites.create'].handler(
            { grants: [`/events/${ev.id}/join`] }, admin);
    const { accountId } = await s.logic.redeemInvite(invite.token);

    const res = await s.as(accountId, []).put(`/events/${ev.id}/reservation`,
            { accountId: 'acct_someone_else', response: 'going' });
    assert.equal(res.statusCode, 403);
});
