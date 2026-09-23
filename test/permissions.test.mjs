import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, grantMatches } from '../permissions.mjs';

// ---------------------------------------------------------------------------
// permissions — pure unit test of the glob matcher `can(grants, path)`.
// Segment semantics (per permissions.mjs): paths are slash-delimited; each grant
// is a glob where a literal segment matches itself, `*` matches exactly ONE
// segment, and `**` matches ANY number of segments INCLUDING ZERO. A caller
// `can` do X if ANY of their grants matches. Empty segment strings are dropped
// (`.filter(Boolean)`), so leading/trailing/duplicate slashes are insignificant.
// ---------------------------------------------------------------------------

// --- lone `**` is super-admin: matches everything -------------------------
test('lone ** matches the root path', () => {
    assert.equal(can(['**'], '/'), true);
});

test('lone ** matches a shallow path', () => {
    assert.equal(can(['**'], '/events'), true);
});

test('lone ** matches a deep path', () => {
    assert.equal(can(['**'], '/events/evt_1/admin'), true);
});

test('lone ** matches an even deeper path', () => {
    assert.equal(can(['**'], '/a/b/c/d/e/f'), true);
});

// --- literal exact match and non-match ------------------------------------
test('literal grant matches the identical path', () => {
    assert.equal(can(['/events/evt_1/admin'], '/events/evt_1/admin'), true);
});

test('literal grant does not match a different segment', () => {
    assert.equal(can(['/events/evt_1/admin'], '/events/evt_2/admin'), false);
});

test('literal grant does not match a shorter path (grant longer)', () => {
    assert.equal(can(['/events/evt_1/admin'], '/events/evt_1'), false);
});

test('literal grant does not match a longer path (path longer)', () => {
    assert.equal(can(['/events/evt_1'], '/events/evt_1/admin'), false);
});

test('single-segment literal exact match', () => {
    assert.equal(can(['/events'], '/events'), true);
});

// --- `*` matches exactly one segment --------------------------------------
test('* matches exactly one segment', () => {
    assert.equal(can(['/events/*/admin'], '/events/evt_1/admin'), true);
});

test('* does not match zero segments', () => {
    assert.equal(can(['/events/*/admin'], '/events/admin'), false);
});

test('* does not match two segments', () => {
    assert.equal(can(['/events/*/admin'], '/events/a/b/admin'), false);
});

test('* matches any single value in its position', () => {
    assert.equal(can(['/accounts/*'], '/accounts/acct_zzz'), true);
    assert.equal(can(['/accounts/*'], '/accounts'), false); // needs one segment
    assert.equal(can(['/accounts/*'], '/accounts/a/b'), false); // only one
});

// --- trailing `**` ---------------------------------------------------------
test('trailing ** matches deeper paths', () => {
    assert.equal(can(['/events/**'], '/events/evt_1/admin'), true);
    assert.equal(can(['/events/**'], '/events/evt_1'), true);
});

test('trailing ** matches the prefix itself (** consumes zero segments)', () => {
    // Since `**` can consume zero segments, `/events/**` matches bare `/events`.
    assert.equal(can(['/events/**'], '/events'), true);
});

test('trailing ** does not match a sibling prefix', () => {
    assert.equal(can(['/events/**'], '/accounts/acct_1'), false);
});

// --- `**` in the middle ----------------------------------------------------
test('** in the middle matches one intervening segment', () => {
    assert.equal(can(['/events/**/admin'], '/events/evt_1/admin'), true);
});

test('** in the middle matches multiple intervening segments', () => {
    assert.equal(can(['/events/**/admin'], '/events/a/b/c/admin'), true);
});

test('** in the middle matches zero intervening segments', () => {
    // `**` can consume zero, so /events/**/admin matches /events/admin.
    assert.equal(can(['/events/**/admin'], '/events/admin'), true);
});

test('** in the middle still requires the trailing literal', () => {
    assert.equal(can(['/events/**/admin'], '/events/evt_1/view'), false);
});

// --- multiple grants: OR semantics ----------------------------------------
test('matches if ANY grant matches', () => {
    const grants = ['/events/evt_1/view', '/events/evt_1/admin'];
    assert.equal(can(grants, '/events/evt_1/admin'), true);
});

test('no match when no grant matches', () => {
    const grants = ['/events/evt_1/view', '/events/evt_2/admin'];
    assert.equal(can(grants, '/events/evt_1/admin'), false);
});

test('empty grants array matches nothing', () => {
    assert.equal(can([], '/events/evt_1/admin'), false);
    assert.equal(can([], '/'), false);
});

// --- edge cases the code actually implements ------------------------------
test('trailing slashes are insignificant (filter(Boolean) drops empty segs)', () => {
    assert.equal(can(['/events/evt_1'], '/events/evt_1/'), true);
    assert.equal(can(['/events/evt_1/'], '/events/evt_1'), true);
});

test('duplicate and leading slashes are insignificant', () => {
    assert.equal(can(['//events///evt_1'], '/events/evt_1'), true);
});

test('root path matches an empty-segment grant', () => {
    // segments('/') === [] and segments('') === []; a grant of '/' matches '/'.
    assert.equal(can(['/'], '/'), true);
    assert.equal(can(['/'], '/events'), false);
});

test('matching is case-sensitive (literal ===)', () => {
    assert.equal(can(['/events/evt_1'], '/Events/evt_1'), false);
    assert.equal(can(['/Events/evt_1'], '/events/evt_1'), false);
});

test('* alone matches exactly one segment, not root, not two', () => {
    assert.equal(can(['*'], '/events'), true);
    assert.equal(can(['*'], '/'), false);       // zero segments
    assert.equal(can(['*'], '/a/b'), false);    // two segments
});

// --- grantMatches (single-grant helper) directly --------------------------
test('grantMatches mirrors can for a single grant', () => {
    assert.equal(grantMatches('/events/*/admin', '/events/evt_1/admin'), true);
    assert.equal(grantMatches('/events/*/admin', '/events/admin'), false);
});
