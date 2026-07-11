import { ClientError } from './errors.mjs';

// Pure helpers that project a logic.mjs action descriptor onto each interface.
// Every adapter (cli / rest / mcp) goes through these, so the registry stays
// the single source of truth.

// The `:name` segments of an http path template are the path params.
export function pathParams(httpPath) {
    return [...httpPath.matchAll(/:([A-Za-z0-9_]+)/g)].map(m => m[1]);
}

// Split an action's flat input schema into the props that ride in the URL path
// vs. the props that ride in the body (write methods) / querystring (GET).
export function splitInput(action) {
    const params = pathParams(action.http.path);
    const props = action.input.properties ?? {};
    const required = action.input.required ?? [];

    const pathProps = {};
    const restProps = {};
    for (const [k, v] of Object.entries(props)) {
        (params.includes(k) ? pathProps : restProps)[k] = v;
    }

    return {
        params,
        pathProps,
        restProps,
        requiredPath: required.filter(r => r in pathProps),
        requiredRest: required.filter(r => r in restProps)
    };
}

// Help text for a property on the CLI: the shared, interface-neutral
// description plus any hint the CLI adapter must add for its own mechanics.
// Object/array properties arrive as JSON strings (see coerceCliInput), so we
// say so here rather than polluting the registry description with "CLI: …".
export function cliSummary(prop) {
    const base = prop?.description;
    const isJson = prop?.type === 'object' || prop?.type === 'array';
    if (!isJson) return base;
    const hint = 'pass as a JSON string';
    return base ? `${base} (${hint})` : hint;
}

// Flat JSON Schema -> sbopts flags map.
export function schemaToFlags(schema) {
    const required = new Set(schema.required ?? []);
    const flags = {};

    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        const type =
                prop.type === 'integer' ? 'number'
                : ['string', 'number', 'boolean'].includes(prop.type) ? prop.type
                : 'string';

        const summary = cliSummary(prop);
        flags[name] = {
            type,
            ...(summary ? { summary } : {}),
            ...(prop.enum ? { choices: prop.enum } : {}),
            ...(required.has(name) ? { required: true } : {})
        };
    }

    return flags;
}

// Action -> MCP tool descriptor. MCP's inputSchema *is* our input schema.
export function toMcpTool(name, action) {
    return {
        name,
        description: action.description ?? action.summary,
        inputSchema: action.input
    };
}

export function stripUndefined(obj) {
    return Object.fromEntries(
            Object.entries(obj).filter(([, v]) => v !== undefined));
}

// Build a handler input from raw CLI flags. Nested-typed properties (object /
// array) are the sbopts escape hatch: they arrive as JSON strings and get
// parsed here, so `--config '{"a":1}'` and `--patch '[...]'` just work.
export function coerceCliInput(schema, flags) {
    const props = schema.properties ?? {};
    const out = {};
    for (const [k, v] of Object.entries(flags)) {
        if (v === undefined) continue;
        const type = props[k]?.type;
        if ((type === 'object' || type === 'array') && typeof v === 'string') {
            try {
                out[k] = JSON.parse(v);
            }
            catch (e) {
                throw new ClientError(`--${k} must be valid JSON: ${e.message}`);
            }
        }
        else {
            out[k] = v;
        }
    }
    return out;
}
