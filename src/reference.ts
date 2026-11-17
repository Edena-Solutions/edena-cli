import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "./config.js";
import type { HttpMethod } from "./http.js";
import { VERSION } from "./version.js";

/** The part of OpenAPI 3 the CLI reads. */
export interface Schema {
    $ref?: string;
    type?: string;
    format?: string;
    description?: string;
    enum?: unknown[];
    items?: Schema;
    properties?: Record<string, Schema>;
    required?: string[];
    nullable?: boolean;
    oneOf?: Schema[];
    anyOf?: Schema[];
    allOf?: Schema[];
    additionalProperties?: boolean | Schema;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
}

export interface Parameter {
    name: string;
    in: "path" | "query" | "header" | "cookie";
    required?: boolean;
    description?: string;
    schema?: Schema;
}

interface RawOperation {
    operationId?: string;
    summary?: string;
    tags?: string[];
    parameters?: Parameter[];
    requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
    responses?: Record<string, { description?: string; content?: Record<string, { schema?: Schema }> }>;
    "x-cli"?: string;
}

export interface Document {
    info: { title: string; version: string; description?: string };
    tags?: { name: string; description?: string; "x-displayName"?: string }[];
    paths: Record<string, Partial<Record<Lowercase<HttpMethod>, RawOperation>>>;
    components?: { schemas?: Record<string, Schema> };
}

export interface Operation {
    id: string;
    method: HttpMethod;
    path: string;
    /** The category's stable name (`Clients`). */
    tag: string;
    /** How the category reads (`Students`). */
    category: string;
    summary: string;
    /** `students list`. */
    command: string;
    group: string;
    action: string;
    parameters: Parameter[];
    requestBody: RawOperation["requestBody"];
    responses: NonNullable<RawOperation["responses"]>;
}

export interface Group {
    name: string;
    category: string;
    description: string;
    operations: Operation[];
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
/** The reference changes only with a deploy of the API; a day is fresh enough, and `docs refresh` forces it. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `García` → `garcia`: search ignores case and accents, as the console's does. */
export function fold(text: string): string {
    return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** The API's operations as commands, and the ways to find one. */
export class Reference {
    readonly operations: Operation[] = [];
    readonly groups = new Map<string, Group>();
    private readonly byCommand = new Map<string, Operation>();
    private readonly byId = new Map<string, Operation>();

    constructor(readonly document: Document) {
        const tags = new Map((document.tags ?? []).map((tag) => [tag.name, tag]));
        for (const [path, item] of Object.entries(document.paths)) {
            for (const method of METHODS) {
                const raw = item[method];
                if (!raw?.operationId || !raw["x-cli"]) continue;
                const tag = raw.tags?.[0] ?? "";
                const [group = "", action = ""] = raw["x-cli"].split(" ");
                const operation: Operation = {
                    id: raw.operationId,
                    method: method.toUpperCase() as HttpMethod,
                    path,
                    tag,
                    category: tags.get(tag)?.["x-displayName"] ?? tag,
                    summary: (raw.summary ?? "").trim(),
                    command: raw["x-cli"],
                    group,
                    action,
                    parameters: raw.parameters ?? [],
                    requestBody: raw.requestBody,
                    responses: raw.responses ?? {},
                };
                this.operations.push(operation);
                this.byCommand.set(operation.command, operation);
                this.byId.set(operation.id, operation);
                let entry = this.groups.get(group);
                if (!entry) {
                    entry = { name: group, category: operation.category, description: tags.get(tag)?.description ?? "", operations: [] };
                    this.groups.set(group, entry);
                }
                entry.operations.push(operation);
            }
        }
        for (const entry of this.groups.values()) entry.operations.sort((a, b) => a.action.localeCompare(b.action));
    }

    /** By its command (`students list`) or its operation id (`clients_list`). */
    find(name: string): Operation | null {
        return this.byCommand.get(name.trim().replace(/\s+/g, " ")) ?? this.byId.get(name.trim()) ?? null;
    }

    /**
     * What a query finds, best first: the operations matching the most words, a word in the command or
     * the summary counting more than one in the path. Words like "the" or "without" are left out and
     * plurals match their singular, since an agent searches with what the person said.
     */
    search(query: string, limit = 20): Operation[] {
        const words = fold(query)
            .split(/[^a-z0-9-]+/)
            .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
            .map(stem);
        if (words.length === 0) return [];
        const needed = Math.max(1, Math.ceil(words.length / 2));
        const scored: { operation: Operation; matched: number; score: number }[] = [];
        for (const operation of this.operations) {
            const fields = {
                command: stems(operation.command),
                summary: stems(operation.summary),
                category: stems(`${operation.category} ${this.groups.get(operation.group)?.description ?? ""}`),
                other: stems(`${operation.id} ${operation.path} ${operation.method}`),
            };
            const commandWords = new Set(fields.command.split(" "));
            let matched = 0;
            let score = 0;
            for (const word of words) {
                const hit =
                    (commandWords.has(word) ? 3 : 0) +
                    (fields.command.includes(word) ? 4 : 0) +
                    (fields.summary.includes(word) ? 3 : 0) +
                    (fields.category.includes(word) ? 2 : 0) +
                    (fields.other.includes(word) ? 1 : 0);
                if (hit > 0) matched++;
                score += hit;
            }
            if (matched >= needed) scored.push({ operation, matched, score });
        }
        return scored
            .sort(
                (a, b) =>
                    b.matched - a.matched ||
                    Number(isDeprecated(a.operation)) - Number(isDeprecated(b.operation)) ||
                    b.score - a.score ||
                    a.operation.command.split(/[ -]/).length - b.operation.command.split(/[ -]/).length ||
                    a.operation.command.localeCompare(b.operation.command),
            )
            .slice(0, limit)
            .map((entry) => entry.operation);
    }
}

/** Kept for old apps: listed after what replaces it. */
const isDeprecated = (operation: Operation) => operation.summary.startsWith("Deprecated");

/** Words that say nothing about which operation is meant. */
const STOP_WORDS = new Set([
    "a", "an", "the", "of", "for", "to", "in", "on", "at", "by", "with", "without", "and", "or", "not", "no",
    "my", "our", "their", "all", "any", "every", "that", "which", "who", "is", "are", "have", "has", "how", "many", "much",
]);

/** A text as the stems of its words, so `families` finds `family` and the other way round. */
function stems(text: string): string {
    return fold(text.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .map(stem)
        .join(" ");
}

/** `students` → `student`, `classes` → `class`: a plural finds its singular, and the other way round. */
function stem(word: string): string {
    if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
    if (word.length > 4 && /(ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
    return word;
}

interface CacheMeta {
    etag: string | null;
    apiUrl: string;
}

/**
 * The API reference, from the cache when it is fresh, else from `GET /openapi.json` (public, no key
 * needed), asking with the cached ETag so an unchanged one costs nothing. Offline, a stale copy still
 * serves; `EDENA_REFERENCE_FILE` reads one from disk instead.
 */
export async function loadReference(apiUrl: string, options: { refresh?: boolean } = {}): Promise<Reference> {
    if (process.env.EDENA_REFERENCE_FILE) {
        return new Reference(JSON.parse(await readFile(process.env.EDENA_REFERENCE_FILE, "utf8")) as Document);
    }
    const dir = cacheDir();
    const file = join(dir, "openapi.json");
    const metaFile = join(dir, "openapi.meta.json");
    const cached = await readCache(file, metaFile, apiUrl);
    if (cached && !options.refresh && Date.now() - cached.mtime < MAX_AGE_MS) return new Reference(cached.document);

    try {
        const response = await fetch(`${apiUrl}/openapi.json?lang=en`, {
            headers: { Accept: "application/json", "User-Agent": `edena-cli/${VERSION}`, ...(cached?.meta.etag && { "If-None-Match": cached.meta.etag }) },
        });
        if (response.status === 304 && cached) {
            await writeFile(file, JSON.stringify(cached.document));
            return new Reference(cached.document);
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const document = (await response.json()) as Document;
        await mkdir(dir, { recursive: true });
        await writeFile(file, JSON.stringify(document));
        await writeFile(metaFile, JSON.stringify({ etag: response.headers.get("etag"), apiUrl } satisfies CacheMeta));
        return new Reference(document);
    } catch (error) {
        if (cached) return new Reference(cached.document);
        throw new Error(`Could not load the API reference from ${apiUrl}: ${(error as Error).message}`);
    }
}

async function readCache(file: string, metaFile: string, apiUrl: string) {
    try {
        const meta = JSON.parse(await readFile(metaFile, "utf8")) as CacheMeta;
        if (meta.apiUrl !== apiUrl) return null;
        const [raw, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
        return { document: JSON.parse(raw) as Document, meta, mtime: info.mtimeMs };
    } catch {
        return null;
    }
}
