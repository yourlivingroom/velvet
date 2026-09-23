import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    makeLiveLogic, seedEvent, seedAccount, grantTo
} from './helpers.mjs';

// ---------------------------------------------------------------------------
// Eventual consistency. The rest of the suite runs inline (strongly
// consistent), so it can't tell whether a handler correctly opts into
// `awaitIndex` — under inline that's a no-op. Here every collection is a real,
// watcher-less (watch:false) LevelDB index whose freshness the harness controls:
// a write WITHOUT awaitIndex stays invisible to index queries until
// flushWrites(); a write WITH awaitIndex is visible at once. So these tests fail
// if an `awaitIndex` guard regresses, and they exercise real stale-on-delete —
// neither of which inline can show. velvet has exactly two index reads
// (invites.byToken in redeemInvite, events.byUser in "my events"); both are
// covered below.
// ---------------------------------------------------------------------------

// ---- the harness itself: prove it really lags (and that flush/awaitIndex work)

test('harness: a plain write is invisible to the index until flushWrites()', async (t) => {
    const h = makeLiveLogic(t);
    // Straight to the invites store, no awaitIndex.
    await h.stores.invites.edit('nvt_probe.json',
            () => ({ id: 'nvt_probe', token: 'PROBE' }));
    assert.equal(await h.stores.invites.indexes.byToken.get('PROBE'), null,
            'lagged: not yet indexed');
    await h.flushWrites();
    assert.equal(
            (await h.stores.invites.indexes.byToken.get('PROBE')).path,
            'nvt_probe.json', 'visible after flush');
});

test('harness: an awaitIndex write is visible immediately, no flush', async (t) => {
    const h = makeLiveLogic(t);
    await h.stores.invites.edit('nvt_p2.json',
            () => ({ id: 'nvt_p2', token: 'P2' }), { awaitIndex: true });
    assert.equal(
            (await h.stores.invites.indexes.byToken.get('P2')).path,
            'nvt_p2.json');
});

// ---- the guards that inline masks -----------------------------------------

test('invites.create is awaitIndex: a fresh invite redeems immediately under lag', async (t) => {
    const h = makeLiveLogic(t);
    const admin = await h.adminCtx();

    const invite = await h.actions['invites.create'].handler(
            { grants: ['/events/evt_x/view'], name: 'Ada' }, admin);

    // No flush. Because invites.create uses awaitIndex, byToken already sees it…
    assert.ok(await h.stores.invites.indexes.byToken.get(invite.token),
            'indexed before any flush');
    // …so redemption (which looks up byToken) succeeds — no create/redeem race.
    const { accountId } = await h.redeemInvite(invite.token);
    assert.match(accountId, /^acct_/);
});

test('accounts.reconnect is awaitIndex: the reconnect link redeems immediately', async (t) => {
    const h = makeLiveLogic(t);
    const admin = await h.adminCtx();

    // An existing account (seedAccount redeems an awaitIndex invite).
    const { accountId } = await seedAccount(h, { name: 'Bo' });

    // Mint a pre-bound reconnect link and redeem it at once — no flush.
    const link = await h.actions['accounts.reconnect'].handler({ accountId }, admin);
    const again = await h.redeemInvite(link.token);
    assert.equal(again.accountId, accountId, 'same account, created none');
});

test('granting event access drives byUser (awaitIndex): it lists immediately', async (t) => {
    const h = makeLiveLogic(t);
    const ev = await seedEvent(h);
    const { accountId } = await seedAccount(h, { grants: [] });

    // grant → addEventMember(awaitIndex) updates the event's members → byUser.
    await grantTo(h, accountId, `/events/${ev.id}/view`);

    // No flush: the account's "my events" already includes it.
    const mine = await h.actions['events.list'].handler(
            { when: 'all' }, await h.accountCtx(accountId));
    assert.deepEqual(mine.map((e) => e.id), [ev.id]);
});

// ---- real stale-on-delete (only a real materialized index can show this) ---

test('revokeInvite leaves byToken stale until flush; redeem stays safe via re-read', async (t) => {
    const h = makeLiveLogic(t);
    const admin = await h.adminCtx();
    const ev = await seedEvent(h);

    const invite = await h.actions['invites.create'].handler(
            { grants: [`/events/${ev.id}/view`] }, admin);
    assert.ok(await h.stores.invites.indexes.byToken.get(invite.token));

    // Revoke deletes the doc without awaitIndex — the file is gone, but the
    // byToken entry lingers (this is genuine index staleness, not a fake).
    await h.actions['events.revokeInvite'].handler(
            { eventId: ev.id, inviteId: invite.id }, admin);
    assert.ok(await h.stores.invites.indexes.byToken.get(invite.token),
            'index is genuinely stale (still points at the deleted invite)');

    // Despite the stale hit, redemption is safe: redeemInvite re-reads the
    // (now-missing) doc inside edit() and returns null rather than binding.
    assert.equal(await h.redeemInvite(invite.token), null);

    // Flushing reconciles the stale entry away.
    await h.flushWrites();
    assert.equal(await h.stores.invites.indexes.byToken.get(invite.token), null);
});
