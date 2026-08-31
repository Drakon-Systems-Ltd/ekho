// dist/esm holds ESM, but the package itself is CommonJS (no top-level `type`),
// and Node decides a .js file's format from the nearest package.json — so
// without this marker every file tsc just wrote there is read as CommonJS and
// the ESM entry in `exports` is ESM in name only.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "esm");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
