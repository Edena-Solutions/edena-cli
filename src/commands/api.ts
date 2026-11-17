import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { type ParsedArgs, flag, hasFlag } from "../args.js";
import { resolveSession } from "../config.js";
import { EXIT, NotSignedInError, UsageError } from "../errors.js";
import { apiRequest, type HttpMethod } from "../http.js";
import { printHuman, printJson, wantsJson } from "../output.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * `edena api GET /clients --query status=active`: any request, for what a generated command does not
 * cover the way you want. A write asks first, as any command does.
 */
export async function api(args: ParsedArgs): Promise<number> {
    const [, rawMethod, path] = args.positionals;
    const method = rawMethod?.toUpperCase();
    if (!method || !METHODS.has(method) || !path?.startsWith("/")) {
        throw new UsageError("Usage: edena api <METHOD> </path> [--query name=value]... [--data '<json>' | @file | -]");
    }
    const session = await resolveSession(flag(args, "profile"));
    if (!session.apiKey) throw new NotSignedInError();
    if (method !== "GET" && !hasFlag(args, "yes")) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new UsageError(`${method} ${path} changes data.`, "Run it again with --yes once it is confirmed.");
        }
        const readline = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await readline.question(`${method} ${path}. Go ahead? [y/N] `);
        readline.close();
        if (!/^y(es)?$/i.test(answer.trim())) {
            process.stderr.write("Nothing was changed.\n");
            return EXIT.ok;
        }
    }
    const query: Record<string, string[]> = {};
    for (const pair of args.flags.get("query") ?? []) {
        const equals = pair.indexOf("=");
        if (equals < 1) throw new UsageError(`--query takes name=value, not “${pair}”.`);
        const name = pair.slice(0, equals);
        query[name] = [...(query[name] ?? []), pair.slice(equals + 1)];
    }
    const raw = flag(args, "data");
    const body = raw === undefined ? undefined : JSON.parse(raw.startsWith("@") ? await readFile(raw.slice(1), "utf8") : raw);
    const response = await apiRequest({ apiUrl: session.apiUrl, apiKey: session.apiKey, method: method as HttpMethod, path, query, body });
    if (response.kind === "json") {
        if (wantsJson(hasFlag(args, "json"))) printJson(response.data);
        else printHuman(response.data);
    } else if (response.kind === "file") {
        process.stdout.write(response.data);
    }
    return EXIT.ok;
}
