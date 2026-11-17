import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../src/args.js";
import { buildRequest } from "../src/commands/operation.js";
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
