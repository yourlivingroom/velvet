#!/usr/bin/env node
import { buildCli } from './cli.mjs';
import { startServer } from './server.mjs';
import velvetLogic from './logic.mjs';

async function main() {
    const argv = process.argv.slice(2);
    const rootPath = process.env.VELVET_DATA ?? 'data';

    // No args (or `serve`) -> run the server. Anything else -> run the CLI.
    if (argv.length === 0 || argv[0] === 'serve') {
        await startServer(velvetLogic(rootPath), { port: 3000, rootPath });
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
