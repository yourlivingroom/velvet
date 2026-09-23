import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLogic, makeServer, body } from './helpers.mjs';

test('handler seam: admin creates event, sees it in list', async (t) => {
    const h = makeLogic(t);
    const admin = await h.adminCtx();
    const ev = await h.actions['events.create'].handler({ config: { title: 'X' } }, admin);
    assert.match(ev.id, /^evt_/);
    const list = await h.actions['events.list'].handler({}, admin);
    assert.equal(list.length, 1);
});

test('server seam: forged admin cookie can create an event over HTTP', async (t) => {
    const s = await makeServer(t);
    const admin = s.asAdmin();
    const res = await admin.post('/events', { config: { title: 'Party' } });
    assert.equal(res.statusCode, 200);
    const ev = body(res);
    assert.match(ev.id, /^evt_/);
});

test('server seam: GET /session reflects the forged cookie', async (t) => {
    const s = await makeServer(t);
    const res = await s.as('acct_123', []).get('/session');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(body(res), { accountId: 'acct_123', isAdmin: false });

    const anon = await s.anon().get('/session');
    assert.equal(anon.statusCode, 401);
});

test('server seam: cookie write without CSRF header is 403', async (t) => {
    const s = await makeServer(t);
    // csrf:false suppresses the auto-attached X-CSRF-Token → guard should reject.
    const res = await s.asAdmin().post('/events', { config: {} }, { csrf: false });
    assert.equal(res.statusCode, 403);
    assert.equal(body(res).error, 'csrf');
});

test('server seam: anon GET of an event 404s (hidden)', async (t) => {
    const s = await makeServer(t);
    const res = await s.anon().get('/events/evt_nope');
    assert.equal(res.statusCode, 404);
});
