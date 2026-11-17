import { createHmac, randomUUID } from "node:crypto";
import { type ParsedArgs, flag, hasFlag } from "../args.js";
import { listenSecret, readConfig, resolveSession, saveForwardTo, type Session } from "../config.js";
import { EXIT, NotSignedInError, UsageError } from "../errors.js";
import { apiRequest } from "../http.js";
import { bold, dim, red, wantsJson } from "../output.js";
import { followStream, sinceOf } from "../sse.js";

/** The headers every delivery carries, as the API's webhooks send them. */
const HEADERS = { signature: "Edena-Signature", eventId: "Edena-Event-Id", eventType: "Edena-Event-Type", deliveryId: "Edena-Delivery-Id" };

/** `t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<body>">`: the same signature a real endpoint receives. */
export function signatureHeader(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
    return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

const time = () => new Date().toTimeString().slice(0, 8);

/**
 * Delivers one event to a local server the way a webhook endpoint gets it: the same body, byte for
 * byte, and the same headers, signed with this machine's listen secret.
 */
async function forward(url: string, body: string, type: string, eventId: string, secret: string) {
    const started = Date.now();
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Edena-Webhooks (edena listen)",
                [HEADERS.signature]: signatureHeader(secret, body),
                [HEADERS.eventId]: eventId,
                [HEADERS.eventType]: type,
                [HEADERS.deliveryId]: `cli_${randomUUID()}`,
            },
            body,
            signal: AbortSignal.timeout(10_000),
        });
        await response.arrayBuffer().catch(() => undefined);
        return { status: response.status, durationMs: Date.now() - started, error: null };
    } catch (error) {
        return { status: null, durationMs: Date.now() - started, error: (error as Error).message };
    }
}

function printDelivery(json: boolean, type: string, eventId: string, result: Awaited<ReturnType<typeof forward>> | null) {
    if (json) {
        process.stdout.write(`${JSON.stringify({ type, eventId, forward: result })}\n`);
        return;
    }
    const outcome = !result
        ? ""
        : result.status === null
          ? red(`→ failed: ${result.error}`)
          : result.status < 300
            ? `→ ${result.status} ${dim(`(${result.durationMs} ms)`)}`
            : red(`→ ${result.status} (${result.durationMs} ms)`);
    process.stdout.write(`${dim(time())}  ${bold(type.padEnd(28))} ${dim(eventId)}  ${outcome}\n`);
}

async function signedIn(args: ParsedArgs): Promise<Session & { apiKey: string }> {
    const session = await resolveSession(flag(args, "profile"));
    if (!session.apiKey) throw new NotSignedInError();
    return session as Session & { apiKey: string };
}

/**
 * `edena listen --forward-to http://localhost:3000/webhooks`: the organization's events as they happen,
 * forwarded to a local server, so webhooks can be built without a public address. Without
 * `--forward-to` it prints them. `--events client.*,invoice.updated` narrows them; `--since 1h`
 * replays the last hour first.
 */
export async function listen(args: ParsedArgs): Promise<number> {
    const session = await signedIn(args);
    const secret = await listenSecret();
    if (hasFlag(args, "printSecret")) {
        process.stdout.write(`${secret}\n`);
        return EXIT.ok;
    }
    const forwardTo = flag(args, "forwardTo");
    if (forwardTo) {
        if (!/^https?:\/\//.test(forwardTo)) throw new UsageError(`--forward-to takes a URL, not “${forwardTo}”.`);
        await saveForwardTo(forwardTo);
    }
    const url = new URL(`${session.apiUrl}/webhook-events/stream`);
    const events = flag(args, "events");
    if (events) url.searchParams.set("types", events);
    const since = flag(args, "since");
    if (since) url.searchParams.set("since", sinceOf(since));
    const json = wantsJson(hasFlag(args, "json"));
    const where = session.profile ? `${session.profile.organization.name} (${session.profile.organization.environment})` : session.apiUrl;

    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    await followStream({
        url: url.toString(),
        apiKey: session.apiKey,
        signal: controller.signal,
        onOpen: (reconnected) => {
            if (reconnected || json) return;
            process.stderr.write(
                `Listening to ${bold(where)}${events ? ` (${events})` : ""}${forwardTo ? `, forwarding to ${bold(forwardTo)}` : ""}.\n` +
                    (forwardTo ? `Signing secret: ${secret}\n${dim("Verify Edena-Signature with it, as you would with an endpoint's secret.")}\n` : "") +
                    dim("Ctrl+C to stop.\n\n"),
            );
        },
        onDisconnect: () => {
            if (!json) process.stderr.write(dim("Connection lost; reconnecting…\n"));
        },
        onMessage: async (message) => {
            if (message.event !== "event") return;
            const event = JSON.parse(message.data) as { id: string; type: string };
            const result = forwardTo ? await forward(forwardTo, message.data, event.type, event.id, secret) : null;
            if (!forwardTo && json) process.stdout.write(`${message.data}\n`);
            else printDelivery(json, event.type, event.id, result);
        },
    });
    return EXIT.ok;
}

/**
 * `edena trigger client.updated`: sends an event of that type to the local server `edena listen` forwards
 * to (or `--forward-to`), without changing any data. It resends the organization's latest real event of
 * the type, so the body is a true one; `--event <id>` resends a given one.
 */
export async function trigger(args: ParsedArgs): Promise<number> {
    const session = await signedIn(args);
    const type = args.positionals[1];
    const eventId = flag(args, "event");
    if (!type && !eventId) throw new UsageError("Which event?", "Usage: edena trigger <type> or edena trigger --event <id>. Types: edena webhook-events types");
    const forwardTo = flag(args, "forwardTo") ?? (await readConfig()).forwardTo;
    if (!forwardTo) throw new UsageError("Where to?", "Pass --forward-to <url>, or run edena listen --forward-to <url> first.");

    const event = await findEvent(session, type, eventId);
    const body = JSON.stringify(event);
    const secret = await listenSecret();
    const result = await forward(forwardTo, body, event.type, event.id, secret);
    printDelivery(wantsJson(hasFlag(args, "json")), event.type, event.id, result);
    return result.status !== null && result.status < 300 ? EXIT.ok : EXIT.failure;
}

type EventBody = { id: string; type: string };

/** The event to send: the one asked for by id, or the latest real one of the type. */
async function findEvent(session: Session & { apiKey: string }, type: string | undefined, eventId: string | undefined): Promise<EventBody> {
    const call = (path: string, query?: Record<string, string>) => apiRequest({ apiUrl: session.apiUrl, apiKey: session.apiKey, method: "GET", path, query });
    if (eventId) {
        const response = await call(`/webhook-events/${encodeURIComponent(eventId)}`);
        if (response.kind === "json") return response.data as EventBody;
        throw new UsageError(`No event ${eventId}.`);
    }
    const response = await call("/webhook-events", { type: type as string, pageSize: "1" });
    const latest = response.kind === "json" ? (response.data as { data: EventBody[] }).data[0] : undefined;
    if (latest) return latest;
    throw new UsageError(
        `There is no ${type} event in the last 30 days to send.`,
        "Make that change in the sandbox (from the apps or with the CLI) and it will be there; edena webhook-events types lists every type.",
    );
}
