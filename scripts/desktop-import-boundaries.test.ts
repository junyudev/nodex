import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { auditDesktopImportBoundaries } from "./desktop-import-boundaries";

const roots: string[] = [];

function fixture(files: Readonly<Record<string, string | Uint8Array>>): string {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-desktop-imports-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Desktop import boundaries", () => {
  test("accepts a binary Markdown asset without executing Main or writing output", async () => {
    const root = fixture({
      "bootstrap.ts": `import wasm from "./runtime.wasm?asset";
        throw new Error(wasm);`,
      "runtime.wasm": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    });

    expect(await auditDesktopImportBoundaries(path.join(root, "bootstrap.ts"))).toEqual([]);
    expect(existsSync(path.join(root, ".boundary-audit"))).toBe(false);
  });

  test("still rejects transitive and lazy Document authority beside binary assets", async () => {
    const root = fixture({
      "bootstrap.ts": `import wasm from "./runtime.wasm?asset";
        import "./nested/bridge";
        export const legacy = () => import("./nested/document-operation-engine");
        console.log(wasm);`,
      "runtime.wasm": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      "nested/bridge.ts": `import "yjs"; import "yjs/dist/yjs.mjs";`,
      "nested/document-operation-engine.ts": `import "./block-document-codec";`,
      "nested/block-document-codec.ts": `export const retired = true;`,
    });

    const failures = await auditDesktopImportBoundaries(path.join(root, "bootstrap.ts"));
    expect(failures).toEqual([
      expect.stringContaining("Desktop bootstrap transitively imports Yjs from"),
      expect.stringContaining("Desktop bootstrap transitively imports Yjs from"),
      expect.stringMatching(/retired Document authority: .*block-document-codec\.ts$/),
      expect.stringMatching(/retired Document authority: .*document-operation-engine\.ts$/),
    ]);
  });

  test("fails closed when an imported asset cannot be resolved", async () => {
    const root = fixture({ "bootstrap.ts": `import "./missing.wasm?asset";` });

    await expect(auditDesktopImportBoundaries(path.join(root, "bootstrap.ts"))).rejects.toThrow(
      "Could not resolve",
    );
  });
});
