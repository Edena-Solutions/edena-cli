/** The words of a command, and its flags: a repeated flag keeps every value. */
export interface ParsedArgs {
    positionals: string[];
    flags: Map<string, string[]>;
}

/** Flags that never take a value, so `--json students` does not swallow the word after it. */
const BOOLEAN_FLAGS = new Set(["json", "yes", "all", "help", "refresh", "project", "version", "noBrowser", "printSecret", "mine"]);
const SHORT: Record<string, string> = { y: "yes", h: "help", v: "version" };

/** `--page-size` and `--pageSize` are the same flag: the API names it in camelCase. */
export function flagName(raw: string): string {
    return raw.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * `edena students get 0190… --status active --tag a --tag b --json` → positionals and flags. A flag
 * takes the next word as its value unless that is another flag; `--name=value` works too, and `--`
 * ends the flags.
 */
export function parseArgs(argv: string[]): ParsedArgs {
    const positionals: string[] = [];
    const flags = new Map<string, string[]>();
    const add = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value]);

    for (let index = 0; index < argv.length; index++) {
        const token = argv[index] as string;
        if (token === "--") {
            positionals.push(...argv.slice(index + 1));
            break;
        }
        if (/^-[a-z]$/i.test(token)) {
            add(SHORT[token.slice(1)] ?? token.slice(1), "true");
            continue;
        }
        if (!token.startsWith("--")) {
            positionals.push(token);
            continue;
        }
        const body = token.slice(2);
        const equals = body.indexOf("=");
        if (equals >= 0) {
            add(flagName(body.slice(0, equals)), body.slice(equals + 1));
            continue;
        }
        const name = flagName(body);
        const next = argv[index + 1];
        if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith("--")) {
            add(name, "true");
        } else {
            add(name, next);
            index++;
        }
    }
    return { positionals, flags };
}

export function flag(args: ParsedArgs, name: string): string | undefined {
    const values = args.flags.get(name);
    return values?.[values.length - 1];
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
    const value = flag(args, name);
    return value !== undefined && value !== "false";
}
