import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import pathLib from 'path';

// Blob storage: binary that JSON refers to by an embedded sentinel
// `{ $blob: '<bucket>/blb_<id>' }`. This is a REST-native subsystem (like
// auth.mjs), NOT a registry action — the resumable transfer protocol
// (offset-addressed append, HEAD-to-resume, Range download) doesn't project
// onto CLI/MCP. The registry stays JSON-only; MCP/CLI can still carry $blob
// refs inside `config`, they just can't move bytes.
//
// A **bucket** is a permission-scoped namespace. Only one kind exists today —
// per-event buckets `events/<evt_id>`, writable by that event's admin and
// readable by any participant — but resolveBucket() is where more kinds slot in.
//
// The upload protocol is deliberately shaped so progress bars and resumable
// uploads can be built on it:
//   POST   /blobs/<bucket>            create a session (declare total size)
//   PATCH  /blobs/<bucket>/<blobId>   append a chunk at Upload-Offset
//   HEAD   /blobs/<bucket>/<blobId>   query current offset (to resume)
//   GET    /blobs/<bucket>/<blobId>   download (Range-aware) once complete
//   DELETE /blobs/<bucket>/<blobId>   remove

const MAX_BLOB = 25 * 1024 * 1024;     // declared-size ceiling (25 MB)
const MAX_CHUNK = 8 * 1024 * 1024;     // per-PATCH body ceiling (8 MB)
const OFFSET_MEDIA_TYPE = 'application/offset+octet-stream';

// Map a bucket string to its access rules + storage policy, or null for an
// unknown/malformed bucket (→ 404, and — since the regex is strict — no `..` can
// reach the fs). Policy fields:
//   maxBytes — total cap across ALL blobs in the bucket; a create past it fails.
//   evict    — 'oldest' purges oldest *complete* blobs to make room; 'reject'
//              (the default when omitted) never deletes, just 413s.
function resolveBucket(bucket) {
    // Per-event bucket: grades exactly like the event (see logic.eventAccess).
    // Roomy cap, evict-oldest — so replacing a cover eventually reaps stale ones.
    const ev = /^events\/(evt_[0-9a-f]+)$/.exec(bucket ?? '');
    if (ev) {
        const id = ev[1];
        return {
            canWrite: (ctx) => ctx.can(`/events/${id}/admin`),
            canRead: (ctx) => ctx.can(`/events/${id}/admin`)
                    || ctx.can(`/events/${id}/join`)
                    || ctx.can(`/events/${id}/view`),
            maxBytes: 10 * 1024 * 1024,
            evict: 'oldest'
        };
    }
    // Per-user bucket: a small, self-purging home for profile pictures. The owner
    // (or a global admin) writes; any signed-in caller reads (avatars show in
    // guest lists). Tight cap + evict-oldest, so uploading several quickly reaps
    // the stale ones.
    const ac = /^accounts\/(acct_[0-9a-f]+)$/.exec(bucket ?? '');
    if (ac) {
        const id = ac[1];
        return {
            canWrite: (ctx) => ctx.can('/server/admin') || ctx.auth?.sub === id,
            canRead: (ctx) => !!ctx.auth,
            maxBytes: 2 * 1024 * 1024,
            evict: 'oldest'
        };
    }
    return null;
}

// Split a blob-op splat (`<bucket>/<blobId>`) into its parts, validating both.
// The blob id must be one of ours; the bucket must resolve. null → 404.
function parseBlobPath(splat) {
    const i = (splat ?? '').lastIndexOf('/');
    if (i < 0) return null;
    const bucket = splat.slice(0, i);
    const blobId = splat.slice(i + 1);
    if (!/^blb_[0-9a-f]+$/.test(blobId)) return null;
    const resolver = resolveBucket(bucket);
    if (!resolver) return null;
    return { bucket, blobId, resolver };
}

export async function registerBlobs(fastify,
        { authenticate, csrfGuard, makeContext, rootPath = 'data' } = {}) {
    const blobsRoot = pathLib.join(rootPath, 'blobs');

    // On-disk layout: bytes at <root>/<bucket>/<blobId>, metadata beside it as
    // <blobId>.meta.json. Bucket has a slash → nested dirs (validated, so safe).
    const dataPath = (bucket, blobId) =>
            pathLib.join(blobsRoot, bucket, blobId);
    const metaPath = (bucket, blobId) =>
            pathLib.join(blobsRoot, bucket, `${blobId}.meta.json`);

    async function readMeta(bucket, blobId) {
        try {
            return JSON.parse(
                    await fs.readFile(metaPath(bucket, blobId), 'utf8'));
        }
        catch (e) {
            if (e.code === 'ENOENT') return null;
            throw e;
        }
    }
    const writeMeta = (meta) =>
            fs.writeFile(metaPath(meta.bucket, meta.id), JSON.stringify(meta));

    async function createBlob(bucket, { size, contentType, filename }) {
        const id = `blb_${crypto.randomBytes(12).toString('hex')}`;
        await fs.mkdir(pathLib.join(blobsRoot, bucket), { recursive: true });
        await fs.writeFile(dataPath(bucket, id), '');   // so a size-0 GET works
        const now = new Date().toISOString();
        const meta = {
            id, bucket, contentType, size, offset: 0,
            complete: size === 0, filename, createdAt: now, updatedAt: now
        };
        await writeMeta(meta);
        return meta;
    }

    // Append a chunk iff it starts exactly at the current offset (else report
    // the real offset so the client can re-sync — that's what makes it
    // resumable). Callers run this under withLock so appends serialize.
    async function appendChunk(bucket, blobId, offset, chunk) {
        const meta = await readMeta(bucket, blobId);
        if (!meta) return { notFound: true };
        if (meta.complete || offset !== meta.offset) {
            return { conflict: meta.offset };
        }
        if (offset + chunk.length > meta.size) return { overflow: true };
        await fs.appendFile(dataPath(bucket, blobId), chunk);
        meta.offset += chunk.length;
        if (meta.offset === meta.size) meta.complete = true;
        meta.updatedAt = new Date().toISOString();
        await writeMeta(meta);
        return { meta };
    }

    async function deleteBlob(bucket, blobId) {
        let existed = false;
        for (const p of [dataPath(bucket, blobId), metaPath(bucket, blobId)]) {
            try { await fs.unlink(p); existed = true; }
            catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        return existed;
    }

    // Per-blob async lock: chain writes to a given blob so two PATCHes (or a
    // PATCH and a DELETE) never interleave. Mirrors pulp-db's per-path serializing.
    const locks = new Map();
    function withLock(key, fn) {
        const prev = locks.get(key) ?? Promise.resolve();
        const result = prev.then(fn, fn);   // run after prev settles, either way
        const gate = result.then(() => {}, () => {});
        locks.set(key, gate);
        gate.finally(() => { if (locks.get(key) === gate) locks.delete(key); });
        return result;
    }

    // Total declared bytes in a bucket (an in-progress blob reserves its full
    // size), plus every blob's meta — for quota checks and eviction.
    async function bucketUsage(bucket) {
        const dir = pathLib.join(blobsRoot, bucket);
        let names;
        try { names = await fs.readdir(dir); }
        catch (e) {
            if (e.code === 'ENOENT') return { total: 0, blobs: [] };
            throw e;
        }
        const blobs = [];
        for (const n of names) {
            if (!n.endsWith('.meta.json')) continue;
            try {
                blobs.push(JSON.parse(
                        await fs.readFile(pathLib.join(dir, n), 'utf8')));
            }
            catch { /* skip a torn/unreadable sidecar */ }
        }
        return { total: blobs.reduce((s, m) => s + (m.size ?? 0), 0), blobs };
    }

    // Enforce the bucket byte cap for a new upload of `spec.size`, evicting the
    // oldest *complete* blobs first when the policy allows. Runs under a
    // per-bucket lock so check→evict→create is atomic against concurrent creates.
    // Returns the new blob's meta, or { quota: true } when it can't be made to fit.
    function reserveAndCreate(bucket, resolver, spec) {
        const max = resolver.maxBytes ?? Infinity;
        return withLock(`bucket:${bucket}`, async () => {
            if (spec.size > max) return { quota: true };   // never fits, any policy
            let { total: used, blobs } = await bucketUsage(bucket);
            if (used + spec.size > max && resolver.evict === 'oldest') {
                const oldestFirst = blobs
                        .filter(b => b.complete)
                        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
                for (const b of oldestFirst) {
                    if (used + spec.size <= max) break;
                    await deleteBlob(bucket, b.id);
                    used -= b.size ?? 0;
                }
            }
            if (used + spec.size > max) return { quota: true };
            return { meta: await createBlob(bucket, spec) };
        });
    }

    // Raw body for PATCH chunks. `parseAs: 'buffer'` + a raised bodyLimit so a
    // chunk up to MAX_CHUNK isn't rejected by the default 1 MB limit.
    fastify.addContentTypeParser(OFFSET_MEDIA_TYPE,
            { parseAs: 'buffer', bodyLimit: MAX_CHUNK },
            (req, body, done) => done(null, body));

    // ---- onRequest chains (mirror rest.mjs) --------------------------------
    // Populate request.auth from the session cookie (or Bearer); write routes
    // additionally run csrfGuard. Both may be absent under VELVET_AUTH=off, where
    // makeContext resolves every caller to admin anyway.
    const attachAuth = authenticate
            ? async (request) => {
                request.auth = await authenticate(request, { cookie: true });
            }
            : null;
    const readChain = [attachAuth].filter(Boolean);
    const writeChain = [attachAuth, csrfGuard].filter(Boolean);
    const withOnRequest = (chain) =>
            (chain.length ? { onRequest: chain } : {});

    const ctxOf = (request) => makeContext(request.auth ?? null);
    const notFound = (reply) => reply.code(404).send({ error: 'Not found' });
    const forbidden = (reply) =>
            reply.code(403).send({ error: 'forbidden' });

    // ---- create ------------------------------------------------------------
    fastify.route({
        method: 'POST', url: '/blobs/*', schema: { hide: true },
        bodyLimit: 64 * 1024,   // just the small JSON envelope
        ...withOnRequest(writeChain),
        handler: async (request, reply) => {
            const bucket = request.params['*'];
            const resolver = resolveBucket(bucket);
            if (!resolver) return notFound(reply);
            if (!resolver.canWrite(await ctxOf(request))) return forbidden(reply);

            const { size, contentType, filename } = request.body ?? {};
            if (!Number.isInteger(size) || size < 0 || size > MAX_BLOB) {
                return reply.code(400).send({
                    error: 'bad_size',
                    detail: `size must be an integer 0..${MAX_BLOB}` });
            }
            // Quota + eviction (per-bucket policy); may purge oldest to fit.
            const r = await reserveAndCreate(bucket, resolver, {
                size,
                contentType: contentType || 'application/octet-stream',
                filename: filename || undefined
            });
            if (r.quota) {
                return reply.code(413).send({
                    error: 'quota',
                    detail: `bucket cap is ${resolver.maxBytes} bytes`,
                    maxBytes: resolver.maxBytes });
            }
            const meta = r.meta;
            reply.header('Location', `/blobs/${bucket}/${meta.id}`);
            reply.code(201);
            return {
                id: meta.id, bucket, ref: `${bucket}/${meta.id}`,
                offset: 0, size: meta.size, contentType: meta.contentType
            };
        }
    });

    // ---- append ------------------------------------------------------------
    fastify.route({
        method: 'PATCH', url: '/blobs/*', schema: { hide: true },
        bodyLimit: MAX_CHUNK,
        ...withOnRequest(writeChain),
        handler: async (request, reply) => {
            const parsed = parseBlobPath(request.params['*']);
            if (!parsed) return notFound(reply);
            if (!parsed.resolver.canWrite(await ctxOf(request))) {
                return forbidden(reply);
            }
            const offset = Number(request.headers['upload-offset']);
            if (!Number.isInteger(offset) || offset < 0) {
                return reply.code(400).send({
                    error: 'bad_offset', detail: 'Upload-Offset header required' });
            }
            const chunk = Buffer.isBuffer(request.body)
                    ? request.body : Buffer.alloc(0);
            const r = await withLock(`${parsed.bucket}/${parsed.blobId}`,
                    () => appendChunk(parsed.bucket, parsed.blobId, offset, chunk));
            if (r.notFound) return notFound(reply);
            if (r.overflow) {
                return reply.code(400).send({ error: 'overflow',
                    detail: 'chunk exceeds declared size' });
            }
            if (r.conflict !== undefined) {
                reply.header('Upload-Offset', String(r.conflict));
                return reply.code(409).send({
                    error: 'offset_mismatch', offset: r.conflict });
            }
            reply.header('Upload-Offset', String(r.meta.offset));
            if (r.meta.complete) reply.header('Upload-Complete', 'true');
            return reply.code(204).send();
        }
    });

    // ---- status / resume ---------------------------------------------------
    fastify.route({
        method: 'HEAD', url: '/blobs/*', schema: { hide: true },
        ...withOnRequest(readChain),
        handler: async (request, reply) => {
            const parsed = parseBlobPath(request.params['*']);
            if (!parsed) return reply.code(404).send();
            if (!parsed.resolver.canRead(await ctxOf(request))) {
                return reply.code(404).send();
            }
            const meta = await readMeta(parsed.bucket, parsed.blobId);
            if (!meta) return reply.code(404).send();
            reply.header('Upload-Offset', String(meta.offset));
            reply.header('Upload-Length', String(meta.size));
            reply.header('Upload-Complete', meta.complete ? 'true' : 'false');
            if (meta.complete) {
                reply.header('Content-Type', meta.contentType);
                reply.header('Accept-Ranges', 'bytes');
            }
            return reply.code(200).send();
        }
    });

    // ---- download ----------------------------------------------------------
    fastify.route({
        method: 'GET', url: '/blobs/*', schema: { hide: true },
        exposeHeadRoutes: false,   // we define HEAD ourselves (upload status)
        ...withOnRequest(readChain),
        handler: async (request, reply) => {
            const parsed = parseBlobPath(request.params['*']);
            if (!parsed) return notFound(reply);
            if (!parsed.resolver.canRead(await ctxOf(request))) {
                return notFound(reply);
            }
            const meta = await readMeta(parsed.bucket, parsed.blobId);
            if (!meta || !meta.complete) return notFound(reply);

            const file = dataPath(parsed.bucket, parsed.blobId);
            reply.header('Accept-Ranges', 'bytes');
            reply.header('Cache-Control',
                    'private, max-age=31536000, immutable');   // id is immutable
            reply.header('Content-Type', meta.contentType);

            if (request.headers.range) {
                const range = parseRange(request.headers.range, meta.size);
                if (!range) {
                    reply.header('Content-Range', `bytes */${meta.size}`);
                    return reply.code(416).send();
                }
                reply.code(206);
                reply.header('Content-Range',
                        `bytes ${range.start}-${range.end}/${meta.size}`);
                reply.header('Content-Length',
                        String(range.end - range.start + 1));
                return reply.send(
                        createReadStream(file, { start: range.start, end: range.end }));
            }
            reply.header('Content-Length', String(meta.size));
            return reply.send(createReadStream(file));
        }
    });

    // ---- delete ------------------------------------------------------------
    fastify.route({
        method: 'DELETE', url: '/blobs/*', schema: { hide: true },
        ...withOnRequest(writeChain),
        handler: async (request, reply) => {
            const parsed = parseBlobPath(request.params['*']);
            if (!parsed) return notFound(reply);
            if (!parsed.resolver.canWrite(await ctxOf(request))) {
                return forbidden(reply);
            }
            const removed = await withLock(`${parsed.bucket}/${parsed.blobId}`,
                    () => deleteBlob(parsed.bucket, parsed.blobId));
            if (!removed) return notFound(reply);
            return reply.code(204).send();
        }
    });
}

// Parse a single-range `Range: bytes=start-end` (or suffix `-N`) against a known
// size. Returns { start, end } (inclusive) or null (malformed / unsatisfiable).
function parseRange(header, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
    if (!m) return null;
    const [, s, e] = m;
    if (s === '' && e === '') return null;
    let start;
    let end;
    if (s === '') {                       // suffix: final N bytes
        const n = Number(e);
        if (n === 0) return null;
        start = Math.max(0, size - n);
        end = size - 1;
    }
    else {
        start = Number(s);
        end = e === '' ? size - 1 : Math.min(Number(e), size - 1);
    }
    if (start > end || start >= size) return null;
    return { start, end };
}
