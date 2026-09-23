import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, forgeAccess, body } from './helpers.mjs';

// ---------------------------------------------------------------------------
// MCP-to-logic seam. registerMcp mounts a single JSON-RPC POST route at /mcp,
// so it's driven exactly like REST — inject() a JSON-RPC envelope. /mcp is
// Bearer-only (a cookie there would be a CSRF vector), so callers authenticate
// with a forged access JWT. This layer has behavior the REST tests don't cover:
// the JSON-RPC envelope, tools/list permission FILTERING, the in-band isError
// convention, and the Forbidden / unknown-tool / method-not-found error codes.
// ---------------------------------------------------------------------------

const adminToken = () => forgeAccess('bootstrap-admin', ['admin']);
const acctToken = (sub = 'acct_x') => forgeAccess(sub, []);

test('requires a Bearer token (401 unauthenticated)', async (t) => {
    const s = await makeServer(t);
    const { status } = await s.mcp(null,
            { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(status, 401);
});

test('initialize returns protocol + serverInfo', async (t) => {
    const s = await makeServer(t);
    const { json } = await s.mcp(await adminToken(),
            { jsonrpc: '2.0', id: 1, method: 'initialize',
              params: { protocolVersion: '2025-06-18' } });
    assert.equal(json.result.protocolVersion, '2025-06-18');
    assert.equal(json.result.serverInfo.name, 'velvet');
    assert.ok(json.result.capabilities.tools);
});

test('tools/list is the registry; hides requires-gated tools from a non-admin', async (t) => {
    const s = await makeServer(t);

    const asAdmin = await s.mcp(await adminToken(),
            { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const adminNames = asAdmin.json.result.tools.map((tl) => tl.name);
    assert.ok(adminNames.includes('events.create'));      // /server/admin tool
    // Each tool's inputSchema IS the action's input schema.
    const create = asAdmin.json.result.tools.find((tl) => tl.name === 'events.create');
    assert.equal(create.inputSchema.type, 'object');

    const asAcct = await s.mcp(await acctToken(),
            { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const acctNames = asAcct.json.result.tools.map((tl) => tl.name);
    assert.ok(!acctNames.includes('events.create'),
            'a /server/admin tool must be hidden from a non-admin');
    // But an ungated tool is still visible.
    assert.ok(acctNames.includes('events.get'));
});

test('tools/call dispatches to the handler and returns text content', async (t) => {
    const s = await makeServer(t);
    const { json } = await s.mcp(await adminToken(), {
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'events.create', arguments: { config: { title: 'P' } } }
    });
    assert.equal(json.result.isError, undefined);
    const doc = JSON.parse(json.result.content[0].text);
    assert.match(doc.id, /^evt_/);
    assert.equal(doc.config.title, 'P');
});

test('tools/call on a requires-gated tool without permission → Forbidden (-32002)', async (t) => {
    const s = await makeServer(t);
    const { json } = await s.mcp(await acctToken(), {
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { name: 'events.create', arguments: { config: {} } }
    });
    assert.equal(json.error.code, -32002);
    assert.match(json.error.message, /Forbidden/);
});

test('tools/call handler error is reported in-band as isError, not a JSON-RPC error', async (t) => {
    const s = await makeServer(t);
    // events.update on a missing event → handler returns null (not found); but a
    // ClientError path: patch with an invalid op throws ClientError → isError.
    const ev = JSON.parse((await s.mcp(await adminToken(), {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'events.create', arguments: { config: {} } }
    })).json.result.content[0].text);

    const { json } = await s.mcp(await adminToken(), {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'events.update',
                  arguments: { eventId: ev.id, startsAt: 'not-a-date' } }
    });
    assert.equal(json.error, undefined);          // NOT a protocol error
    assert.equal(json.result.isError, true);      // reported in-band
    assert.match(json.result.content[0].text, /Invalid startsAt/);
});

test('tools/call unknown tool → -32602', async (t) => {
    const s = await makeServer(t);
    const { json } = await s.mcp(await adminToken(), {
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'nope.nope', arguments: {} }
    });
    assert.equal(json.error.code, -32602);
});

test('unknown method → -32601', async (t) => {
    const s = await makeServer(t);
    const { json } = await s.mcp(await adminToken(),
            { jsonrpc: '2.0', id: 8, method: 'frobnicate' });
    assert.equal(json.error.code, -32601);
});

test('ping → empty result', async (t) => {
    const s = await makeServer(t);
    const { json } = await s.mcp(await adminToken(),
            { jsonrpc: '2.0', id: 9, method: 'ping' });
    assert.deepEqual(json.result, {});
});

test('a lone notification (no id) → 202 with no body', async (t) => {
    const s = await makeServer(t);
    const res = await s.fastify.inject({
        method: 'POST', url: '/mcp',
        headers: { authorization: `Bearer ${await adminToken()}`,
                   'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', method: 'notifications/initialized' }
    });
    assert.equal(res.statusCode, 202);
    assert.equal(res.payload, '');
});

test('a batch answers each non-notification request in order', async (t) => {
    const s = await makeServer(t);
    const { json } = await s.mcp(await adminToken(), [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },   // dropped
        { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    ]);
    assert.ok(Array.isArray(json));
    assert.equal(json.length, 2);                 // the notification is dropped
    assert.deepEqual(json.map((m) => m.id), [1, 2]);
});
