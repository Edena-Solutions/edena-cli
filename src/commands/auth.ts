import { hostname } from "node:os";
import { type ParsedArgs, flag, hasFlag } from "../args.js";
import { DEFAULT_API_URL, readConfig, removeProfile, resolveSession, saveProfile, useProfile } from "../config.js";
import { ApiError, EXIT, NotSignedInError, UsageError } from "../errors.js";
import { apiRequest } from "../http.js";
import { bold, dim, printHuman, printJson, wantsJson } from "../output.js";
import { VERSION } from "../version.js";
import { openUrl } from "./open.js";

interface Started {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    interval: number;
    expiresIn: number;
}

type Poll =
    | { status: "pending" }
    | {
          status: "approved";
          apiKey: string;
          organization: { slug: string; name: string; environment: string };
          key: { id: string; name: string; prefix: string; role: string };
      };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signs in the way a TV signs in to a streaming service: the terminal asks the API for a sign-in, the
 * person approves it in the console (choosing the sandbox or the real data, and the role), and the
 * terminal receives an API key of its own. Nothing is copied by hand.
 */
export async function login(args: ParsedArgs): Promise<number> {
    const apiUrl = (flag(args, "apiUrl") ?? process.env.EDENA_API_URL ?? DEFAULT_API_URL).replace(/\/$/, "");
    const json = wantsJson(hasFlag(args, "json"));
    const call = <T>(path: string, body: unknown) =>
        apiRequest({ apiUrl, apiKey: null, method: "POST", path, body }).then((response) => (response.kind === "json" ? (response.data as T) : null));

    const started = await call<Started>("/cli/sessions", { client: hostname().slice(0, 60), platform: process.platform, version: VERSION });
    if (!started) throw new Error("The API did not start the sign-in.");

    process.stderr.write(`\nOpen this page to sign in, and check that it shows the code ${bold(started.userCode)}:\n\n  ${started.verificationUrl}\n\n`);
    if (!hasFlag(args, "noBrowser") && process.stdout.isTTY) openUrl(started.verificationUrl);
    process.stderr.write(dim("Waiting for you to approve it in the console…\n"));

    const deadline = Date.now() + started.expiresIn * 1000;
    while (Date.now() < deadline) {
        await sleep(started.interval * 1000);
        let poll: Poll | null;
        try {
            poll = await call<Poll>("/cli/sessions/token", { deviceCode: started.deviceCode });
        } catch (error) {
            if (error instanceof ApiError && error.key === "cli.session_denied") {
                process.stderr.write("The sign-in was denied in the console.\n");
                return EXIT.auth;
            }
            throw error;
        }
        if (!poll || poll.status === "pending") continue;
        const profile = { apiUrl, organization: poll.organization, key: poll.key };
        await saveProfile(poll.organization.slug, profile, poll.apiKey);
        if (json) printJson({ signedIn: true, profile: poll.organization.slug, ...profile });
        else
            process.stdout.write(
                `Signed in to ${bold(poll.organization.name)} (${poll.organization.environment}) with the key “${poll.key.name}”.\n` +
                    dim(`Commands now run there. Try: edena students list\n`),
            );
        return EXIT.ok;
    }
    process.stderr.write("The sign-in ran out. Run edena login again.\n");
    return EXIT.auth;
}

/** Revokes the key this terminal holds and forgets it: signing out for good, not just locally. */
export async function logout(args: ParsedArgs): Promise<number> {
    const session = await resolveSession(flag(args, "profile"));
    if (!session.profileName || !session.apiKey) throw new NotSignedInError("Run edena login.");
    try {
        await apiRequest({ apiUrl: session.apiUrl, apiKey: session.apiKey, method: "POST", path: "/cli/logout" });
    } catch (error) {
        // A key revoked already, from the console: there is nothing left to revoke, only to forget.
        if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    await removeProfile(session.profileName);
    process.stdout.write(`Signed out of ${session.profile?.organization.name ?? session.profileName}; its key is revoked.\n`);
    return EXIT.ok;
}

/** Who the CLI is signed in as, from the API itself. */
export async function whoami(args: ParsedArgs): Promise<number> {
    const session = await resolveSession(flag(args, "profile"));
    if (!session.apiKey) throw new NotSignedInError();
    const response = await apiRequest({ apiUrl: session.apiUrl, apiKey: session.apiKey, method: "GET", path: "/cli/whoami" });
    const data = response.kind === "json" ? response.data : null;
    if (wantsJson(hasFlag(args, "json"))) printJson({ profile: session.profileName, apiUrl: session.apiUrl, ...(data as object) });
    else printHuman(data);
    return EXIT.ok;
}

/** The organizations this terminal is signed in to, the current one marked. */
export async function profiles(args: ParsedArgs): Promise<number> {
    const config = await readConfig();
    const list = Object.entries(config.profiles).map(([name, profile]) => ({
        profile: name,
        current: name === config.current,
        organization: profile.organization.name,
        environment: profile.organization.environment,
        key: profile.key.name,
        apiUrl: profile.apiUrl,
    }));
    if (wantsJson(hasFlag(args, "json"))) printJson(list);
    else if (list.length === 0) process.stdout.write("Not signed in anywhere. Run edena login.\n");
    else for (const entry of list) process.stdout.write(`${entry.current ? "*" : " "} ${bold(entry.profile)}  ${entry.organization} (${entry.environment})  ${dim(entry.key)}\n`);
    return EXIT.ok;
}

/** Makes another signed-in organization the one commands run in. */
export async function use(args: ParsedArgs): Promise<number> {
    const name = args.positionals[1];
    const config = await readConfig();
    if (!name || !config.profiles[name]) {
        throw new UsageError(name ? `Not signed in to “${name}”.` : "Which profile?", `Profiles: ${Object.keys(config.profiles).join(", ") || "none"}. Run edena profiles.`);
    }
    await useProfile(name);
    const profile = config.profiles[name];
    process.stdout.write(`Commands now run in ${profile?.organization.name} (${profile?.organization.environment}).\n`);
    return EXIT.ok;
}
