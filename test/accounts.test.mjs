import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeLogic, makeServer, seedEvent, seedAccount, grantTo, body
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// accounts — handler seam (grading, owner-or-admin edits, avatar ref
// validation, confer-only-what-you-hold grant/revoke, reconnect behavior) and
// server seam (the `requires:/server/admin` route gates on reconnect + list).
// events.removeMember lives here too (full account teardown from an event).
// ---------------------------------------------------------------------------

// ---- accounts.get: graded read --------------------------------------------

test('get: graded — owner full doc, peer public view, anon → null', async (t) => {
    const h = makeLogic(t);
    const { accountId } = await seedAccount(h,
            { name: 'Ada', grants: ['/events/evt_1/view'] });

    // Owner gets the full stored doc, grants included.
    const mine = await h.actions['accounts.get'].handler(
            { accountId }, await h.accountCtx(accountId));
    assert.equal(mine.id, accountId);
    assert.equal(mine.name, 'Ada');
    assert.deepEqual(mine.grants, ['/events/evt_1/view']);

    // A different signed-in account gets only { id, name, avatar } — no leak.
    const { accountId: other } = await seedAccount(h, { grants: [] });
    const pub = await h.actions['accounts.get'].handler(
            { accountId }, await h.accountCtx(other));
    assert.equal(pub.id, accountId);
    assert.equal(pub.name, 'Ada');
    assert.equal(pub.grants, undefined);
    assert.equal(pub.invite, undefined);

    // Admin also gets the full doc.
    const asAdmin = await h.actions['accounts.get'].handler(
            { accountId }, await h.adminCtx());
    assert.deepEqual(asAdmin.grants, ['/events/evt_1/view']);

    // Anonymous → null (404).
    assert.equal(await h.actions['accounts.get'].handler(
            { accountId }, await h.anonCtx()), null);

    // Unknown id → null even for admin.
    assert.equal(await h.actions['accounts.get'].handler(
            { accountId: 'acct_missing' }, await h.adminCtx()), null);
});

// ---- accounts.update: owner-or-admin, name/avatar only ---------------------

test('update: owner edits own name; admin edits anyone; peer hidden (null)', async (t) => {
    const h = makeLogic(t);
    const { accountId } = await seedAccount(h, { name: 'Ada', grants: [] });

    // Owner updates their own name.
    const updated = await h.actions['accounts.update'].handler(
            { accountId, name: 'Ada L.' }, await h.accountCtx(accountId));
    assert.equal(updated.name, 'Ada L.');

    // A different non-admin account editing someone else is hidden → null
    // (the handler grades by returning null, it does not throw).
    const { accountId: other } = await seedAccount(h, { grants: [] });
    assert.equal(await h.actions['accounts.update'].handler(
            { accountId, name: 'Hacked' }, await h.accountCtx(other)), null);

    // Admin may edit anyone.
    const byAdmin = await h.actions['accounts.update'].handler(
            { accountId, name: 'Ada (admin set)' }, await h.adminCtx());
    assert.equal(byAdmin.name, 'Ada (admin set)');
});

test('update: grants are never settable (no self-escalation)', async (t) => {
    const h = makeLogic(t);
    const { accountId } = await seedAccount(h,
            { grants: ['/events/evt_1/view'] });

    // Pass a bogus `grants` alongside name — the handler ignores it entirely.
    await h.actions['accounts.update'].handler(
            { accountId, name: 'X', grants: ['**'] }, await h.adminCtx());

    const doc = await h.actions['accounts.get'].handler(
            { accountId }, await h.adminCtx());
    assert.deepEqual(doc.grants, ['/events/evt_1/view']);   // unchanged
    assert.equal(doc.name, 'X');
});

test('update: avatar must ref own bucket; other bucket → 422; null clears', async (t) => {
    const h = makeLogic(t);
    const { accountId } = await seedAccount(h, { grants: [] });

    // A ref into the account's OWN bucket succeeds, stored as a { $blob } ref.
    const ref = `accounts/${accountId}/blb_abcdef01`;
    const set = await h.actions['accounts.update'].handler(
            { accountId, avatar: ref }, await h.accountCtx(accountId));
    assert.deepEqual(set.avatar, { $blob: ref });

    // A ref into a DIFFERENT account bucket → 422.
    await assert.rejects(
            async () => h.actions['accounts.update'].handler(
                    { accountId, avatar: 'accounts/acct_other/blb_abcdef01' },
                    await h.accountCtx(accountId)),
            (e) => e.statusCode === 422);

    // A ref into an event bucket → 422.
    await assert.rejects(
            async () => h.actions['accounts.update'].handler(
                    { accountId, avatar: 'events/evt_1/blb_abcdef01' },
                    await h.accountCtx(accountId)),
            (e) => e.statusCode === 422);

    // The stored avatar is untouched by the rejected attempts.
    const still = await h.actions['accounts.get'].handler(
            { accountId }, await h.accountCtx(accountId));
    assert.deepEqual(still.avatar, { $blob: ref });

    // null clears it.
    const cleared = await h.actions['accounts.update'].handler(
            { accountId, avatar: null }, await h.accountCtx(accountId));
    assert.equal(cleared.avatar, undefined);
});

// ---- accounts.grant / accounts.revoke -------------------------------------

test('grant/revoke: admin confers a real, effective permission then removes it', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedAccount(h, { grants: [] });

    // Before granting, the account can't touch the event (in-handler 403).
    await assert.rejects(
            async () => h.actions['events.patch'].handler(
                    { eventId: ev.id, patch: [] }, await h.accountCtx(accountId)),
            (e) => e.statusCode === 403);

    // Admin grants event-admin; it shows up on the stored doc...
    const granted = await h.actions['accounts.grant'].handler(
            { accountId, grant: `/events/${ev.id}/admin` }, await h.adminCtx());
    assert.ok(granted.grants.includes(`/events/${ev.id}/admin`));

    // ...and is effective on the account's NEXT request (grants resolve fresh).
    const patched = await h.actions['events.patch'].handler(
            { eventId: ev.id, patch: [{ op: 'add', path: '/v', value: 1 }] },
            await h.accountCtx(accountId));
    assert.equal(patched.config.v, 1);

    // Revoke removes it; the account is forbidden again.
    const revoked = await h.actions['accounts.revoke'].handler(
            { accountId, grant: `/events/${ev.id}/admin` }, await h.adminCtx());
    assert.ok(!revoked.grants.includes(`/events/${ev.id}/admin`));
    await assert.rejects(
            async () => h.actions['events.patch'].handler(
                    { eventId: ev.id, patch: [] }, await h.accountCtx(accountId)),
            (e) => e.statusCode === 403);
});

test('grant: idempotent — granting twice stores one copy', async (t) => {
    const h = makeLogic(t);
    const { accountId } = await seedAccount(h, { grants: [] });
    await grantTo(h, accountId, '/events/evt_1/view');
    const twice = await h.actions['accounts.grant'].handler(
            { accountId, grant: '/events/evt_1/view' }, await h.adminCtx());
    assert.deepEqual(
            twice.grants.filter((g) => g === '/events/evt_1/view'),
            ['/events/evt_1/view']);
});

test('grant: confer-only-what-you-hold — event admin can delegate their event, not escalate', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const other = await seedEvent(h);

    // An account that administers `ev`.
    const { accountId: admin } = await seedAccount(h, { grants: [] });
    await grantTo(h, admin, `/events/${ev.id}/admin`);

    const { accountId: target } = await seedAccount(h, { grants: [] });

    // It MAY grant that same event's admin to someone else.
    const ok = await h.actions['accounts.grant'].handler(
            { accountId: target, grant: `/events/${ev.id}/admin` },
            await h.accountCtx(admin));
    // Returned as the public shape (caller isn't owner/admin of target).
    assert.equal(ok.id, target);

    // It may NOT confer a global grant...
    await assert.rejects(
            async () => h.actions['accounts.grant'].handler(
                    { accountId: target, grant: '**' }, await h.accountCtx(admin)),
            (e) => e.statusCode === 403);

    // ...nor another event's admin.
    await assert.rejects(
            async () => h.actions['accounts.grant'].handler(
                    { accountId: target, grant: `/events/${other.id}/admin` },
                    await h.accountCtx(admin)),
            (e) => e.statusCode === 403);
});

test('grant/revoke: a bare account may confer nothing → 403', async (t) => {
    const h = makeLogic(t);
    const { accountId: bare } = await seedAccount(h, { grants: [] });
    const { accountId: target } = await seedAccount(h, { grants: [] });

    await assert.rejects(
            async () => h.actions['accounts.grant'].handler(
                    { accountId: target, grant: '/events/evt_1/view' },
                    await h.accountCtx(bare)),
            (e) => e.statusCode === 403);
    await assert.rejects(
            async () => h.actions['accounts.revoke'].handler(
                    { accountId: target, grant: '/events/evt_1/view' },
                    await h.accountCtx(bare)),
            (e) => e.statusCode === 403);
});

// ---- accounts.reconnect ----------------------------------------------------

test('reconnect: server gate — 401 anon, 403 account', async (t) => {
    const s = await makeServer(t);

    const anon = await s.anon().post('/accounts/acct_x/reconnect', {});
    assert.equal(anon.statusCode, 401);

    const account = await s.as('acct_x', []).post('/accounts/acct_x/reconnect', {});
    assert.equal(account.statusCode, 403);
});

test('reconnect: mints an invite pre-bound to the account (redeem reuses it, no new account)', async (t) => {
    const h = makeLogic(t);
    const { accountId } = await seedAccount(h, { name: 'Ada', grants: [] });

    const before = await h.actions['accounts.list'].handler({}, await h.adminCtx());

    // Admin mints a reconnect link — the token is shown once, here.
    const invite = await h.actions['accounts.reconnect'].handler(
            { accountId }, await h.adminCtx());
    assert.ok(invite.token);
    assert.equal(invite.accountId, accountId);   // pre-bound

    // Redeeming it returns the SAME account and creates none.
    const redeemed = await h.redeemInvite(invite.token);
    assert.equal(redeemed.accountId, accountId);

    const after = await h.actions['accounts.list'].handler({}, await h.adminCtx());
    assert.equal(after.length, before.length);   // no new account
});

// ---- accounts.list ---------------------------------------------------------

test('list: server gate — 401 anon, 403 account, admin → array', async (t) => {
    const s = await makeServer(t);

    assert.equal((await s.anon().get('/accounts')).statusCode, 401);
    assert.equal((await s.as('acct_x', []).get('/accounts')).statusCode, 403);

    const admin = await s.asAdmin().get('/accounts');
    assert.equal(admin.statusCode, 200);
    assert.ok(Array.isArray(body(admin)));
});

// ---- events.removeMember (full teardown, event-admin gated) ---------------

test('removeMember: strips grants, drops from roster, deletes reservation', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedAccount(h, { name: 'Ada', grants: [] });
    await grantTo(h, accountId, `/events/${ev.id}/join`);

    // Give the account a reservation.
    await h.actions['reservations.set'].handler(
            { eventId: ev.id, response: 'going' }, await h.accountCtx(accountId));

    // It's on the roster and can see the event.
    let roster = await h.actions['events.members'].handler(
            { eventId: ev.id }, await h.adminCtx());
    assert.ok(roster.some((r) => r.id === accountId));
    assert.ok(await h.actions['events.get'].handler(
            { eventId: ev.id }, await h.accountCtx(accountId)));

    // Admin removes it.
    const res = await h.actions['events.removeMember'].handler(
            { eventId: ev.id, accountId }, await h.adminCtx());
    assert.deepEqual(res, { id: accountId, removed: true });

    // Gone from the roster, can no longer see the event, reservation deleted.
    roster = await h.actions['events.members'].handler(
            { eventId: ev.id }, await h.adminCtx());
    assert.ok(!roster.some((r) => r.id === accountId));
    assert.equal(await h.actions['events.get'].handler(
            { eventId: ev.id }, await h.accountCtx(accountId)), null);
    assert.equal(await h.actions['reservations.get'].handler(
            { eventId: ev.id, accountId }, await h.adminCtx()), null);
});

test('removeMember: cannot remove yourself → 400', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedAccount(h, { grants: [] });
    await grantTo(h, accountId, `/events/${ev.id}/admin`);

    await assert.rejects(
            async () => h.actions['events.removeMember'].handler(
                    { eventId: ev.id, accountId }, await h.accountCtx(accountId)),
            (e) => e.statusCode === 400);
});

test('removeMember: non-admin caller → 403', async (t) => {
    const h = makeLogic(t);
    const ev = await seedEvent(h);
    const { accountId: bystander } = await seedAccount(h, { grants: [] });
    const { accountId: victim } = await seedAccount(h, { grants: [] });
    await grantTo(h, victim, `/events/${ev.id}/join`);

    await assert.rejects(
            async () => h.actions['events.removeMember'].handler(
                    { eventId: ev.id, accountId: victim },
                    await h.accountCtx(bystander)),
            (e) => e.statusCode === 403);
});
