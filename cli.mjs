import { command } from '@shieldsbetter/sbopts';
import { schemaToFlags, coerceCliInput, pathParams, cliSummary } from './bind.mjs';
import { ClientError } from './errors.mjs';

// Project the action registry onto an sbopts command tree. A dotted action name
// `invites.create` becomes the subcommand path `velvet invites create`; the
// action's flat input schema becomes that leaf's flags.
//
// Positional slots on the CLI are the path params (the `:name` segments, in
// order) followed by the action's payload, if it has one. Each slot can be
// filled positionally OR by its `--name` flag; giving one both ways is an
// error. Everything else stays a flag.
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
            const slots = [
                ...pathParams(action.http.path),
                ...(action.payload ? [action.payload] : [])
            ];
            const required = new Set(action.input.required ?? []);
            const flags = schemaToFlags(action.input);

            // Slots can be satisfied positionally, so don't let sbopts enforce
            // their flags as required — we check that ourselves after merging.
            const args = slots.map(name => {
                if (flags[name]) flags[name] = { ...flags[name], required: false };
                return {
                    name,
                    required: required.has(name),
                    summary: cliSummary(action.input.properties?.[name])
                };
            });

            sub[verb] = {
                summary: action.summary,
                flags,
                ...(args.length ? { args } : {}),
                run: ({ flags, positionals }) =>
                        dispatch(action, flags, positionals, slots, required)
            };
        }
        commands[ns] = { summary: `Manage ${ns}.`, commands: sub };
    }

    return command(name, {
        summary: 'Velvet event-management CLI.',
        commands
    });
}

async function dispatch(action, flags, positionals, slots, required) {
    try {
        if (positionals.length > slots.length) {
            throw new ClientError(
                    `Unexpected argument '${positionals[slots.length]}'.`);
        }

        const merged = { ...flags };
        slots.forEach((name, i) => {
            const pos = positionals[i];
            if (pos === undefined) return;
            if (flags[name] !== undefined) {
                throw new ClientError(`'${name}' was given twice: positional `
                        + `'${pos}' and --${name} '${flags[name]}'.`);
            }
            merged[name] = pos;
        });

        for (const name of slots) {
            if (required.has(name) && merged[name] === undefined) {
                throw new ClientError(`Missing required argument <${name}>.`);
            }
        }

        const input = coerceCliInput(action.input, merged);
        const result = await action.handler(input);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    catch (e) {
        if (e instanceof ClientError) {
            process.stderr.write(e.message + '\n');
            process.exitCode = 1;
            return;
        }
        throw e;
    }
}
