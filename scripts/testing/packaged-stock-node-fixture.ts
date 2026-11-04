import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const contents = "export const fixture = true;\n";
export const packagedStockNodeFixtureOutputs = [
  ["out/agent-runtime/entry.mjs", "agent-runtime/entry.mjs"],
  ["out/main/app-tools/server.mjs", "app-tools/server.mjs"],
].map(([source, destination]) => ({
  executable: false,
  path: source!,
  destination: destination!,
  size: Buffer.byteLength(contents),
  sha256: createHash("sha256").update(contents).digest("hex"),
}));

/** Minimal physical closure for tests of packaged manifests and layout validation. */
export function writePackagedStockNodeFixture(resourcesPath: string): void {
  for (const output of packagedStockNodeFixtureOutputs) {
    const file = join(resourcesPath, output.destination);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  const archivePath = join(resourcesPath, "app.asar");
  if (!existsSync(archivePath)) {
    const header = Buffer.from(
      JSON.stringify({
        files: {
          out: { files: { main: { files: { "bootstrap.js": { size: 0, offset: "0" } } } } },
          "package.json": { size: 0, offset: "0" },
        },
      }),
    );
    const preamble = Buffer.alloc(16);
    preamble.writeUInt32LE(header.length, 12);
    writeFileSync(archivePath, Buffer.concat([preamble, header]));
  }
  const manifest = join(resourcesPath, "prepared-electron-build.json");
  if (!existsSync(manifest))
    writeFileSync(manifest, JSON.stringify({ outputs: packagedStockNodeFixtureOutputs }));
}
