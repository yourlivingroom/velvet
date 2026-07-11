import { spawn } from 'child_process';
import fs from 'fs';
import pathLib from 'path';
import { fileURLToPath } from 'url';

// `velvet --dev`: run both halves with hot-reload, no restarts.
//   - the backend, spawned by us and reloaded on any backend `.mjs` change;
//   - the Vite dev server (React HMR), which proxies API/infra paths back to
//     the backend (see client/vite.config.js), so it's one dev URL.
// The backend runs API-only here (VELVET_DEV=1 → it skips serving built assets;
// Vite serves the client).
//
// We deliberately DON'T use `node --watch`. It watches file *inodes* via
// fs.watch, which go stale the moment a file is saved atomically (editors — and
// our own tooling — write a temp file then rename it into place, swapping the
// inode). So `node --watch` reloads once and then silently stops, leaving a
// stale backend on :3000. Instead we watch the source *directories* (whose
// inodes are stable, so the rename is seen every time) and restart the child
// ourselves — sequentially: SIGTERM the old, await its exit, then spawn the
// new. That non-overlap matters here: the outgoing process must fully release
// the port and cardcatalog's exclusive LevelDB lock before the next one boots,
// or the reload would wedge on the lock.
export function runDev() {
    const dir = pathLib.dirname(fileURLToPath(import.meta.url));
    const viteBin = pathLib.join(dir, 'client', 'node_modules', '.bin', 'vite');

    if (!fs.existsSync(viteBin)) {
        console.error('\n  Client dependencies not installed.\n'
                + '  Run:  npm run build:client   (or: cd client && npm install)\n');
        process.exit(1);
    }

    let downing = false;
    let backend = null;
    let vite = null;
    let restarting = false;
    let pending = false;
    let debounce = null;
    const watchers = [];

    const shutdown = (code = 0) => {
        if (downing) return;
        downing = true;
        clearTimeout(debounce);
        for (const w of watchers) { try { w.close(); } catch { /* */ } }
        for (const c of [backend, vite]) { try { c?.kill('SIGTERM'); } catch { /* */ } }
        process.exit(code ?? 0);
    };
    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));

    // --- Backend child: spawn + supervised, sequential restart --------------
    // index.mjs is passed as an absolute path, so the child runs in the
    // INVOCATION cwd — the default `data/` (and a relative VELVET_DATA) resolve
    // exactly as `velvet` does.
    const backendEnv = { ...process.env, VELVET_DEV: '1' };
    const spawnBackend = () => {
        backend = spawn(process.execPath,
                [pathLib.join(dir, 'index.mjs'), 'serve'],
                { stdio: 'inherit', env: backendEnv });
        backend.on('exit', (code) => {
            // A crash (an exit that isn't part of our own reload) takes the whole
            // dev session down — the same net effect `node --watch` had.
            if (!restarting && !downing) shutdown(code ?? 0);
        });
    };

    const restartBackend = async () => {
        if (restarting) { pending = true; return; }   // coalesce concurrent triggers
        restarting = true;
        const old = backend;
        if (old && old.exitCode === null && old.signalCode === null) {
            process.stdout.write('\n  velvet: reloading backend…\n');
            await new Promise((resolve) => {
                old.once('exit', resolve);
                try { old.kill('SIGTERM'); } catch { resolve(); }
                // Safety net: never let a stuck process block the reload forever.
                setTimeout(() => { try { old.kill('SIGKILL'); } catch { /* */ } },
                        4000).unref();
            });
        }
        spawnBackend();
        restarting = false;
        if (pending) { pending = false; restartBackend(); }
    };

    // --- Watch backend sources (velvet only) --------------------------------
    // Non-recursive: every backend `.mjs` lives at the package root, so we catch
    // them all without descending into client/ or node_modules (cheap, and no
    // inotify blowup). A rename into the dir (the atomic save) fires here. We
    // don't watch the file:../ sibling deps (pulp-db/cardcatalog) — their layout
    // is the operator's, not the project's; restart by hand when they change.
    const onChange = (_evt, file) => {
        if (!file || !file.endsWith('.mjs')) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => { restartBackend(); }, 120);
    };
    try { watchers.push(fs.watch(dir, onChange)); }
    catch { /* unwatchable dir — skip it */ }

    // --- Start both halves --------------------------------------------------
    spawnBackend();
    vite = spawn(viteBin, [], { stdio: 'inherit', cwd: pathLib.join(dir, 'client') });
    vite.on('exit', (code) => { if (!downing) shutdown(code ?? 0); });

    process.stdout.write('\n  velvet dev\n'
            + '  app (Vite + HMR):  http://localhost:5173\n'
            + '  log in at:         http://localhost:5173/admin\n'
            + '  api (proxied):     http://localhost:3000\n\n');
}
