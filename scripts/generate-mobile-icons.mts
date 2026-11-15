import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createServer } from "vite-plus";
import { rendererViteResolve } from "../config/renderer-vite-shared";
import { legacyMobileIcons } from "./mobile-icons/legacy";
import { vitePlusCommand } from "./vite-plus-command";

const { values } = parseArgs({
  options: {
    json: { type: "string" },
    "legacy-json": { type: "string" },
    "sources-json": { type: "string" },
  },
});
const root = resolve(import.meta.dirname, "..");
// Vite supplies the renderer aliases, JSX transform and import.meta.env used by icon dependencies.
const server = await createServer({
  configFile: false,
  root,
  tsconfig: resolve(root, "config/tsconfig.web.json"),
  resolve: rendererViteResolve,
  server: { middlewareMode: true, watch: null, ws: false },
  optimizeDeps: { noDiscovery: true },
});
let generator: typeof import("./mobile-icons/generate");
try {
  generator = (await server.ssrLoadModule("/scripts/mobile-icons/generate.ts")) as typeof generator;
} finally {
  await server.close();
}
const { generateMobileIcons, GENERATED_PATH, mobileIconModule } = generator;
const result = generateMobileIcons();
const output = resolve(root, GENERATED_PATH);
writeFileSync(output, mobileIconModule(result));
const formatter = vitePlusCommand(["fmt", output]);
execFileSync(formatter.command, formatter.args, { cwd: root, stdio: "inherit" });
for (const [file, data] of [
  [values.json, result.glyphs],
  [values["sources-json"], result.sources],
  [values["legacy-json"], values["legacy-json"] ? legacyMobileIcons() : undefined],
] as const) {
  if (file) writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
console.log(`Generated ${Object.keys(result.glyphs).length} mobile glyphs → ${GENERATED_PATH}`);
