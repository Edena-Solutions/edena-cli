/** Exit codes, so a script or an agent can tell what went wrong without reading the message. */
export const EXIT = {
    ok: 0,
    failure: 1,
    usage: 2,
    auth: 3,
    notFound: 4,
    conflict: 5,
    rateLimited: 6,
} as const;

/** A mistake in how the command was called: what is wrong, and how to call it. */
export class UsageError extends Error {
    readonly exitCode = EXIT.usage;
    constructor(
        message: string,
        readonly hint?: string,
    ) {
        super(message);
    }
}

/** No key to call the API with: nobody signed in, and no `EDENA_API_KEY`. */
export class NotSignedInError extends Error {
    readonly exitCode = EXIT.auth;
    readonly hint = "Run edena login, or set EDENA_API_KEY.";
    constructor() {
        super("Not signed in.");
    }
}

/** An error the API answered, with its stable `key` and the `requestId` to quote when asking for help. */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly key: string,
        message: string,
        readonly requestId: string | null,
        readonly details: unknown,
    ) {
        super(message);
    }

    get exitCode(): number {
        if (this.status === 401 || this.status === 403) return EXIT.auth;
        if (this.status === 404) return EXIT.notFound;
        if (this.status === 409 || this.status === 422) return EXIT.conflict;
        if (this.status === 429) return EXIT.rateLimited;
        return EXIT.failure;
    }
}
