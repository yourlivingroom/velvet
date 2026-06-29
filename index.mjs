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

    const logic = velvetLogic(rootPath);
    try {
        await buildCli(logic.actions).run(argv);
    }
    finally {
        await logic.close();
    }
}

main().catch(e => {
    console.error(e);
    process.exitCode = 1;
});
