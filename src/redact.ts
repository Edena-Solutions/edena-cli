import { type ParsedArgs, hasFlag } from "./args.js";
import type { Session } from "./config.js";

/** What a hidden field's value becomes. */
export const HIDDEN = "[hidden]";

/**
 * The fields whose values are most sensitive (bank details, identity documents, credentials), lowercase.
 * The API publishes the full list in its reference (`x-sensitive-keys`); this is the floor, applied
 * even when the reference carries none (an older API) or fewer, so a field is never let through for
 * want of rules.
 */
const FLOOR_KEYS = [
    "iban",
    "payeeiban",
    "supplieriban",
    "bic",
    "swiftbic",
    "accountnumber",
    "bankaccount",
    "taxid",
    "suppliertaxid",
    "nif",
    "dni",
    "nie",
    "passport",
    "passportnumber",
    "documentnumber",
    "idnumber",
    "identitydocument",
    "socialsecuritynumber",
    "password",
    "secret",
    "token",
    "accesstoken",
    "refreshtoken",
    "apikey",
    "pin",
];
/** Health in all its forms, matched case aside: the floor of `x-sensitive-key-patterns`. */
const FLOOR_PATTERNS = ["^(health|allerg|medic|diet|diagnos|disabilit)"];

export interface SensitiveRules {
    keys: ReadonlySet<string>;
    patterns: readonly RegExp[];
}

/** The reference's rules, added to the floor: the API may hide more, never less. */
export function sensitiveRulesOf(document: { "x-sensitive-keys"?: unknown; "x-sensitive-key-patterns"?: unknown }): SensitiveRules {
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    const keys = new Set([...FLOOR_KEYS, ...strings(document["x-sensitive-keys"]).map((key) => key.toLowerCase())]);
    const patterns = [...new Set([...FLOOR_PATTERNS, ...strings(document["x-sensitive-key-patterns"])])].flatMap((source) => {
        try {
            return [new RegExp(source, "i")];
        } catch {
            return [];
        }
    });
    return { keys, patterns };
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/** A copy of an answer with its sensitive fields' values hidden, at any depth, and how many were. */
export function hideSensitive(value: unknown, rules: SensitiveRules): { value: unknown; hidden: number } {
    let hidden = 0;
    const visit = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(visit);
        if (node === null || typeof node !== "object") return node;
        return Object.fromEntries(
            Object.entries(node as Record<string, unknown>).map(([key, field]) => {
                const sensitive = rules.keys.has(key.toLowerCase()) || rules.patterns.some((pattern) => pattern.test(key));
                if (sensitive && !isEmpty(field)) {
                    hidden += 1;
                    return [key, HIDDEN];
                }
                return [key, visit(field)];
            }),
        );
    };
    return { value: visit(value), hidden };
}

/**
 * Whether the session works on real data: its profile says which, and a key from `EDENA_API_KEY` says so
 * by its prefix (`edn_test_` is a sandbox's). Unknown counts as real.
 */
export function worksOnRealData(session: Pick<Session, "profile" | "apiKey">): boolean {
    if (session.profile) return session.profile.organization.environment !== "sandbox";
    return !session.apiKey?.startsWith("edn_test_");
}

/**
 * Whether to hide the sensitive fields of what is printed: on real data, when the output goes to another
 * program rather than a person (an AI agent, a pipe, a script), unless `--reveal-sensitive`. What an
 * agent reads goes to its provider, and these are the data the law guards most, many of them about
 * minors. It keeps them from being sent by accident; it is not a security boundary, since anyone with
 * the key can ask the API directly.
 */
export function shouldHideSensitive(session: Pick<Session, "profile" | "apiKey">, args: ParsedArgs, toTerminal = Boolean(process.stdout.isTTY)): boolean {
    return worksOnRealData(session) && !toTerminal && !hasFlag(args, "revealSensitive");
}

/** Says on stderr how many fields were hidden, and how to see them. */
export function reportHidden(hidden: number): void {
    if (hidden === 0) return;
    process.stderr.write(
        `Hid ${hidden} sensitive ${hidden === 1 ? "field" : "fields"} (bank details, identity documents, health, credentials): ` +
            "the data is real and this output goes to another program, such as an AI agent. A person sees them in Edena; " +
            "a script that needs them passes --reveal-sensitive.\n",
    );
}
