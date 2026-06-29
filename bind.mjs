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

// Flat JSON Schema -> sbopts flags map.
export function schemaToFlags(schema) {
    const required = new Set(schema.required ?? []);
    const flags = {};

    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        const type =
                prop.type === 'integer' ? 'number'
                : ['string', 'number', 'boolean'].includes(prop.type) ? prop.type
                : 'string';

        flags[name] = {
            type,
            ...(prop.description ? { summary: prop.description } : {}),
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
