#!/usr/bin/env node
import { type ParsedArgs, flag, hasFlag, parseArgs } from "./args.js";
import { api } from "./commands/api.js";
import { login, logout, profiles, use, whoami } from "./commands/auth.js";
import { categories, docsRefresh, docsSearch, docsShow, prompt, types } from "./commands/docs.js";
import { listen, trigger } from "./commands/listen.js";
import { logs } from "./commands/logs.js";
import { groupHelp, operationHelp, runOperation } from "./commands/operation.js";
import { open } from "./commands/open.js";
import { skillInstall, skillShow, skillUninstall } from "./commands/skill.js";
import { resolveSession } from "./config.js";
import { EXIT, UsageError } from "./errors.js";
import { bold, dim, printError } from "./output.js";
import { loadReference } from "./reference.js";
import { VERSION } from "./version.js";

const HELP = `${bold("edena")}: Edena's command line, for people and for coding agents.

${bold("Usage")}
  edena <category> <action> [arguments] [flags]     every operation of the API
  edena students list --status active
  edena invoices get <id> --json

${bold("Find a command")}
  edena docs search "<words>"      the commands that match
  edena categories                 every category
  edena <category>                 its actions
  edena <category> <action> --help what it takes and answers
  edena docs show <category> <action>   with its types

${bold("Session")}
  edena login                      sign in from the browser (the sandbox, or real data)
  edena whoami                     the organization and key in use
  edena profiles / use <profile>   switch organization
  edena logout                     revoke this terminal's key

${bold("Build with the API")}
  edena prompt <category>          a prompt for a coding agent to implement it
  edena types <category>...        its TypeScript types
  edena api <METHOD> </path>       any request

${bold("Develop locally")}
  edena listen --forward-to http://localhost:3000/webhooks
                                   events as they happen, signed as webhooks are
  edena trigger client.updated     send one to that local server again
  edena logs [--mine]              the API's requests as they happen
  edena open [section]             the developer console in the browser

${bold("Coding agents")}
  edena skill install              teach Claude Code, Codex and Gemini CLI to use it

${bold("Flags")}
  --json     JSON output (the default when the output goes to another program)
  --yes      run a write without asking (agents need it; ask the person first)
  --all      every page of a list
  --profile  the organization to use (EDENA_PROFILE)
  EDENA_API_KEY and EDENA_API_URL override the session and the API's address.
`;

async function main(argv: string[]): Promise<number> {
    const args = parseArgs(argv);
    const [command, sub] = args.positionals;
    if (hasFlag(args, "version") || command === "version") {
        process.stdout.write(`${VERSION}\n`);
        return EXIT.ok;
    }
    if (!command || command === "help") {
        process.stdout.write(HELP);
        return EXIT.ok;
    }

    switch (command) {
        case "login":
            return login(args);
        case "logout":
            return logout(args);
        case "whoami":
            return whoami(args);
        case "profiles":
            return profiles(args);
        case "use":
            return use(args);
        case "api":
            return api(args);
        case "listen":
            return listen(args);
        case "trigger":
            return trigger(args);
        case "logs":
            return logs(args);
        case "open":
            return open(args);
        case "skill":
            if (sub === "install") return skillInstall(args);
            if (sub === "uninstall") return skillUninstall(args);
            if (sub === "show") return skillShow();
            throw new UsageError("Usage: edena skill install|uninstall|show [--agent claude|codex|gemini|all] [--project]");
    }
    if (command === "docs" && sub === "refresh") return docsRefresh(args);

    const session = await resolveSession(flag(args, "profile"));
    const reference = await loadReference(session.apiUrl);
    switch (command) {
        case "docs":
            if (sub === "search") return docsSearch(reference, args);
            if (sub === "show") return docsShow(reference, args, session.apiUrl);
            throw new UsageError('Usage: edena docs search "<words>" | docs show <category> <action> | docs refresh');
        case "categories":
            return categories(reference, args);
        case "prompt":
            return prompt(reference, args, session.apiUrl);
        case "types":
            return types(reference, args);
    }
    return runCommand(reference, args);
}

/** `edena <category> <action>`: one of the API's operations, from the reference. */
async function runCommand(reference: Awaited<ReturnType<typeof loadReference>>, args: ParsedArgs): Promise<number> {
    const [name, action] = args.positionals as [string, string | undefined];
    const group = reference.groups.get(name);
    if (!group) {
        const similar = [...reference.groups.keys()].filter((group) => distance(group, name) <= 2).map((group) => `edena ${group}`);
        const close = similar.length > 0 ? similar : reference.search(name, 3).map((operation) => `edena ${operation.command}`);
        throw new UsageError(`Unknown command “${name}”.`, close.length > 0 ? `Did you mean: ${close.join(", ")}?` : "Run edena categories, or edena docs search.");
    }
    if (!action) {
        process.stdout.write(groupHelp(group));
        return EXIT.ok;
    }
    const operation = reference.find(`${name} ${action}`);
    if (!operation) throw new UsageError(`“${name}” has no action “${action}”.`, `Its actions: ${group.operations.map((entry) => entry.action).join(", ")}.`);
    if (hasFlag(args, "help")) {
        process.stdout.write(operationHelp(reference, operation));
        return EXIT.ok;
    }
    return runOperation(reference, operation, args);
}

/** Edits between two words, for “did you mean” on a mistyped category. */
function distance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        let previous = row[0] as number;
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const current = row[j] as number;
            row[j] = Math.min(current + 1, (row[j - 1] as number) + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
    }
    return row[b.length] as number;
}

main(process.argv.slice(2)).then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        const args = parseArgs(process.argv.slice(2));
        printError(error, hasFlag(args, "json"));
        const exitCode = (error as { exitCode?: unknown }).exitCode;
        process.exitCode = typeof exitCode === "number" ? exitCode : EXIT.failure;
        if (process.env.EDENA_DEBUG && error instanceof Error) process.stderr.write(`${dim(error.stack ?? "")}\n`);
    },
);
