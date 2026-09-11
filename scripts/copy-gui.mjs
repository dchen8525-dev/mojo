// tsc does not copy non-TS assets; mirror src/gui/static into dist/gui/static.
import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../src/gui/static", import.meta.url));
const to = fileURLToPath(new URL("../dist/gui/static", import.meta.url));
cpSync(from, to, { recursive: true });
console.log(`copied gui static assets -> ${to}`);
