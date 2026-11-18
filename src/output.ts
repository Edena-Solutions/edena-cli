import { ApiError, NotSignedInError, UsageError } from "./errors.js";

/** JSON when asked for, or when the output goes to another program (an agent, a pipe). */
export function wantsJson(json: boolean): boolean {
    return json || !process.stdout.isTTY;
}

const color = (code: number) => (text: string) =>
    process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text;
export const dim = color(2);
export const bold = color(1);
export const red = (text: string) => (process.stderr.isTTY && !process.env.NO_COLOR ? `\u001b[31m${text}\u001b[0m` : text);

/** Line breaks and tabs, which a single line of output turns into spaces. */
const BREAKS = /\r\n|[\t\n\r\u2028\u2029]/g;
/**
 * C0 and C1 control characters (ESC, BEL…) and Unicode's direction controls (embeddings, overrides,
 * isolates): what lets text move the cursor, erase lines, retitle the window, write to the clipboard or
 * show itself in another order than it is.
 */
const CONTROLS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]", "g");

/**
 * Text that came from the API, made safe to print to a terminal. A family can put escape sequences in
 * their own name, and a member of staff listing them would have their terminal run them: change its
 * title, erase lines to hide what is there, or, in some terminals, write to the clipboard. Line breaks
 * and tabs become a space; every other control character becomes `�`, so tampering shows. Accents,
 * emoji and every other character are left as they are. Never used on `--json`, which
 * `JSON.stringify` already escapes.
 */
export function sanitizeForTerminal(text: string): string {
    return text.replace(BREAKS, " ").replace(CONTROLS, "\uFFFD");
}

export function printJson(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Columns worth reading first in a table, when a row has them. */
const PREFERRED = ["id", "name", "surname1", "title", "email", "status", "role", "date", "total", "amount", "createdAt"];
const MAX_COLUMNS = 6;

/** An answer for a person: a table for a list, field by field for a record. */
export function printHuman(value: unknown): void {
    if (value === null || value === undefined) return;
    const rows = Array.isArray(value) ? value : isPage(value) ? value.data : null;
    if (rows) {
        printTable(rows);
        if (isPage(value)) process.stdout.write(dim(`page ${value.meta.page} of ${value.meta.pages} · ${value.meta.total} in total\n`));
        return;
    }
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).map(([key, field]) => [sanitizeForTerminal(key), field] as const);
        const width = Math.max(...entries.map(([key]) => key.length), 0);
        for (const [key, field] of entries) process.stdout.write(`${dim(key.padEnd(width))}  ${cell(field, 120)}\n`);
        return;
    }
    process.stdout.write(`${sanitizeForTerminal(String(value))}\n`);
}

function isPage(value: unknown): value is { data: unknown[]; meta: { page: number; pages: number; total: number } } {
    return (
        typeof value === "object" &&
        value !== null &&
        Array.isArray((value as { data?: unknown }).data) &&
        typeof (value as { meta?: { total?: unknown } }).meta?.total === "number"
    );
}

function printTable(rows: unknown[]): void {
    if (rows.length === 0) {
        process.stdout.write(dim("Nothing.\n"));
        return;
    }
    const objects = rows.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
    if (objects.length === 0) {
        for (const row of rows) process.stdout.write(`${sanitizeForTerminal(String(row))}\n`);
        return;
    }
    const scalar = (key: string) => objects.some((row) => row[key] !== null && row[key] !== undefined && typeof row[key] !== "object");
    const keys = [...new Set(objects.flatMap((row) => Object.keys(row)))].filter(scalar);
    const columns = [...PREFERRED.filter((key) => keys.includes(key)), ...keys.filter((key) => !PREFERRED.includes(key))].slice(0, MAX_COLUMNS);
    const headers = columns.map(sanitizeForTerminal);
    const limit = Math.max(12, Math.floor((process.stdout.columns ?? 120) / columns.length) - 2);
    const cells = objects.map((row) => columns.map((key) => cell(row[key], limit)));
    // Widths are measured on the text as printed: after it was made safe, before padding.
    const widths = headers.map((header, index) => Math.max(header.length, ...cells.map((row) => (row[index] as string).length)));
    process.stdout.write(`${bold(headers.map((header, index) => header.padEnd(widths[index] as number)).join("  "))}\n`);
    for (const row of cells) process.stdout.write(`${row.map((text, index) => text.padEnd(widths[index] as number)).join("  ")}\n`);
}

/** One value as a table shows it: made safe first, then cut to its column. */
function cell(value: unknown, limit: number): string {
    const raw = value === null || value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
    const text = sanitizeForTerminal(raw);
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** An error for whoever reads it: the message, and for the API's errors their key and request id. */
export function printError(error: unknown, json: boolean): void {
    // A CLI key expires, or is revoked from the console: signing in again makes another.
    const hint = error instanceof ApiError && error.key === "auth.api_key_invalid" ? "Run edena login to sign in again." : null;
    if (wantsJson(json) && error instanceof ApiError) {
        process.stderr.write(
            `${JSON.stringify({ error: { status: error.status, key: error.key, message: error.message, requestId: error.requestId, details: error.details, ...(hint && { hint }) } })}\n`,
        );
        return;
    }
    if (error instanceof ApiError) {
        const safe = sanitizeForTerminal;
        process.stderr.write(`${red("Error")} ${safe(error.message)} (${safe(error.key)}${error.status ? `, ${error.status}` : ""})\n`);
        if (hint) process.stderr.write(`${hint}\n`);
        if (error.requestId) process.stderr.write(`Request id: ${safe(error.requestId)}\n`);
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${red("Error")} ${sanitizeForTerminal(message)}\n`);
    if ((error instanceof UsageError || error instanceof NotSignedInError) && error.hint) process.stderr.write(`${error.hint}\n`);
}
