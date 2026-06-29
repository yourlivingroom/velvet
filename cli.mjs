import { command } from '@shieldsbetter/sbopts';
import { schemaToFlags, stripUndefined } from './bind.mjs';

// Project the action registry onto an sbopts command tree. A dotted action name
// `invites.create` becomes the subcommand path `velvet invites create`; the
// action's flat input schema becomes that leaf's flags.
export function buildCli(actions, { name = 'velvet' } = {}) {
    const groups = {};
    for (const [full, action] of Object.entries(actions)) {
        const [ns, verb] = full.split('.');
        (groups[ns] ??= {})[verb] = action;
    }

    const commands = {};
    for (const [ns, verbs] of Object.entries(groups)) {
        const sub = {};
        for (const [verb, action] of Object.entries(verbs)) {
            sub[verb] = {
                summary: action.summary,
                flags: schemaToFlags(action.input),
                run: async ({ flags }) => {
                    const result = await action.handler(stripUndefined(flags));
                    process.stdout.write(
                            JSON.stringify(result, null, 2) + '\n');
                }
            };
        }
        commands[ns] = { summary: `Manage ${ns}.`, commands: sub };
    }

    return command(name, {
        summary: 'Velvet event-management CLI.',
        commands
    });
}
