import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ParsedArgs, flag, hasFlag } from "../args.js";
import { EXIT, UsageError } from "../errors.js";
import { bold, dim } from "../output.js";
import { PACKAGE_ROOT } from "../version.js";

/**
 * Where each agent reads skills (the open `SKILL.md` format): for every project of the user, or for
 * the project in the current folder. Codex reads the shared `.agents/skills`.
 */
const AGENTS = {
    claude: { name: "Claude Code", home: ".claude", user: [".claude", "skills"], project: [".claude", "skills"] },
    codex: { name: "Codex", home: ".codex", user: [".agents", "skills"], project: [".agents", "skills"] },
    gemini: { name: "Gemini CLI", home: ".gemini", user: [".gemini", "skills"], project: [".gemini", "skills"] },
} as const;
type Agent = keyof typeof AGENTS;

const SKILL_NAME = "edena";
const skillSource = () => join(PACKAGE_ROOT, "skill", "SKILL.md");

function targets(args: ParsedArgs): Agent[] {
    const chosen = flag(args, "agent");
    if (chosen === "all") return Object.keys(AGENTS) as Agent[];
    if (chosen) {
        if (!(chosen in AGENTS)) throw new UsageError(`Unknown agent “${chosen}”.`, `Agents: ${Object.keys(AGENTS).join(", ")}, all.`);
        return [chosen as Agent];
    }
    // The agents this machine has; with none found, all of them, since the files cost nothing.
    const found = (Object.keys(AGENTS) as Agent[]).filter((agent) => existsSync(join(homedir(), AGENTS[agent].home)));
    return found.length > 0 ? found : (Object.keys(AGENTS) as Agent[]);
}

function folder(agent: Agent, project: boolean): string {
    const parts = project ? AGENTS[agent].project : AGENTS[agent].user;
    return join(project ? process.cwd() : homedir(), ...parts, SKILL_NAME);
}

/** `edena skill install`: teaches the agents on this machine to use the CLI. */
export async function skillInstall(args: ParsedArgs): Promise<number> {
    const content = await readFile(skillSource(), "utf8");
    const project = hasFlag(args, "project");
    for (const agent of targets(args)) {
        const dir = folder(agent, project);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), content);
        process.stdout.write(`${bold(AGENTS[agent].name)}  ${dim(join(dir, "SKILL.md"))}\n`);
    }
    process.stdout.write(`\nDone. Ask your agent in your own words, for example: “how many active students have no payer?”\n${dim("Restart the agent if it was open, so it finds the skill.")}\n`);
    return EXIT.ok;
}

/** `edena skill uninstall`: removes what `install` wrote. */
export async function skillUninstall(args: ParsedArgs): Promise<number> {
    const project = hasFlag(args, "project");
    for (const agent of targets(args)) {
        const dir = folder(agent, project);
        if (!existsSync(dir)) continue;
        await rm(dir, { recursive: true, force: true });
        process.stdout.write(`Removed from ${AGENTS[agent].name}.\n`);
    }
    return EXIT.ok;
}

/** `edena skill show`: the skill itself, to read or to copy where an agent not listed reads skills. */
export async function skillShow(): Promise<number> {
    process.stdout.write(await readFile(skillSource(), "utf8"));
    return EXIT.ok;
}
