import { ApiError } from "./errors.js";
import { VERSION } from "./version.js";

export interface StreamMessage {
    id: string | null;
    event: string;
    data: string;
}

interface StreamOptions {
    url: string;
    apiKey: string;
    onMessage: (message: StreamMessage) => void | Promise<void>;
    /** Told when the connection opens, and again on every reconnection. */
    onOpen?: (reconnected: boolean) => void;
    onDisconnect?: (error: unknown) => void;
    signal: AbortSignal;
}

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        });
    });

/**
 * Follows a server-sent events stream of the API until `signal` aborts: messages in order, and when the
 * connection ends (the API closes each after a few minutes, or the network drops) it reconnects with
 * `Last-Event-ID`, so nothing is missed or repeated. A refusal (401, 403, 404) is not retried.
 */
export async function followStream(options: StreamOptions): Promise<void> {
    let lastId: string | null = null;
    let retryMs = 3000;
    let failures = 0;
    let opened = false;

    while (!options.signal.aborted) {
        try {
            const response = await fetch(options.url, {
                headers: {
                    Accept: "text/event-stream",
                    Authorization: `Bearer ${options.apiKey}`,
                    "User-Agent": `edena-cli/${VERSION}`,
                    ...(lastId && { "Last-Event-ID": lastId }),
                },
                signal: options.signal,
            });
            if (!response.ok || !response.body) {
                const body = (await response.json().catch(() => ({}))) as { key?: string; message?: string; requestId?: string };
                const error = new ApiError(response.status, body.key ?? `http.${response.status}`, body.message ?? response.statusText, body.requestId ?? null, null);
                if (response.status < 500 && response.status !== 429) throw error;
                throw Object.assign(error, { retryable: true });
            }
            options.onOpen?.(opened);
            opened = true;
            failures = 0;
            let buffer = "";
            let message: StreamMessage = { id: null, event: "message", data: "" };
            const decoder = new TextDecoder();
            for await (const chunk of response.body) {
                buffer += decoder.decode(chunk as Uint8Array, { stream: true });
                let newline: number;
                while ((newline = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, newline).replace(/\r$/, "");
                    buffer = buffer.slice(newline + 1);
                    if (line === "") {
                        if (message.data !== "" || message.id) {
                            if (message.id) lastId = message.id;
                            if (message.event !== "reconnect") await options.onMessage(message);
                        }
                        message = { id: null, event: "message", data: "" };
                        continue;
                    }
                    if (line.startsWith(":")) continue;
                    const colon = line.indexOf(":");
                    const field = colon < 0 ? line : line.slice(0, colon);
                    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
                    if (field === "id") message.id = value;
                    else if (field === "event") message.event = value;
                    else if (field === "data") message.data = message.data ? `${message.data}\n${value}` : value;
                    else if (field === "retry" && Number(value) > 0) retryMs = Number(value);
                }
            }
        } catch (error) {
            if (options.signal.aborted) return;
            if (error instanceof ApiError && !(error as ApiError & { retryable?: boolean }).retryable) throw error;
            failures++;
            options.onDisconnect?.(error);
        }
        await sleep(Math.min(retryMs * 2 ** Math.max(0, failures - 1), 30_000), options.signal);
    }
}

/** `15m`, `2h`, `1d` ago, or an ISO date, as an ISO date for `since`. */
export function sinceOf(value: string): string {
    const match = /^(\d+)\s*([smhd])$/.exec(value.trim());
    if (match) {
        const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "s" | "m" | "h" | "d"];
        return new Date(Date.now() - Number(match[1]) * unit * 1000).toISOString();
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`“${value}” is not a time: use 15m, 2h, 1d or an ISO date.`);
    return date.toISOString();
}
