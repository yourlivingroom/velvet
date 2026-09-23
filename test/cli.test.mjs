import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLogic, runCli } from './helpers.mjs';
import {
    pathParams, splitInput, schemaToFlags, coerceCliInput, cliSummary, toMcpTool
} from '../bind.mjs';

// ---------------------------------------------------------------------------
// CLI-to-logic seam. buildCli projects the registry onto an sbopts command tree
// (`invites.create` → `velvet invites create`); runCli drives it in-process and
// captures stdout/stderr/exitCode. This layer owns behavior the other seams
// don't: positional↔flag merging, "given twice" / missing-required / unexpected
// -arg errors, JSON-string coercion of object/array flags, the admin ctx, JSON
// stdout, and ClientError → stderr + exit 1. Plus pure unit tests of bind.mjs,
// the projection all three adapters share.
// ---------------------------------------------------------------------------

// ---- end-to-end through buildCli(...).run(argv) ----

test('run: object flag coerced from a JSON string; result printed as JSON', async (t) => {
    const h = makeLogic(t);
    const { stdout, stderr, code } = await runCli(h.logic,
            ['events', 'create', '--config', '{"title":"Party"}']);
    assert.equal(code, 0, stderr);
    const doc = JSON.parse(stdout);
    assert.match(doc.id, /^evt_/);
    assert.equal(doc.config.title, 'Party');
});

test('run: the CLI acts as admin (filesystem trust → ** grants)', async (t) => {
    const h = makeLogic(t);
    // events.create requires /server/admin; the CLI is admin, so it succeeds
    // with no credential of any kind.
    const { code } = await runCli(h.logic, ['events', 'create', '--config', '{}']);
    assert.equal(code, 0);
    // And a global-admin-only listing works too.
    const list = await runCli(h.logic, ['events', 'list']);
    assert.equal(list.code, 0);
    assert.equal(JSON.parse(list.stdout).length, 1);
});

test('run: a path param fills from the leading positional', async (t) => {
    const h = makeLogic(t);
    const created = JSON.parse(
            (await runCli(h.logic, ['events', 'create', '--config', '{}'])).stdout);

    // `events get <eventId>` — eventId is the :eventId path param as a positional.
    const got = await runCli(h.logic, ['events', 'get', created.id]);
    assert.equal(got.code, 0);
    assert.equal(JSON.parse(got.stdout).id, created.id);
});

test('run: a payload action takes its value as the trailing positional', async (t) => {
    const h = makeLogic(t);
    const ev = JSON.parse(
            (await runCli(h.logic, ['events', 'create', '--config', '{}'])).stdout);

    // events.patch: eventId is the path param (positional 1), `patch` is the
    // payload (positional 2), given as a JSON string.
    const patch = JSON.stringify([{ op: 'add', path: '/venue', value: 'Hall' }]);
    const res = await runCli(h.logic, ['events', 'patch', ev.id, patch]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).config.venue, 'Hall');
});

test('run: same slot positionally AND by flag → error, exit 1', async (t) => {
    const h = makeLogic(t);
    const ev = JSON.parse(
            (await runCli(h.logic, ['events', 'create', '--config', '{}'])).stdout);
    const res = await runCli(h.logic,
            ['events', 'get', ev.id, '--eventId', ev.id]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /given twice/i);
});

test('run: an extra positional → "Unexpected argument", exit 1', async (t) => {
    const h = makeLogic(t);
    const ev = JSON.parse(
            (await runCli(h.logic, ['events', 'create', '--config', '{}'])).stdout);
    const res = await runCli(h.logic, ['events', 'get', ev.id, 'extra-arg']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /Unexpected argument/i);
});

test('run: malformed JSON in an object flag → ClientError, exit 1', async (t) => {
    const h = makeLogic(t);
    const res = await runCli(h.logic, ['events', 'create', '--config', '{not json}']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /must be valid JSON/i);
});

test('run: a handler ClientError (invalid schedule) → stderr + exit 1', async (t) => {
    const h = makeLogic(t);
    const ev = JSON.parse(
            (await runCli(h.logic, ['events', 'create', '--config', '{}'])).stdout);
    const res = await runCli(h.logic,
            ['events', 'update', ev.id, '--startsAt', 'not-a-date']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /Invalid startsAt/);
    assert.equal(res.stdout, '');
});

// ---- pure projection helpers (bind.mjs) ----

test('bind: pathParams extracts :segments in order', () => {
    assert.deepEqual(
            pathParams('/events/:eventId/members/:accountId'),
            ['eventId', 'accountId']);
    assert.deepEqual(pathParams('/events'), []);
});

test('bind: splitInput separates path props from body/query props', () => {
    const action = {
        http: { method: 'GET', path: '/events/:eventId' },
        input: {
            type: 'object',
            required: ['eventId'],
            properties: {
                eventId: { type: 'string' },
                when: { type: 'string' }
            }
        }
    };
    const s = splitInput(action);
    assert.deepEqual(Object.keys(s.pathProps), ['eventId']);
    assert.deepEqual(Object.keys(s.restProps), ['when']);
    assert.deepEqual(s.requiredPath, ['eventId']);
    assert.deepEqual(s.requiredRest, []);
});

test('bind: schemaToFlags maps types, integers→number, enums→choices, required', () => {
    const flags = schemaToFlags({
        type: 'object',
        required: ['name'],
        properties: {
            name: { type: 'string' },
            count: { type: 'integer' },
            when: { type: 'string', enum: ['a', 'b'] },
            config: { type: 'object' }        // non-scalar → treated as string
        }
    });
    assert.equal(flags.name.type, 'string');
    assert.equal(flags.name.required, true);
    assert.equal(flags.count.type, 'number');          // integer → number
    assert.deepEqual(flags.when.choices, ['a', 'b']);
    assert.equal(flags.config.type, 'string');
    assert.equal(flags.count.required, undefined);
});

test('bind: coerceCliInput JSON-parses object/array flags, passes scalars through', () => {
    const schema = {
        properties: {
            config: { type: 'object' },
            patch: { type: 'array' },
            name: { type: 'string' }
        }
    };
    const out = coerceCliInput(schema,
            { config: '{"a":1}', patch: '[1,2]', name: 'x', missing: undefined });
    assert.deepEqual(out, { config: { a: 1 }, patch: [1, 2], name: 'x' });
});

test('bind: coerceCliInput throws ClientError on malformed JSON', () => {
    assert.throws(
            () => coerceCliInput({ properties: { config: { type: 'object' } } },
                    { config: '{bad}' }),
            (e) => e.statusCode === 400 && /valid JSON/.test(e.message));
});

test('bind: cliSummary appends a JSON-string hint for non-scalar props', () => {
    assert.equal(cliSummary({ type: 'string', description: 'A name.' }), 'A name.');
    assert.equal(cliSummary({ type: 'object', description: 'Config.' }),
            'Config. (pass as a JSON string)');
    assert.equal(cliSummary({ type: 'array' }), 'pass as a JSON string');
});

test('bind: toMcpTool uses description (or summary) + the raw input schema', () => {
    const input = { type: 'object', properties: {} };
    assert.deepEqual(
            toMcpTool('events.get', { summary: 'S', input }),
            { name: 'events.get', description: 'S', inputSchema: input });
    assert.equal(
            toMcpTool('x', { summary: 'S', description: 'D', input }).description,
            'D');
});
