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
        const entries = Object.entries(value as Record<string, unknown>);
        const width = Math.max(...entries.map(([key]) => key.length), 0);
        for (const [key, field] of entries) process.stdout.write(`${dim(key.padEnd(width))}  ${cell(field, 120)}\n`);
        return;
    }
    process.stdout.write(`${String(value)}\n`);
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
        for (const row of rows) process.stdout.write(`${String(row)}\n`);
        return;
    }
    const scalar = (key: string) => objects.some((row) => row[key] !== null && row[key] !== undefined && typeof row[key] !== "object");
    const keys = [...new Set(objects.flatMap((row) => Object.keys(row)))].filter(scalar);
    const columns = [...PREFERRED.filter((key) => keys.includes(key)), ...keys.filter((key) => !PREFERRED.includes(key))].slice(0, MAX_COLUMNS);
    const limit = Math.max(12, Math.floor((process.stdout.columns ?? 120) / columns.length) - 2);
    const cells = objects.map((row) => columns.map((key) => cell(row[key], limit)));
    const widths = columns.map((key, index) => Math.max(key.length, ...cells.map((row) => (row[index] as string).length)));
    process.stdout.write(`${bold(columns.map((key, index) => key.padEnd(widths[index] as number)).join("  "))}\n`);
    for (const row of cells) process.stdout.write(`${row.map((text, index) => text.padEnd(widths[index] as number)).join("  ")}\n`);
}

function cell(value: unknown, limit: number): string {
    const text = value === null || value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
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
        process.stderr.write(`${red("Error")} ${error.message} (${error.key}${error.status ? `, ${error.status}` : ""})\n`);
        if (hint) process.stderr.write(`${hint}\n`);
        if (error.requestId) process.stderr.write(`Request id: ${error.requestId}\n`);
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${red("Error")} ${message}\n`);
    if ((error instanceof UsageError || error instanceof NotSignedInError) && error.hint) process.stderr.write(`${error.hint}\n`);
}
