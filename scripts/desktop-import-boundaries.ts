import path from "node:path";
import { build } from "esbuild";

const retiredDocumentAuthorityInputs = ["document-operation-engine.ts", "block-document-codec.ts"];

/** Inspect the complete Desktop source graph without executing it or writing a build. */
export async function auditDesktopImportBoundaries(entryPoint: string): Promise<readonly string[]> {
  const bundle = await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    // Main imports the Markdown runtime as an Electron asset. Keep its bytes in
    // the graph while leaving packaging and initialization to the real build.
    loader: { ".wasm": "file" },
    outdir: path.join(path.dirname(entryPoint), ".boundary-audit"),
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const failures: string[] = [];
  for (const [input, metadata] of Object.entries(bundle.metafile.inputs)) {
    const normalizedInput = input.replaceAll("\\", "/");
    for (const retiredInput of retiredDocumentAuthorityInputs) {
      if (normalizedInput.endsWith(`/${retiredInput}`)) {
        failures.push(
          `Desktop bootstrap transitively includes retired Document authority: ${input}`,
        );
      }
    }
    for (const imported of metadata.imports) {
      if (imported.path === "yjs" || imported.path.startsWith("yjs/")) {
        failures.push(`Desktop bootstrap transitively imports Yjs from ${input}`);
      }
    }
  }
  return failures;
}
