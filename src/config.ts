import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://api.edena.es";

/** Where an organization's CLI key works, as the API answered on sign-in. */
export interface Profile {
    apiUrl: string;
    organization: { slug: string; name: string; environment: string };
    key: { id: string; name: string; prefix: string; role: string };
}

interface StoredConfig {
    current: string | null;
    profiles: Record<string, Profile>;
    /** Where `edena listen` last forwarded to, so `edena trigger` sends there too. */
    forwardTo?: string;
}

/** `~/.config/edena` (or `$XDG_CONFIG_HOME/edena`, `%APPDATA%\edena`); `EDENA_CONFIG_DIR` overrides it. */
export function configDir(): string {
    if (process.env.EDENA_CONFIG_DIR) return process.env.EDENA_CONFIG_DIR;
    if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "edena");
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "edena");
}

/** `~/.cache/edena`, for the API reference; `EDENA_CACHE_DIR` overrides it. */
export function cacheDir(): string {
    if (process.env.EDENA_CACHE_DIR) return process.env.EDENA_CACHE_DIR;
    if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "edena");
    return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "edena");
}

const configFile = () => join(configDir(), "config.json");
/** The keys, apart from the rest and readable only by their owner. */
const credentialsFile = () => join(configDir(), "credentials.json");

async function readJson<T>(path: string, fallback: T): Promise<T> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
        return fallback;
    }
}

async function writeJson(path: string, value: unknown, mode?: number): Promise<void> {
    await mkdir(configDir(), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
    if (mode !== undefined) await chmod(path, mode);
}

export async function readConfig(): Promise<StoredConfig> {
    return readJson<StoredConfig>(configFile(), { current: null, profiles: {} });
}

/** Keeps a signed-in organization, and makes it the one commands run in. */
export async function saveProfile(name: string, profile: Profile, apiKey: string): Promise<void> {
    const config = await readConfig();
    config.profiles[name] = profile;
    config.current = name;
    await writeJson(configFile(), config);
    const credentials = await readJson<Record<string, string>>(credentialsFile(), {});
    credentials[name] = apiKey;
    await writeJson(credentialsFile(), credentials, 0o600);
}

export async function useProfile(name: string): Promise<void> {
    const config = await readConfig();
    config.current = name;
    await writeJson(configFile(), config);
}

/** Forgets a profile and its key; the next one left becomes the current one. */
export async function removeProfile(name: string): Promise<void> {
    const config = await readConfig();
    delete config.profiles[name];
    if (config.current === name) config.current = Object.keys(config.profiles)[0] ?? null;
    await writeJson(configFile(), config);
    const credentials = await readJson<Record<string, string>>(credentialsFile(), {});
    delete credentials[name];
    if (Object.keys(credentials).length === 0) await rm(credentialsFile(), { force: true });
    else await writeJson(credentialsFile(), credentials, 0o600);
}

/** Remembers where `edena listen` forwards, for `edena trigger`. */
export async function saveForwardTo(url: string): Promise<void> {
    const config = await readConfig();
    config.forwardTo = url;
    await writeJson(configFile(), config);
}

/**
 * The secret `edena listen` and `edena trigger` sign local deliveries with: one per machine, kept
 * apart and readable only by its owner, so a local server verifies `Edena-Signature` with a stable
 * value, as it would with an endpoint's.
 */
export async function listenSecret(): Promise<string> {
    const file = join(configDir(), "listen-secret.json");
    const existing = await readJson<string>(file, "");
    if (existing) return existing;
    const secret = `whsec_${randomBytes(32).toString("base64url")}`;
    await writeJson(file, secret, 0o600);
    return secret;
}

/** A sign-in started with `edena login --start`, for `edena login --wait` to finish. */
export interface PendingLogin {
    apiUrl: string;
    /** Secret: whoever holds it receives the key once the sign-in is approved. */
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    interval: number;
    /** Unix milliseconds. */
    expiresAt: number;
}

const pendingLoginFile = () => join(configDir(), "pending-login.json");

/** Kept like the keys, readable only by their owner: the device code is as good as the key it waits for. */
export async function savePendingLogin(pending: PendingLogin): Promise<void> {
    await writeJson(pendingLoginFile(), pending, 0o600);
}

export async function readPendingLogin(): Promise<PendingLogin | null> {
    return readJson<PendingLogin | null>(pendingLoginFile(), null);
}

export async function clearPendingLogin(): Promise<void> {
    await rm(pendingLoginFile(), { force: true });
}

/** What a command runs with: the key and where it works. */
export interface Session {
    apiUrl: string;
    apiKey: string | null;
    profileName: string | null;
    profile: Profile | null;
}

/**
 * The session a command runs in: `EDENA_API_KEY` when set (CI, a script), else the profile named by
 * `--profile` or `EDENA_PROFILE`, else the current one. `EDENA_API_URL` points it at another API.
 */
export async function resolveSession(profileFlag?: string): Promise<Session> {
    const config = await readConfig();
    const envKey = process.env.EDENA_API_KEY?.trim() || null;
    const name = profileFlag ?? process.env.EDENA_PROFILE ?? config.current;
    const profile = name ? (config.profiles[name] ?? null) : null;
    const apiUrl = (process.env.EDENA_API_URL ?? profile?.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    if (envKey) return { apiUrl, apiKey: envKey, profileName: null, profile: null };
    const credentials = await readJson<Record<string, string>>(credentialsFile(), {});
    return { apiUrl, apiKey: name ? (credentials[name] ?? null) : null, profileName: profile ? name : null, profile };
}
