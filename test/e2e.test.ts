import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DOCUMENT } from "./fixture.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const KEY = "edn_test_abc123";

/** The API as the CLI sees it: the reference, the sign-in, and a few operations. */
function fakeApi() {
    const seen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
    let polls = 0;
    const resumedFrom: string[] = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
        const json = (status: number, value: unknown) => {
            response.writeHead(status, { "Content-Type": "application/json", "X-Request-Id": "req-1" });
            response.end(JSON.stringify(value));
        };
        const route = `${request.method} ${request.url?.split("?")[0]}`;
        if (route === "GET /openapi.json") return json(200, DOCUMENT);
        if (route === "POST /cli/sessions")
            return json(201, { deviceCode: "d".repeat(43), userCode: "BCDF-GHJK", verificationUrl: "http://web/cli/authorize?code=BCDF-GHJK", interval: 0.05, expiresIn: 5 });
        if (route === "POST /cli/sessions/token") {
            polls++;
            if (polls < 2) return json(200, { status: "pending" });
            return json(200, {
                status: "approved",
                apiKey: KEY,
                organization: { slug: "escola-sandbox", name: "Escola (sandbox)", environment: "sandbox" },
                key: { id: "key-1", name: "CLI · test", prefix: "edn_test_abc", role: "admin" },
            });
        }
        if (route === "GET /webhook-events/stream" || route === "GET /cli/logs") {
            if (request.headers.authorization !== `Bearer ${KEY}`) return json(401, { key: "auth.api_key_invalid", message: "No key." });
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            if (request.headers["last-event-id"]) {
                resumedFrom.push(String(request.headers["last-event-id"]));
                return; // Held open until the client goes.
            }
            const messages = route === "GET /cli/logs" ? [LOG] : EVENTS;
            for (const message of messages) {
                response.write(`id: ${message.id}\nevent: ${route === "GET /cli/logs" ? "request" : "event"}\ndata: ${JSON.stringify(message)}\n\n`);
            }
            response.write(": ping\n\nevent: reconnect\ndata: {}\n\n");
            return response.end();
        }
        if (request.headers.authorization !== `Bearer ${KEY}`) return json(401, { statusCode: 401, key: "auth.api_key_invalid", message: "No key.", requestId: "req-1" });
        if (route === "GET /cli/whoami") return json(200, { organization: { slug: "escola-sandbox", environment: "sandbox" }, key: { name: "CLI · test" } });
        if (route === "GET /clients") return json(200, { data: [{ id: "c1", name: "Ana" }], meta: { total: 1, page: 1, pageSize: 20, pages: 1 } });
        if (route === "POST /clients") return json(201, { id: "c2", ...JSON.parse(body) });
        if (route === "GET /clients/missing") return json(404, { statusCode: 404, key: "client.not_found", message: "Student not found.", requestId: "req-404" });
        if (route === "GET /webhook-events") return json(200, { data: [EVENTS[1]], meta: { total: 1, page: 1, pageSize: 1, pages: 1 } });
        if (route === "POST /cli/logout") {
            response.writeHead(204);
            return response.end();
        }
        return json(404, { statusCode: 404, key: "common.not_found", message: route });
    });
    return { server, seen, resumedFrom };
}

const EVENTS = [
    { id: "019a8c5e-7b2d-7f31-9c4e-2d6b8a1f0e37", type: "client.created", organizationId: "org-1", occurredAt: "2026-11-17T10:00:00.000Z", data: { resource: "client", id: "c1", changes: [], state: { status: "ACTIVE" }, previous: null }, actor: { type: "user", id: "u1" } },
    { id: "019a8c5e-7b2d-7f31-9c4e-2d6b8a1f0e38", type: "client.updated", organizationId: "org-1", occurredAt: "2026-11-17T10:01:00.000Z", data: { resource: "client", id: "c1", changes: ["status"], state: { status: "INACTIVE" }, previous: { status: "ACTIVE" } }, actor: { type: "api_key", id: "key-1" } },
];
const LOG = { id: "019a8c5e-7b2d-7f31-9c4e-2d6b8a1f0e40", method: "GET", route: "/clients", statusCode: 200, durationMs: 12, requestId: "req-9", createdAt: "2026-11-17T10:02:00.000Z", apiKey: { id: "key-1", name: "CLI · test", prefix: "edn_test_abc" } };

/** A local server, as a developer runs one to receive webhooks. */
function receiver() {
    const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
        response.writeHead(200).end("ok");
    });
    return { server, received };
}

const verify = (header: string, body: string, secret: string) => {
    const t = /t=(\d+)/.exec(header)?.[1];
    const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1];
    return v1 === createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
};

describe("edena, end to end against a fake API", () => {
    let server: Server;
    let seen: ReturnType<typeof fakeApi>["seen"];
    let resumedFrom: string[];
    let home: string;
    let env: NodeJS.ProcessEnv;

    const run = (args: string[]) =>
        new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
            execFile("node", [CLI, ...args], { env }, (error, stdout, stderr) =>
                resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
            );
        });

    before(async () => {
        ({ server, seen, resumedFrom } = fakeApi());
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        home = await mkdtemp(join(tmpdir(), "edena-cli-"));
        const { port } = server.address() as AddressInfo;
        env = { ...process.env, EDENA_API_URL: `http://127.0.0.1:${port}`, EDENA_CONFIG_DIR: join(home, "config"), EDENA_CACHE_DIR: join(home, "cache"), NO_COLOR: "1" };
        delete env.EDENA_API_KEY;
        delete env.EDENA_REFERENCE_FILE;
    });

    after(async () => {
        server.close();
        await rm(home, { recursive: true, force: true });
    });

    it("asks to sign in before calling the API", async () => {
        const result = await run(["students", "list"]);
        assert.equal(result.code, 3);
        assert.match(result.stderr, /Not signed in/);
    });

    it("signs in once the console approves, keeping the key readable only by its owner", async () => {
        const result = await run(["login"]);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stderr, /BCDF-GHJK/);
        assert.equal(JSON.parse(result.stdout).profile, "escola-sandbox");
        const credentials = join(home, "config", "credentials.json");
        assert.equal(JSON.parse(await readFile(credentials, "utf8"))["escola-sandbox"], KEY);
        if (process.platform !== "win32") assert.equal((await stat(credentials)).mode & 0o777, 0o600);
    });

    it("signs in in two steps for a coding agent: the link at once, then the wait", async () => {
        const started = await run(["login", "--start", "--json"]);
        assert.equal(started.code, 0, started.stderr);
        const answer = JSON.parse(started.stdout);
        assert.equal(answer.userCode, "BCDF-GHJK");
        assert.equal(answer.next, "edena login --wait");
        assert.equal(answer.deviceCode, undefined);
        const pending = join(home, "config", "pending-login.json");
        if (process.platform !== "win32") assert.equal((await stat(pending)).mode & 0o777, 0o600);

        const waited = await run(["login", "--wait", "--json"]);
        assert.equal(waited.code, 0, waited.stderr);
        assert.equal(JSON.parse(waited.stdout).profile, "escola-sandbox");
        await assert.rejects(stat(pending));

        const nothingWaiting = await run(["login", "--wait"]);
        assert.equal(nothingWaiting.code, 2);
        assert.match(nothingWaiting.stderr, /login --start/);
    });

    it("tells to sign in again when its key stopped working (expired or revoked)", async () => {
        const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
            execFile("node", [CLI, "students", "list", "--status", "active"], { env: { ...env, EDENA_API_KEY: "edn_test_expired" } }, (error, _stdout, stderr) =>
                resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr }),
            );
        });
        assert.equal(result.code, 3);
        // Agents read the JSON: the way out is in it too.
        assert.equal(JSON.parse(result.stderr).error.hint, "Run edena login to sign in again.");
    });

    it("runs an operation with the key, answering JSON to another program", async () => {
        const result = await run(["students", "list", "--status", "active"]);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).data[0].name, "Ana");
        assert.equal(seen.at(-1)?.url, "/clients?status=active");
    });

    it("will not write without --yes when nobody is at the keyboard", async () => {
        const refused = await run(["students", "create", "--name", "Bea"]);
        assert.equal(refused.code, 2);
        assert.match(refused.stderr, /--yes/);
        assert.notEqual(seen.at(-1)?.method, "POST");

        const done = await run(["students", "create", "--name", "Bea", "--age", "6", "--yes"]);
        assert.equal(done.code, 0, done.stderr);
        const request = seen.at(-1);
        assert.deepEqual(JSON.parse(request?.body ?? "{}"), { name: "Bea", age: 6 });
        assert.match(String(request?.headers["idempotency-key"]), /^[0-9a-f-]{36}$/);
    });

    it("reports the API's errors with their key and request id, and a code to branch on", async () => {
        const result = await run(["students", "get", "missing"]);
        assert.equal(result.code, 4);
        assert.deepEqual(JSON.parse(result.stderr).error, { status: 404, key: "client.not_found", message: "Student not found.", requestId: "req-404", details: null });
    });

    it("finds commands and writes prompts and types without calling anything but the reference", async () => {
        const search = await run(["docs", "search", "create a student"]);
        assert.equal(JSON.parse(search.stdout)[0].command, "edena students create");
        const prompt = await run(["prompt", "students"]);
        assert.match(prompt.stdout, /^# Implement the integration with “Students”/);
        const types = await run(["types", "students"]);
        assert.match(types.stdout, /export interface Client \{/);
    });

    /** Runs a command that follows a stream until `done` says it has what it needs, then stops it as Ctrl+C would. */
    const follow = (args: string[], done: (stdout: string) => boolean) =>
        new Promise<string>((resolve, reject) => {
            const child = spawn("node", [CLI, ...args], { env });
            let stdout = "";
            const timer = setTimeout(() => {
                child.kill("SIGINT");
                reject(new Error(`timed out: ${stdout}`));
            }, 15_000);
            child.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
            });
            // Some of what it waits for (a reconnection) prints nothing, so the check also runs on a timer.
            const check = setInterval(() => {
                if (done(stdout)) child.kill("SIGINT");
            }, 50);
            child.on("exit", () => {
                clearTimeout(timer);
                clearInterval(check);
                resolve(stdout);
            });
        });

    it("forwards the events as webhooks deliver them, signed, and resumes where it stopped", async () => {
        const { server: local, received } = receiver();
        await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
        const target = `http://127.0.0.1:${(local.address() as AddressInfo).port}/webhooks`;
        try {
            await follow(["listen", "--forward-to", target, "--events", "client.*"], () => received.length >= 2 && resumedFrom.length >= 1);
            const secret = JSON.parse(await readFile(join(home, "config", "listen-secret.json"), "utf8")) as string;
            assert.equal(received.length, 2);
            assert.equal(received[0]?.body, JSON.stringify(EVENTS[0]));
            assert.equal(received[1]?.headers["edena-event-type"], "client.updated");
            assert.ok(verify(String(received[0]?.headers["edena-signature"]), String(received[0]?.body), secret));
            assert.equal(resumedFrom[0], EVENTS[1]?.id);
            assert.match(String(seen.find((request) => request.url.startsWith("/webhook-events/stream"))?.url), /types=client\.\*/);

            const triggered = await run(["trigger", "client.updated"]);
            assert.equal(triggered.code, 0, triggered.stderr);
            assert.equal(received.at(-1)?.body, JSON.stringify(EVENTS[1]));
            assert.ok(verify(String(received.at(-1)?.headers["edena-signature"]), String(received.at(-1)?.body), secret));
        } finally {
            local.close();
        }
    });

    it("follows the API's requests as they happen", async () => {
        const stdout = await follow(["logs"], (out) => out.includes("\n"));
        assert.equal(JSON.parse(stdout.split("\n")[0] as string).requestId, "req-9");
    });

    it("signs out by revoking its key, and forgets it", async () => {
        const result = await run(["logout"]);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(seen.at(-1)?.url, "/cli/logout");
        const after = await run(["whoami"]);
        assert.equal(after.code, 3, "not signed in is an auth failure, not a usage error");
        assert.equal((await run(["logout"])).code, 3);
    });
});
