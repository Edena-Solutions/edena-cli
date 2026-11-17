import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { type ParsedArgs, flag, hasFlag } from "../args.js";
import { resolveSession, type Session } from "../config.js";
import { EXIT, NotSignedInError, UsageError } from "../errors.js";
import { apiRequest, type ApiResponse } from "../http.js";
import { bold, dim, printHuman, printJson, wantsJson } from "../output.js";
import type { Group, Operation, Parameter, Reference, Schema } from "../reference.js";
import { TypeCollector, bodySchemaOf, oneLine, parametersOf, resolve } from "../schema.js";

/** Flags every command takes, which are never an operation's own. */
const GLOBAL_FLAGS = new Set(["json", "yes", "all", "help", "profile", "data", "output", "idempotencyKey", "apiUrl"]);
const MAX_PAGES = 200;

/** A flag's text as the value its schema asks for: a number, a boolean, a list, an object. */
function coerce(values: string[], schema: Schema | undefined, document: Reference["document"]): unknown {
    const target = resolve(document, schema);
    const one = values[values.length - 1] as string;
    switch (target.type) {
        case "integer":
        case "number": {
            const number = Number(one);
            if (Number.isNaN(number)) throw new UsageError(`“${one}” is not a number.`);
            return number;
        }
        case "boolean":
            return one === "true" || one === "1" || one === "yes";
        case "array":
            return values.flatMap((value) => (value.trim().startsWith("[") ? (JSON.parse(value) as unknown[]) : value.split(",")));
        case "object":
            return JSON.parse(one) as unknown;
        default:
            return one;
    }
}

async function readData(raw: string): Promise<unknown> {
    if (raw === "-") {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    if (raw.startsWith("@")) return JSON.parse(await readFile(raw.slice(1), "utf8"));
    return JSON.parse(raw);
}

/** A write needs the person's yes; without anyone at the keyboard (an agent, a script) it needs `--yes`. */
async function confirm(operation: Operation, session: Session, args: ParsedArgs): Promise<boolean> {
    if (hasFlag(args, "yes")) return true;
    const where = session.profile ? `${session.profile.organization.name} (${session.profile.organization.environment})` : session.apiUrl;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new UsageError(`edena ${operation.command} changes data in ${where}.`, "Run it again with --yes once it is confirmed.");
    }
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await readline.question(`${operation.method} ${operation.path} in ${bold(where)}. Go ahead? [y/N] `);
    readline.close();
    return /^y(es)?$/i.test(answer.trim());
}

/** The request an operation makes from the words and flags given: path, query, headers and body. */
export async function buildRequest(reference: Reference, operation: Operation, args: ParsedArgs) {
    const { path: pathParams, query: queryParams, headers: headerParams } = parametersOf(operation);
    const positionals = args.positionals.slice(2);
    const used = new Set<string>();

    let path = operation.path;
    for (const parameter of pathParams) {
        const value = flag(args, parameter.name) ?? positionals.shift();
        if (value === undefined) throw new UsageError(`Missing <${parameter.name}>.`, usageLine(operation));
        used.add(parameter.name);
        path = path.replace(`{${parameter.name}}`, encodeURIComponent(value));
    }
    if (positionals.length > 0) throw new UsageError(`Unexpected “${positionals.join(" ")}”.`, usageLine(operation));

    const query: Record<string, string[]> = {};
    const headers: Record<string, string> = {};
    for (const parameter of [...queryParams, ...headerParams]) {
        const values = args.flags.get(parameter.name);
        if (!values) {
            if (parameter.required && parameter.in === "query") throw new UsageError(`Missing --${parameter.name}.`, usageLine(operation));
            continue;
        }
        used.add(parameter.name);
        if (parameter.in === "query") query[parameter.name] = values.flatMap((value) => value.split(","));
        else headers[parameter.name] = values[values.length - 1] as string;
    }

    const body = bodySchemaOf(operation);
    let data: Record<string, unknown> | unknown = undefined;
    const raw = flag(args, "data");
    if (raw !== undefined) data = await readData(raw);
    if (body) {
        const properties = resolve(reference.document, body.schema).properties ?? {};
        for (const [name, values] of args.flags) {
            if (GLOBAL_FLAGS.has(name) || used.has(name) || !(name in properties)) continue;
            data = { ...(typeof data === "object" && data !== null ? data : {}), [name]: coerce(values, properties[name], reference.document) };
            used.add(name);
        }
    }
    const unknown = [...args.flags.keys()].filter((name) => !GLOBAL_FLAGS.has(name) && !used.has(name));
    if (unknown.length > 0) throw new UsageError(`Unknown flag ${unknown.map((name) => `--${name}`).join(", ")}.`, `Run edena ${operation.command} --help.`);

    return { path, query, headers, body: data };
}

/** Runs an operation: builds the request, asks before a write, follows pages with --all, prints the answer. */
export async function runOperation(reference: Reference, operation: Operation, args: ParsedArgs): Promise<number> {
    const session = await resolveSession(flag(args, "profile"));
    if (!session.apiKey) throw new NotSignedInError();
    const request = await buildRequest(reference, operation, args);
    if (operation.method !== "GET" && !(await confirm(operation, session, args))) {
        process.stderr.write("Nothing was changed.\n");
        return EXIT.ok;
    }
    const call = (page?: number) =>
        apiRequest({
            apiUrl: session.apiUrl,
            apiKey: session.apiKey,
            method: operation.method,
            path: request.path,
            query: page ? { ...request.query, page: String(page) } : request.query,
            body: request.body,
            headers: request.headers,
            idempotencyKey: flag(args, "idempotencyKey"),
        });

    let response = await call();
    if (hasFlag(args, "all") && response.kind === "json") response = await allPages(response, call);
    return print(response, args);
}

/** Every page of a paginated list, one after another, as one list. */
async function allPages(first: Extract<ApiResponse, { kind: "json" }>, call: (page: number) => Promise<ApiResponse>): Promise<ApiResponse> {
    const page = first.data as { data?: unknown[]; meta?: { pages?: number; total?: number } };
    if (!Array.isArray(page.data) || typeof page.meta?.pages !== "number") return first;
    const rows = [...page.data];
    for (let next = 2; next <= Math.min(page.meta.pages, MAX_PAGES); next++) {
        const response = await call(next);
        if (response.kind === "json") rows.push(...(((response.data as { data?: unknown[] }).data) ?? []));
    }
    return { ...first, data: { data: rows, meta: { ...page.meta, page: 1, pages: 1, pageSize: rows.length, total: page.meta.total ?? rows.length } } };
}

async function print(response: ApiResponse, args: ParsedArgs): Promise<number> {
    if (response.kind === "empty") {
        if (!wantsJson(hasFlag(args, "json"))) process.stdout.write(dim("Done.\n"));
        return EXIT.ok;
    }
    if (response.kind === "file") {
        const output = flag(args, "output");
        if (output) {
            await writeFile(output, response.data);
            process.stderr.write(`Saved ${response.data.length} bytes to ${output}.\n`);
        } else if (process.stdout.isTTY) {
            throw new UsageError(`The answer is a file (${response.contentType}).`, "Save it with --output <file>.");
        } else {
            process.stdout.write(response.data);
        }
        return EXIT.ok;
    }
    if (wantsJson(hasFlag(args, "json"))) printJson(response.data);
    else printHuman(response.data);
    return EXIT.ok;
}

function usageLine(operation: Operation): string {
    const { path } = parametersOf(operation);
    return `Usage: edena ${operation.command}${path.map((parameter) => ` <${parameter.name}>`).join("")} [flags]`;
}

function describe(parameter: Parameter, types: TypeCollector): string {
    const type = parameter.schema ? types.ts(parameter.schema) : "string";
    return `${type}${parameter.required ? ", required" : ""}${parameter.description ? `. ${oneLine(parameter.description)}` : ""}`;
}

/** `edena students list --help`: what it does, what it takes and what it answers. */
export function operationHelp(reference: Reference, operation: Operation): string {
    const types = new TypeCollector(reference.document);
    const { path, query, headers } = parametersOf(operation);
    const lines = [bold(`edena ${operation.command}`), operation.summary, "", dim(`${operation.method} ${operation.path}  (${operation.id})`), "", usageLine(operation)];
    if (path.length > 0) lines.push("", "Arguments:", ...path.map((parameter) => `  <${parameter.name}>  ${describe(parameter, types)}`));
    if (query.length + headers.length > 0) lines.push("", "Flags:", ...[...query, ...headers].map((parameter) => `  --${parameter.name}  ${describe(parameter, types)}`));
    const body = bodySchemaOf(operation);
    if (body) {
        const schema = resolve(reference.document, body.schema);
        const required = new Set(schema.required ?? []);
        lines.push("", `Body: --data '<json>' | --data @file.json | --data -  (${types.ts(body.schema)}), or a flag per field:`);
        for (const [name, property] of Object.entries(schema.properties ?? {})) {
            lines.push(`  --${name}  ${types.ts(property)}${required.has(name) ? ", required" : ""}${property.description ? `. ${oneLine(property.description)}` : ""}`);
        }
    }
    const success = Object.entries(operation.responses).find(([status]) => status.startsWith("2"));
    const json = success?.[1].content?.["application/json"]?.schema;
    if (success) lines.push("", `Answers ${success[0]}: ${json ? types.ts(json) : success[1].content ? "a file (save it with --output)" : "no body"}`);
    lines.push(
        "",
        dim("Also: --json  --yes (writes without asking)  --all (every page)  --profile <name>  --output <file>"),
        dim(`Types: edena docs show ${operation.command}`),
    );
    return `${lines.join("\n")}\n`;
}

/** `edena students`: the actions of a category. */
export function groupHelp(group: Group): string {
    const width = Math.max(...group.operations.map((operation) => operation.action.length));
    return [
        bold(`edena ${group.name}`) + dim(`  ${group.category}`),
        group.description,
        "",
        ...group.operations.map((operation) => `  ${operation.action.padEnd(width)}  ${operation.summary}`),
        "",
        dim(`Run edena ${group.name} <action> --help for what one takes.`),
        "",
    ].join("\n");
}
