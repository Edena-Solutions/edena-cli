import type { Document, Operation, Parameter, Schema } from "./reference.js";

const MAX_INLINE_DEPTH = 3;
/** Enough for any category; past it the rest are named so the reader knows they exist. */
const MAX_TYPES = 150;
/** Covered by the rules every prompt states, so not repeated under each write. */
const RULE_HEADERS = new Set(["idempotency-key"]);

/** `#/components/schemas/Client` → `Client`. */
export function refName(schema: Schema | undefined): string | null {
    return schema?.$ref ? (schema.$ref.split("/").pop() ?? null) : null;
}

/** The named schemas an operation reaches, rendered once each as TypeScript. */
export class TypeCollector {
    private readonly order: string[] = [];
    private readonly seen = new Set<string>();

    constructor(
        private readonly document: Document,
        private readonly exported = false,
    ) {}

    add(name: string): void {
        if (this.seen.has(name)) return;
        this.seen.add(name);
        this.order.push(name);
    }

    /** A schema as a TypeScript type, naming every reference it meets. */
    ts(schema: Schema, depth = 0): string {
        const name = refName(schema);
        if (name) {
            this.add(name);
            return name;
        }
        return this.bare(schema, depth) + (schema.nullable ? " | null" : "");
    }

    private bare(schema: Schema, depth: number): string {
        if (schema.allOf?.length) return schema.allOf.map((part) => this.ts(part, depth)).join(" & ");
        const union = schema.oneOf ?? schema.anyOf;
        if (union?.length) return union.map((part) => this.ts(part, depth)).join(" | ");
        if (schema.enum?.length) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
        switch (schema.type) {
            case "string":
                return schema.format === "binary" ? "Blob" : "string";
            case "integer":
            case "number":
                return "number";
            case "boolean":
                return "boolean";
            case "array": {
                const item = this.ts(schema.items ?? {}, depth);
                return /[|& ]/.test(item) ? `Array<${item}>` : `${item}[]`;
            }
        }
        if (schema.properties && depth < MAX_INLINE_DEPTH) {
            const required = new Set(schema.required ?? []);
            const fields = Object.entries(schema.properties).map(
                ([key, property]) => `${key}${required.has(key) ? "" : "?"}: ${this.ts(property, depth + 1)}`,
            );
            return `{ ${fields.join("; ")} }`;
        }
        if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
            return `Record<string, ${this.ts(schema.additionalProperties, depth + 1)}>`;
        }
        return schema.type === "object" || schema.additionalProperties ? "Record<string, unknown>" : "unknown";
    }

    /** Every type collected, in the order met; rendering one may meet more, so it runs to the end. */
    render(): { blocks: string[]; omitted: string[] } {
        const blocks: string[] = [];
        for (let index = 0; index < this.order.length && blocks.length < MAX_TYPES; index++) {
            blocks.push(this.block(this.order[index] as string));
        }
        return { blocks, omitted: this.order.slice(blocks.length) };
    }

    private block(name: string): string {
        const schema = this.document.components?.schemas?.[name] ?? {};
        const doc = schema.description ? `/** ${oneLine(schema.description)} */\n` : "";
        const keyword = this.exported ? "export " : "";
        if (!schema.properties) return `${doc}${keyword}type ${name} = ${this.bare(schema, 0)};`;
        const required = new Set(schema.required ?? []);
        const fields = Object.entries(schema.properties).map(([key, property]) => {
            const note = propertyNote(property);
            const comment = note ? `    /** ${note} */\n` : "";
            return `${comment}    ${key}${required.has(key) ? "" : "?"}: ${this.ts(property, 1)};`;
        });
        return `${doc}${keyword}interface ${name} {\n${fields.join("\n")}\n}`;
    }
}

/** What a field's type does not say: its description and its constraints. */
function propertyNote(schema: Schema): string {
    const constraints = [
        schema.format && schema.format !== "binary" ? schema.format : null,
        schema.minLength !== undefined ? `min ${schema.minLength}` : null,
        schema.maxLength !== undefined ? `max ${schema.maxLength}` : null,
        schema.minimum !== undefined ? `>= ${schema.minimum}` : null,
        schema.maximum !== undefined ? `<= ${schema.maximum}` : null,
    ].filter(Boolean);
    const description = schema.description ? oneLine(schema.description) : "";
    if (constraints.length === 0) return description;
    return description ? `${description} (${constraints.join(", ")})` : constraints.join(", ");
}

export function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").replace(/\*\//g, "*\\/").trim();
}

/** The parameters an operation takes, by where they go; the idempotency header is the CLI's own. */
export function parametersOf(operation: Operation) {
    const visible = (parameter: Parameter) => !(parameter.in === "header" && RULE_HEADERS.has(parameter.name.toLowerCase()));
    return {
        path: operation.parameters.filter((parameter) => parameter.in === "path"),
        query: operation.parameters.filter((parameter) => parameter.in === "query"),
        headers: operation.parameters.filter((parameter) => parameter.in === "header" && visible(parameter)),
    };
}

/** The JSON body an operation takes, when it takes one. */
export function bodySchemaOf(operation: Operation): { schema: Schema; required: boolean; mediaType: string } | null {
    const content = operation.requestBody?.content;
    if (!content) return null;
    const [mediaType, media] = Object.entries(content)[0] ?? [];
    if (!mediaType || !media?.schema) return null;
    return { schema: media.schema, required: Boolean(operation.requestBody?.required), mediaType };
}

/** The schema a `$ref` points to; any other is answered as it is. */
export function resolve(document: Document, schema: Schema | undefined): Schema {
    if (!schema) return {};
    const name = refName(schema);
    return name ? (document.components?.schemas?.[name] ?? {}) : schema;
}

/** One operation, as a section of a prompt or of `docs show`. */
export function operationMarkdown(operation: Operation, types: TypeCollector): string[] {
    const { path, query, headers } = parametersOf(operation);
    const lines = [`### ${operation.method} ${operation.path}`, "", `\`edena ${operation.command}\` (\`${operation.id}\`): ${operation.summary}`, ""];
    for (const [label, group] of [
        ["Path parameters", path],
        ["Query parameters", query],
        ["Headers", headers],
    ] as const) {
        if (group.length === 0) continue;
        lines.push(`${label}:`);
        for (const parameter of group) {
            const type = parameter.schema ? types.ts(parameter.schema) : "string";
            const description = parameter.description ? `: ${oneLine(parameter.description)}` : "";
            lines.push(`- \`${parameter.name}\` (\`${type}\`${parameter.required ? ", required" : ""})${description}`);
        }
        lines.push("");
    }
    const body = bodySchemaOf(operation);
    if (body) {
        const media = body.mediaType === "application/json" ? "" : `, ${body.mediaType}`;
        lines.push(`Body${media}${body.required ? ", required" : ""}: \`${types.ts(body.schema)}\``, "");
    }
    const responses = Object.entries(operation.responses);
    for (const [status, response] of responses.filter(([code]) => code.startsWith("2"))) {
        const json = response.content?.["application/json"]?.schema;
        const other = response.content ? Object.keys(response.content)[0] : undefined;
        lines.push(`Response ${status}: ${json ? `\`${types.ts(json)}\`` : other ? `file (${other})` : "no body"}`);
    }
    const errors = responses.filter(([code]) => !code.startsWith("2")).map(([code]) => code);
    if (errors.length > 0) lines.push(`Errors: ${errors.join(", ")} (\`ErrorResponse\`)`);
    lines.push("");
    return lines;
}

const RULES = (apiUrl: string) => [
    `Base URL: \`${apiUrl}\`.`,
    "Authentication: header `Authorization: Bearer <key>`, with the key in the `EDENA_API_KEY` environment variable. Never put it in code that runs in a browser: a key sent from a web page answers 403 `auth.api_key_in_browser`. When an app acts on behalf of its users, request end-user tokens (`POST /end-user-tokens`) from your server.",
    "Writes (POST, PUT, PATCH, DELETE): send the `Idempotency-Key` header with a UUID per operation and reuse it when retrying; for 24 hours the same key answers what it answered the first time.",
    "Errors: every one answers `ErrorResponse`. Decide on `key`, which is stable, never on `message`, and log `requestId`. A 400 names the fields that failed in `details.fields`.",
    "Limits per minute: 300 requests per key and 1,200 for all of the organization's keys. Read `X-RateLimit-Remaining`; on a 429, wait the seconds in `Retry-After` and retry (`details.scope` says which limit was reached).",
    "Paginated lists take `page` and `pageSize` and answer `{ data, meta: { total, page, pageSize, pages } }`.",
    "To learn about changes without polling, use webhooks (set up in the developer console) or `GET /webhook-events`.",
];

const DELIVER = [
    "One function per operation, named after its `operationId` in camelCase, taking its path parameters, query parameters and body, and returning the response with its type.",
    "The types of the “Types” section, as they are.",
    "A shared function for every request: authentication, `Idempotency-Key` on writes, retries on 429 and 5xx, and a typed error with `statusCode`, `key` and `requestId`.",
    "An example of each function in use.",
    "Write it in my project's language and style; if there is none, in TypeScript.",
];

/**
 * A prompt for a coding agent to implement a whole category: how the API works, every operation, and
 * every type they use, once. The same one the console's «Copy prompt» writes, in English.
 */
export function categoryPrompt(document: Document, group: { category: string; description: string; operations: Operation[] }, apiUrl: string): string {
    const types = new TypeCollector(document);
    const sections = group.operations.flatMap((operation) => operationMarkdown(operation, types));
    if (document.components?.schemas?.ErrorResponse) types.add("ErrorResponse");
    const lines = [
        `# Implement the integration with “${group.category}” of the Edena API`,
        "",
        "You are a senior developer. Implement in my project the integration with every operation of this category of the Edena API, the management platform for schools. Use only what this document describes: do not invent endpoints, fields or values. If something is unclear, ask me before assuming it.",
        "",
        "## How the API works",
        "",
        ...RULES(apiUrl).map((rule) => `- ${rule}`),
        "",
    ];
    if (group.description) lines.push(`## The category: ${group.category}`, "", group.description, "");
    lines.push(`## Operations (${group.operations.length})`, "", ...sections);
    const { blocks, omitted } = types.render();
    if (blocks.length > 0) lines.push("## Types", "", "```ts", blocks.join("\n\n"), "```", "");
    if (omitted.length > 0) lines.push(`Other types they refer to, left out for length: ${omitted.join(", ")}.`, "");
    lines.push("## What to deliver", "", ...DELIVER.map((item) => `- ${item}`));
    return `${lines.join("\n").trimEnd()}\n`;
}
