import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeLogic, makeServer, seedEvent, seedAccount, grantTo, body
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// invites — handler seam (create shape + in-handler authz, get/list token
// omission, redeem binding) and server seam (the `requires:/server/admin`
// route gate on get/list, enforced at the REST layer). Plus the event-scoped
// invite management trio (events.invites / revokeInvite / updateInvite),
// event-admin gated in-handler.
// ---------------------------------------------------------------------------

// ---- invites.create -------------------------------------------------------

test('create: admin mints a doc with a secret token, nvt_ id, and grants', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const inv = await h.actions['invites.create'].handler(
            { grants: ['/events/evt_1/view'] }, admin);

    assert.match(inv.id, /^nvt_/);
    assert.equal(typeof inv.token, 'string');
    assert.ok(inv.token.length > 0);            // the secret bearer credential
    assert.deepEqual(inv.grants, ['/events/evt_1/view']);
});

test('create: optional fields round-trip', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const inv = await h.actions['invites.create'].handler({
        grants: [],
        name: 'Ada',
        entrypoint: '/events/evt_1',
        guestAllowance: 2,
        email: 'a@b.com',
        note: 'a plus one'
    }, admin);

    assert.equal(inv.name, 'Ada');
    assert.equal(inv.entrypoint, '/events/evt_1');
    assert.equal(inv.guestAllowance, 2);
    assert.equal(inv.email, 'a@b.com');
    assert.equal(inv.note, 'a plus one');
});

// ---- invites.create: non-admin authz (fully in-handler, no `requires`) ----

test('create: an event admin may mint invites scoped to their event', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedAccount(h, { grants: [] });
    await grantTo(h, accountId, `/events/${ev.id}/admin`);
    const eventAdmin = await h.accountCtx(accountId);

    // Every grant falls under an event they administer → allowed.
    const inv = await h.actions['invites.create'].handler(
            { grants: [`/events/${ev.id}/view`] }, eventAdmin);
    assert.match(inv.id, /^nvt_/);
    assert.deepEqual(inv.grants, [`/events/${ev.id}/view`]);
});

test('create: non-admin authz — empty / foreign / global grants all 403', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedAccount(h, { grants: [] });
    await grantTo(h, accountId, `/events/${ev.id}/admin`);
    const eventAdmin = await h.accountCtx(accountId);

    // (b) no grants — a non-admin can't mint a bare invite.
    await assert.rejects(
            async () => h.actions['invites.create'].handler({ grants: [] }, eventAdmin),
            (e) => e.statusCode === 403);

    // (c) a grant outside any event they administer.
    await assert.rejects(
            async () => h.actions['invites.create'].handler(
                    { grants: ['/events/evt_other/view'] }, eventAdmin),
            (e) => e.statusCode === 403);

    // (d) a global / bare grant — no escalation.
    await assert.rejects(
            async () => h.actions['invites.create'].handler(
                    { grants: ['**'] }, eventAdmin),
            (e) => e.statusCode === 403);
});

// ---- invites.get / invites.list: token omission + read shape --------------

test('get/list: the secret token is omitted; list returns all, get one, missing→null', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const a = await h.actions['invites.create'].handler({ grants: [] }, admin);
    const b = await h.actions['invites.create'].handler({ grants: [] }, admin);

    const one = await h.actions['invites.get'].handler({ id: a.id }, admin);
    assert.equal(one.id, a.id);
    assert.ok(!('token' in one), 'invites.get must not leak the token');

    const missing = await h.actions['invites.get'].handler(
            { id: 'nvt_missing' }, admin);
    assert.equal(missing, null);

    const all = await h.actions['invites.list'].handler({}, admin);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((i) => i.id).sort(), [a.id, b.id].sort());
    for (const i of all) assert.ok(!('token' in i), 'invites.list must not leak tokens');
});

// ---- invites.get / invites.list: server-seam route gate -------------------

test('server: GET /invites requires admin (401 anon, 403 account, 200 admin)', async (t) => {
    const s = await makeServer(t);

    const anon = await s.anon().get('/invites');
    assert.equal(anon.statusCode, 401);

    const account = await s.as('acct_x', []).get('/invites');
    assert.equal(account.statusCode, 403);

    const admin = await s.asAdmin().get('/invites');
    assert.equal(admin.statusCode, 200);
    assert.ok(Array.isArray(body(admin)));
});

test('server: GET /invites/:id requires admin (401 anon, 403 account)', async (t) => {
    const s = await makeServer(t);

    const anon = await s.anon().get('/invites/nvt_whatever');
    assert.equal(anon.statusCode, 401);

    const account = await s.as('acct_x', []).get('/invites/nvt_whatever');
    assert.equal(account.statusCode, 403);
});

// ---- redeemInvite ---------------------------------------------------------

test('redeem: mints a bound account carrying the invite name + allowance', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const inv = await h.actions['invites.create'].handler({
        grants: [], name: 'Grace', guestAllowance: 3, entrypoint: '/events/evt_1'
    }, admin);

    const { accountId, entrypoint } = await h.redeemInvite(inv.token);
    assert.match(accountId, /^acct_/);
    assert.equal(entrypoint, '/events/evt_1');

    // The new account carries the invite's seeded name + guest allowance.
    const acct = await h.actions['accounts.get'].handler({ accountId }, admin);
    assert.equal(acct.name, 'Grace');
    assert.equal(acct.guestAllowance, 3);
});

test('redeem: the same token twice binds the same account (no new account)', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const inv = await h.actions['invites.create'].handler({ grants: [] }, admin);

    const first = await h.redeemInvite(inv.token);
    const second = await h.redeemInvite(inv.token);
    assert.equal(first.accountId, second.accountId);
});

test('redeem: an invalid / unknown token → null', async (t) => {
    const h = makeLogic(t);
    assert.equal(await h.redeemInvite('not-a-real-token'), null);
    assert.equal(await h.redeemInvite(''), null);
    assert.equal(await h.redeemInvite(undefined), null);
});

// ---- events.invites (open invites for an event, admin-gated) --------------

test('events.invites: lists only unredeemed invites for this event, token omitted', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const ev = await seedEvent(h);

    // One open (unredeemed) invite conferring access to this event.
    const open = await h.actions['invites.create'].handler(
            { grants: [`/events/${ev.id}/view`] }, admin);
    // One redeemed invite for the same event (should be excluded).
    const redeemed = await h.actions['invites.create'].handler(
            { grants: [`/events/${ev.id}/view`] }, admin);
    await h.redeemInvite(redeemed.token);
    // One open invite for an UNRELATED event (should be excluded).
    await h.actions['invites.create'].handler(
            { grants: ['/events/evt_other/view'] }, admin);

    const list = await h.actions['events.invites'].handler(
            { eventId: ev.id }, admin);
    assert.deepEqual(list.map((i) => i.id), [open.id]);
    assert.ok(!('token' in list[0]), 'events.invites must not leak the token');
});

test('events.invites: non-admin caller → 403', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedAccount(h, { grants: [] });
    await grantTo(h, accountId, `/events/${ev.id}/view`);   // participant, not admin
    const participant = await h.accountCtx(accountId);

    await assert.rejects(
            async () => h.actions['events.invites'].handler({ eventId: ev.id }, participant),
            (e) => e.statusCode === 403);
});

// ---- events.revokeInvite (delete an open invite, admin-gated) -------------

test('events.revokeInvite: deletes the invite so its link goes dead', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const ev = await seedEvent(h);
    const inv = await h.actions['invites.create'].handler(
            { grants: [`/events/${ev.id}/view`] }, admin);

    const deleted = await h.actions['events.revokeInvite'].handler(
            { eventId: ev.id, inviteId: inv.id }, admin);
    assert.equal(deleted.id, inv.id);
    assert.ok(!('token' in deleted));

    // Its token no longer redeems.
    assert.equal(await h.redeemInvite(inv.token), null);
    // And it's gone from the open-invites list.
    const list = await h.actions['events.invites'].handler({ eventId: ev.id }, admin);
    assert.equal(list.length, 0);
});

test('events.revokeInvite: an invite unrelated to this event → null (hidden)', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const ev = await seedEvent(h);
    // Invite confers access to a DIFFERENT event.
    const inv = await h.actions['invites.create'].handler(
            { grants: ['/events/evt_other/view'] }, admin);

    const res = await h.actions['events.revokeInvite'].handler(
            { eventId: ev.id, inviteId: inv.id }, admin);
    assert.equal(res, null);
    // The invite still redeems — it wasn't deleted.
    assert.ok((await h.redeemInvite(inv.token)).accountId);
});

test('events.revokeInvite: non-admin caller → 403', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const ev = await seedEvent(h);
    const inv = await h.actions['invites.create'].handler(
            { grants: [`/events/${ev.id}/view`] }, admin);
    const { accountId } = await seedAccount(h, { grants: [] });
    await grantTo(h, accountId, `/events/${ev.id}/view`);
    const participant = await h.accountCtx(accountId);

    await assert.rejects(
            async () => h.actions['events.revokeInvite'].handler(
                    { eventId: ev.id, inviteId: inv.id }, participant),
            (e) => e.statusCode === 403);
});

// ---- events.updateInvite (edit name / allowance, admin-gated) -------------

test('events.updateInvite: edits name and guestAllowance on an open invite', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const ev = await seedEvent(h);
    const inv = await h.actions['invites.create'].handler(
            { grants: [`/events/${ev.id}/view`], name: 'Old', guestAllowance: 1 }, admin);

    const updated = await h.actions['events.updateInvite'].handler(
            { eventId: ev.id, inviteId: inv.id, name: 'New', guestAllowance: 5 }, admin);
    assert.equal(updated.name, 'New');
    assert.equal(updated.guestAllowance, 5);
    assert.ok(!('token' in updated));

    // guestAllowance: null clears it (unlimited).
    const cleared = await h.actions['events.updateInvite'].handler(
            { eventId: ev.id, inviteId: inv.id, guestAllowance: null }, admin);
    assert.equal(cleared.name, 'New');                      // unchanged (omitted)
    assert.ok(!('guestAllowance' in cleared), 'null clears the allowance');
});

test('events.updateInvite: an invite unrelated to this event → null (hidden)', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const ev = await seedEvent(h);
    const inv = await h.actions['invites.create'].handler(
            { grants: ['/events/evt_other/view'], name: 'Old' }, admin);

    const res = await h.actions['events.updateInvite'].handler(
            { eventId: ev.id, inviteId: inv.id, name: 'New' }, admin);
    assert.equal(res, null);
});

test('events.updateInvite: non-admin caller → 403', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const ev = await seedEvent(h);
    const inv = await h.actions['invites.create'].handler(
            { grants: [`/events/${ev.id}/view`] }, admin);
    const { accountId } = await seedAccount(h, { grants: [] });
    await grantTo(h, accountId, `/events/${ev.id}/view`);
    const participant = await h.accountCtx(accountId);

    await assert.rejects(
            async () => h.actions['events.updateInvite'].handler(
                    { eventId: ev.id, inviteId: inv.id, name: 'X' }, participant),
            (e) => e.statusCode === 403);
});
