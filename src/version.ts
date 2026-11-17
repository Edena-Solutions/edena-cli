import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package's root: `dist/src/version.js` sits two folders below it. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The CLI's version, from its own package.json. */
export const VERSION: string = (() => {
    try {
        return (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;
    } catch {
        return "0.0.0";
    }
})();
