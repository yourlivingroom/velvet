import { spawn } from 'child_process';
import fs from 'fs';
import pathLib from 'path';
import { fileURLToPath } from 'url';

// `velvet --dev`: run both halves with hot-reload, no restarts.
//   - the backend under `node --watch` (auto-restarts on .mjs changes);
//   - the Vite dev server (React HMR), which proxies API/infra paths back to
//     the backend (see client/vite.config.js), so it's one dev URL.
// The backend runs API-only here (VELVET_DEV=1 → it skips serving built assets;
// Vite serves the client).
export function runDev() {
    const dir = pathLib.dirname(fileURLToPath(import.meta.url));
    const viteBin = pathLib.join(dir, 'client', 'node_modules', '.bin', 'vite');

    if (!fs.existsSync(viteBin)) {
        console.error('\n  Client dependencies not installed.\n'
                + '  Run:  npm run build:client   (or: cd client && npm install)\n');
        process.exit(1);
    }

    const children = [];
    let downing = false;
    const shutdown = (code = 0) => {
        if (downing) return;
        downing = true;
        for (const c of children) { try { c.kill('SIGTERM'); } catch { /* */ } }
        process.exit(code ?? 0);
    };
    const start = (cmd, args, opts) => {
        const c = spawn(cmd, args, { stdio: 'inherit', ...opts });
        c.on('exit', (code) => shutdown(code ?? 0));
        children.push(c);
    };

    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));

    // Backend runs in the INVOCATION cwd (not the install dir) so the default
    // `data/` (and a relative VELVET_DATA) resolve exactly as `velvet` does.
    // (index.mjs is passed as an absolute path, so cwd is free to be yours.)
    start(process.execPath,
            ['--watch', pathLib.join(dir, 'index.mjs'), 'serve'],
            { env: { ...process.env, VELVET_DEV: '1' } });
    start(viteBin, [], { cwd: pathLib.join(dir, 'client') });

    process.stdout.write('\n  velvet dev\n'
            + '  app (Vite + HMR):  http://localhost:5173\n'
            + '  log in at:         http://localhost:5173/admin\n'
            + '  api (proxied):     http://localhost:3000\n\n');
}
