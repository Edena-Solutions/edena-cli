import { type ParsedArgs, flag, hasFlag } from "../args.js";
import { resolveSession } from "../config.js";
import { EXIT, NotSignedInError } from "../errors.js";
import { apiRequest } from "../http.js";
import { bold, dim, red, sanitizeForTerminal as safe, wantsJson } from "../output.js";
import { followStream, sinceOf } from "../sse.js";

interface RequestLog {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
    requestId: string;
    createdAt: string;
    apiKey: { name: string; prefix: string };
}

/**
 * `edena logs`: the organization's API requests as they happen, the way the console's Requests shows
 * them. `--mine` keeps this terminal's key; `--since 15m` shows the last ones first.
 */
export async function logs(args: ParsedArgs): Promise<number> {
    const session = await resolveSession(flag(args, "profile"));
    if (!session.apiKey) throw new NotSignedInError();
    const url = new URL(`${session.apiUrl}/cli/logs`);
    if (hasFlag(args, "mine")) {
        const response = await apiRequest({ apiUrl: session.apiUrl, apiKey: session.apiKey, method: "GET", path: "/cli/whoami" });
        if (response.kind === "json") url.searchParams.set("apiKeyId", (response.data as { key: { id: string } }).key.id);
    }
    const since = flag(args, "since");
    if (since) url.searchParams.set("since", sinceOf(since));
    const json = wantsJson(hasFlag(args, "json"));

    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    await followStream({
        url: url.toString(),
        apiKey: session.apiKey,
        signal: controller.signal,
        onOpen: (reconnected) => {
            if (!reconnected && !json) process.stderr.write(dim("Following the API's requests. Ctrl+C to stop.\n\n"));
        },
        onMessage: (message) => {
            if (message.event !== "request") return;
            if (json) {
                process.stdout.write(`${message.data}\n`);
                return;
            }
            const log = JSON.parse(message.data) as RequestLog;
            const status = log.statusCode >= 400 ? red(String(log.statusCode)) : String(log.statusCode);
            const at = new Date(log.createdAt).toTimeString().slice(0, 8);
            process.stdout.write(
                `${dim(at)}  ${bold(safe(log.method).padEnd(6))} ${status}  ${String(log.durationMs).padStart(5)} ms  ${safe(log.route)}  ${dim(`${safe(log.apiKey.name)} · ${safe(log.requestId)}`)}\n`,
            );
        },
    });
    return EXIT.ok;
}
