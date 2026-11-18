import { spawn } from "node:child_process";
import { type ParsedArgs, flag } from "../args.js";
import { resolveSession } from "../config.js";
import { EXIT, NotSignedInError, UsageError } from "../errors.js";
import { apiRequest } from "../http.js";
import { sanitizeForTerminal } from "../output.js";
import { loadReference } from "../reference.js";

const SECTIONS = ["overview", "keys", "webhooks", "environment", "docs", "requests", "team"];

export function openUrl(url: string): void {
    // The address comes from the API. Only a web page is opened, and on Windows without `cmd`, whose
    // parsing would run whatever follows an `&` in it.
    if (!isWebUrl(url)) return;
    const [command, args] =
        process.platform === "darwin"
            ? ["open", [url]]
            : process.platform === "win32"
              ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
              : ["xdg-open", [url]];
    try {
        spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
    } catch {
        // Nowhere to open it: the printed link is enough.
    }
}

/** Whether it is an http(s) address: nothing else is handed to the system to open. */
export function isWebUrl(url: string): boolean {
    try {
        const { protocol } = new URL(url);
        return protocol === "https:" || protocol === "http:";
    } catch {
        return false;
    }
}

/**
 * `edena open [section]`: the organization's developer console in the browser. `edena open docs
 * students list` opens that operation in the reference.
 */
export async function open(args: ParsedArgs): Promise<number> {
    const session = await resolveSession(flag(args, "profile"));
    if (!session.apiKey) throw new NotSignedInError();
    const [, section = "overview", ...rest] = args.positionals;
    if (!SECTIONS.includes(section)) throw new UsageError(`No section “${section}”.`, `Sections: ${SECTIONS.join(", ")}.`);
    const response = await apiRequest({ apiUrl: session.apiUrl, apiKey: session.apiKey, method: "GET", path: "/cli/whoami" });
    const consoleUrl = response.kind === "json" ? (response.data as { consoleUrl?: string }).consoleUrl : undefined;
    if (!consoleUrl) throw new Error("The API did not say where its console is.");
    let url = `${consoleUrl}/${section}`;
    if (section === "docs" && rest.length > 0) {
        const operation = (await loadReference(session.apiUrl)).find(rest.join(" "));
        if (!operation) throw new UsageError(`No operation “${rest.join(" ")}”.`);
        url += `?op=${encodeURIComponent(operation.id)}`;
    }
    process.stdout.write(`${sanitizeForTerminal(url)}\n`);
    if (process.stdout.isTTY) openUrl(url);
    return EXIT.ok;
}
