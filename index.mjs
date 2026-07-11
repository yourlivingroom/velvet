#!/usr/bin/env node
import { buildCli } from './cli.mjs';
import { startServer } from './server.mjs';
import { runDev } from './dev.mjs';
import velvetLogic from './logic.mjs';

async function main() {
    const argv = process.argv.slice(2);
    const rootPath = process.env.VELVET_DATA ?? 'data';

    // No args, `serve`, or `--dev` -> run the server. Anything else -> the CLI.
    const first = argv[0];
    if (argv.length === 0 || first === 'serve' || first === '--dev') {
        if (argv.includes('--dev')) {
            runDev();   // supervisor: watched backend + Vite HMR
            return;
        }
        const port = Number(process.env.VELVET_PORT ?? 3000);
        await startServer(velvetLogic(rootPath), { port, rootPath });
        return;
    }

    // The CLI is short-lived and filesystem-trust: run indexes inline so it
    // never grabs the LevelDB lock and can run beside a live server.
    const logic = velvetLogic(rootPath, { inline: true });
    try {
        await buildCli(logic.actions, { makeContext: logic.makeContext })
                .run(argv);
    }
    finally {
        await logic.close();
    }
}

main().catch(e => {
    console.error(e);
    process.exitCode = 1;
});
