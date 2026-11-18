import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../src/args.js";
import { isWebUrl } from "../src/commands/open.js";
import { buildRequest } from "../src/commands/operation.js";
import { printHuman, printJson, sanitizeForTerminal } from "../src/output.js";
import { HIDDEN, hideSensitive, sensitiveRulesOf, shouldHideSensitive, worksOnRealData } from "../src/redact.js";
import { Reference } from "../src/reference.js";
import { categoryPrompt } from "../src/schema.js";
import { DOCUMENT } from "./fixture.js";

const reference = new Reference(DOCUMENT);

describe("parseArgs", () => {
    it("reads words, flags with values, repeated flags and booleans", () => {
        const args = parseArgs(["students", "list", "--status", "active", "--tag", "a", "--tag=b", "--json", "--page-size", "5", "-y"]);
        assert.deepEqual(args.positionals, ["students", "list"]);
        assert.deepEqual(args.flags.get("tag"), ["a", "b"]);
        assert.deepEqual(args.flags.get("pageSize"), ["5"]);
        assert.deepEqual(args.flags.get("json"), ["true"]);
        assert.deepEqual(args.flags.get("yes"), ["true"]);
    });

    it("never lets a boolean flag swallow the word after it", () => {
        assert.deepEqual(parseArgs(["--json", "students", "list"]).positionals, ["students", "list"]);
    });
});

describe("Reference", () => {
    it("knows every operation by its command and by its id", () => {
        assert.equal(reference.find("students list")?.id, "clients_list");
        assert.equal(reference.find("clients_getById")?.command, "students get");
        assert.deepEqual([...reference.groups.keys()].sort(), ["invoices", "students"]);
    });

    it("finds what a person asked for, ignoring empty words, plurals and accents", () => {
        assert.equal(reference.search("list the students")[0]?.command, "students list");
        assert.equal(reference.search("create a stúdent")[0]?.command, "students create");
        assert.equal(reference.search("invoice pdf")[0]?.command, "invoices pdf");
        assert.deepEqual(reference.search("the of"), []);
    });
});

describe("buildRequest", () => {
    const build = (argv: string[]) => buildRequest(reference, reference.find(`${argv[0]} ${argv[1]}`)!, parseArgs(argv));

    it("fills the path in order and the query from flags", async () => {
        const request = await build(["students", "get", "0190-abc"]);
        assert.equal(request.path, "/clients/0190-abc");
        const list = await build(["students", "list", "--status", "active,inactive"]);
        assert.deepEqual(list.query, { status: ["active", "inactive"] });
    });

    it("builds the body from field flags, typed by the schema, over --data", async () => {
        const request = await build(["students", "create", "--data", '{"name":"Ana"}', "--age", "7"]);
        assert.deepEqual(request.body, { name: "Ana", age: 7 });
    });

    it("refuses a missing argument and an unknown flag, saying how to call it", async () => {
        await assert.rejects(build(["students", "get"]), /Missing <id>/);
        await assert.rejects(build(["students", "list", "--colour", "red"]), /Unknown flag --colour/);
    });
});

describe("categoryPrompt", () => {
    it("states the rules, every operation with its command, and every type once", () => {
        const prompt = categoryPrompt(DOCUMENT, reference.groups.get("students")!, "https://api.edena.es");
        assert.match(prompt, /^# Implement the integration with “Students” of the Edena API/);
        assert.match(prompt, /Base URL: `https:\/\/api\.edena\.es`/);
        assert.match(prompt, /`edena students create` \(`clients_create`\): Creates a student\./);
        assert.match(prompt, /interface CreateClientDto \{\n    \/\*\* max 120 \*\/\n    name: string;/);
        assert.equal(prompt.match(/interface Client \{/g)?.length, 1);
        assert.doesNotMatch(prompt, /`Idempotency-Key` \(/);
    });
});

/** What a function writes to stdout, as one string. */
function captureStdout(run: () => void): string {
    const original = process.stdout.write.bind(process.stdout);
    let written = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
        written += String(chunk);
        return true;
    }) as typeof process.stdout.write;
    try {
        run();
    } finally {
        process.stdout.write = original;
    }
    return written;
}

/** A name that retitles the window, erases the line and writes to the clipboard, in terminals that obey. */
const HOSTILE = "Ana\u001b]0;X\u0007\u001b[2K\u001b]52;c;cHduZWQ=\u0007";

describe("sanitizeForTerminal", () => {
    it("takes every control character out of what the API sent", () => {
        const safe = sanitizeForTerminal(HOSTILE);
        assert.ok(!safe.includes("\u001b"));
        assert.ok(!safe.includes("\u0007"));
        assert.ok(safe.startsWith("Ana"));
        // Tampering shows instead of vanishing.
        assert.ok(safe.includes("\uFFFD"));
    });

    it("turns line breaks and tabs into spaces, and neutralises text-direction controls and C1", () => {
        assert.equal(sanitizeForTerminal("a\r\nb\tc\nd\re"), "a b c d e");
        assert.equal(sanitizeForTerminal("x\u202Eabc\u2066y\u009B"), "x\uFFFDabc\uFFFDy\uFFFD");
    });

    it("leaves accents and emoji as they are", () => {
        for (const name of ["José Ñúñez", "Çàrol·la d'Ègara", "Lucía 👩‍🏫", "李小龙"]) assert.equal(sanitizeForTerminal(name), name);
    });
});

describe("printHuman", () => {
    it("prints no control character a record carried, and lines columns up on the text as printed", () => {
        const out = captureStdout(() =>
            printHuman([
                { id: "c1", name: HOSTILE, email: "ana@escola.es" },
                { id: "c2", name: "Bea", email: "bea@escola.es" },
            ]),
        );
        assert.ok(!out.includes("\u001b"));
        assert.ok(!out.includes("\u0007"));
        const [header, first, second] = out.split("\n");
        // The email column starts at the same place on every line.
        const at = header!.indexOf("email");
        assert.equal(first!.indexOf("ana@escola.es"), at);
        assert.equal(second!.indexOf("bea@escola.es"), at);
    });

    it("cleans a record's keys and values field by field", () => {
        const out = captureStdout(() => printHuman({ ["na\u001b[31mme"]: HOSTILE }));
        assert.ok(!out.includes("\u001b"));
    });
});

describe("printJson", () => {
    it("hands the data over unaltered, for a program to read", () => {
        const out = captureStdout(() => printJson({ name: HOSTILE }));
        assert.equal((JSON.parse(out) as { name: string }).name, HOSTILE);
        // JSON escapes the control characters itself: none reaches the terminal raw.
        assert.ok(!out.includes("\u001b"));
    });
});

describe("isWebUrl", () => {
    it("only lets http(s) addresses be opened", () => {
        assert.ok(isWebUrl("https://app.edena.es/escola/developers"));
        for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ms-settings:", "not a url"]) assert.ok(!isWebUrl(url));
    });
});


describe("hiding sensitive fields from other programs", () => {
    const live = { apiKey: "edn_live_x", profile: { apiUrl: "", organization: { slug: "escola", name: "Escola", environment: "live" }, key: { id: "k", name: "CLI", prefix: "edn_live_", role: "admin" } } };
    const sandbox = { ...live, profile: { ...live.profile, organization: { ...live.profile.organization, environment: "sandbox" } } };
    const noFlags = parseArgs([]);

    it("hides on real data when the output goes to another program, and only then", () => {
        assert.equal(shouldHideSensitive(live, noFlags, false), true);
        assert.equal(shouldHideSensitive(live, noFlags, true), false);
        assert.equal(shouldHideSensitive(sandbox, noFlags, false), false);
        assert.equal(shouldHideSensitive(live, parseArgs(["--reveal-sensitive"]), false), false);
    });

    it("tells real data from a sandbox by the key when it comes from EDENA_API_KEY, unknown counting as real", () => {
        assert.equal(worksOnRealData({ apiKey: "edn_live_x", profile: null }), true);
        assert.equal(worksOnRealData({ apiKey: "edn_test_x", profile: null }), false);
        assert.equal(worksOnRealData({ apiKey: "something-else", profile: null }), true);
    });

    it("applies the API's rules, and never fewer than its own floor", () => {
        const fromApi = sensitiveRulesOf({ "x-sensitive-keys": ["iban", "favouriteColour"], "x-sensitive-key-patterns": ["^secretnote"] });
        const answer = { favouriteColour: "blue", secretNoteForTeacher: "x", dni: "1", name: "Ana" };
        const { value, hidden } = hideSensitive(answer, fromApi);
        assert.deepEqual(value, { favouriteColour: HIDDEN, secretNoteForTeacher: HIDDEN, dni: HIDDEN, name: "Ana" });
        assert.equal(hidden, 3);
    });

    it("keeps hiding with the floor alone when the reference carries no rules, or broken ones", () => {
        for (const document of [{}, { "x-sensitive-keys": [], "x-sensitive-key-patterns": ["(unclosed"] }]) {
            const { value } = hideSensitive({ IBAN: "ES91", allergyNotes: "nuts", passportNumber: "X1" }, sensitiveRulesOf(document));
            assert.deepEqual(value, { IBAN: HIDDEN, allergyNotes: HIDDEN, passportNumber: HIDDEN });
        }
    });

    it("hides nested fields and fields inside lists, leaving empty ones as they are", () => {
        const { value, hidden } = hideSensitive(
            { data: [{ guardians: [{ dni: "1", iban: "" }, { healthInfo: { notes: "x" } }] }] },
            sensitiveRulesOf({}),
        );
        assert.deepEqual(value, { data: [{ guardians: [{ dni: HIDDEN, iban: "" }, { healthInfo: HIDDEN }] }] });
        assert.equal(hidden, 2);
    });
});
