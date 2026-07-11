// A handler may throw ClientError to signal a caller-caused failure (bad input,
// failed precondition) with an HTTP-ish status. Adapters map it: REST -> that
// status code, MCP -> an isError tool result, CLI -> stderr + non-zero exit.
// Anything else that throws is a real 500/bug.
export class ClientError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'ClientError';
        this.statusCode = statusCode;
    }
}
