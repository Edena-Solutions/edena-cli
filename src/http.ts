import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";
import { VERSION } from "./version.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const WRITES: ReadonlySet<HttpMethod> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RETRIES = 3;

export interface RequestOptions {
    apiUrl: string;
    apiKey: string | null;
    method: HttpMethod;
    path: string;
    query?: Record<string, string | string[] | undefined>;
    body?: unknown;
    /** An operation's own headers, beside the ones every request carries. */
    headers?: Record<string, string>;
    /** Reused on every retry, so a write sent twice is done once. One is made when left out. */
    idempotencyKey?: string;
}

export type ApiResponse =
    | { kind: "json"; status: number; data: unknown; requestId: string | null }
    | { kind: "file"; status: number; data: Buffer; contentType: string; requestId: string | null }
    | { kind: "empty"; status: number; requestId: string | null };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the API answers on a 429 or a 5xx: worth retrying, waiting longer each time. */
const retryable = (status: number) => status === 429 || status >= 500;

/**
 * Calls the API: the key, an `Idempotency-Key` on writes, retries on 429, 5xx and dropped
 * connections with exponential backoff, and every error as an {@link ApiError} with its stable key.
 */
export async function apiRequest(options: RequestOptions): Promise<ApiResponse> {
    const url = new URL(`${options.apiUrl}${options.path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, item);
    }
    const headers: Record<string, string> = {
        ...options.headers,
        Accept: "application/json",
        "User-Agent": `edena-cli/${VERSION} (node ${process.version}; ${process.platform})`,
    };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    if (WRITES.has(options.method)) headers["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);

    for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
            response = await fetch(url, { method: options.method, headers, body });
        } catch (error) {
            if (attempt < RETRIES) {
                await sleep(backoff(attempt));
                continue;
            }
            throw new ApiError(0, "cli.network_error", `Could not reach ${options.apiUrl}: ${(error as Error).message}`, null, null);
        }
        if (retryable(response.status) && attempt < RETRIES) {
            await sleep(backoff(attempt, response.headers.get("retry-after")));
            continue;
        }
        return read(response);
    }
}

function backoff(attempt: number, retryAfter?: string | null): number {
    const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 30) * 1000;
    return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

async function read(response: Response): Promise<ApiResponse> {
    const requestId = response.headers.get("x-request-id");
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
        const text = await response.text();
        let parsed: { key?: string; message?: string | string[]; requestId?: string; details?: unknown } = {};
        try {
            parsed = JSON.parse(text);
        } catch {
            // Not the API's error body: a proxy, a gateway. The status says enough.
        }
        const message = Array.isArray(parsed.message) ? parsed.message.join("; ") : (parsed.message ?? (text || response.statusText));
        throw new ApiError(response.status, parsed.key ?? `http.${response.status}`, message, parsed.requestId ?? requestId, parsed.details ?? null);
    }
    if (response.status === 204) return { kind: "empty", status: response.status, requestId };
    if (contentType.includes("application/json")) {
        const text = await response.text();
        return { kind: "json", status: response.status, data: text ? JSON.parse(text) : null, requestId };
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) return { kind: "empty", status: response.status, requestId };
    return { kind: "file", status: response.status, data, contentType, requestId };
}
