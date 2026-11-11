import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { mergePathLists } from "./check-changed.ts";
import { validationConcurrency } from "./run-cached-tests.ts";
import { chooseCacheAudits, partitionCacheFiles } from "./test-cache-policy.ts";
import { builtinReason, graphInputs, sourceReason } from "./test-cache-graph.ts";
import { matchesPass, workspaceInputs } from "./test-cache-store.ts";

describe("test result cache", () => {
  it("requires the global key and each dependency to match", async () => {
    const file = "src/shared/example.test.ts";
    const current: Record<string, string> = {
      [file]: "test",
      "src/shared/dependency.ts": "source",
    };
    const pass = { globalKey: "global", deps: { ...current } };
    const hash = (dependency: string) => Promise.resolve(current[dependency]);
    expect(await matchesPass(pass, "global", file, hash)).toBe(true);
    expect(await matchesPass(pass, "other", file, hash)).toBe(false);
    current["src/shared/dependency.ts"] = "changed";
    expect(await matchesPass(pass, "global", file, hash)).toBe(false);
    delete current["src/shared/dependency.ts"];
    expect(await matchesPass(pass, "global", file, hash)).toBe(false);
    expect(await matchesPass({ ...pass, deps: {} }, "global", file, hash)).toBe(false);
  });

  it("shares workspace identity across checkouts with different local artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex-cache-topology-"));
    try {
      await writeFile(path.join(root, "example.ts"), "export const example = true;");
      const clean = await workspaceInputs(root);
      const local = path.join(root, "extra.local");
      await mkdir(local);
      await writeFile(path.join(local, "package.json"), "{}");
      expect(await workspaceInputs(root)).toEqual(clean);

      await writeFile(path.join(root, "new-source.ts"), "export const added = true;");
      expect((await workspaceInputs(root)).topology).not.toEqual(clean.topology);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes I/O and opaque module loading from the cache", () => {
    for (const builtin of [
      "fs/promises",
      "node:module",
      "node:sqlite",
      "https",
      "worker_threads",
    ]) {
      expect(builtinReason(builtin)).toBeDefined();
    }
    expect(sourceReason("source.ts", 'export { readFile } from "node:fs";')).toBe(
      "Node builtin fs",
    );
    expect(sourceReason("source.ts", 'await import("node:child_process");')).toBe(
      "Node builtin child_process",
    );
    expect(sourceReason("source.ts", "await import(name);")).toBe("computed import");
    expect(sourceReason("source.ts", 'import path from "node:path";')).toBeUndefined();
  });

  it("keeps watched and glob inputs without borrowing another file's lazy imports", () => {
    const imports = [
      { id: "/repo/eager.ts", url: "/eager.ts" },
      { id: "/repo/lazy.ts", url: "/lazy.ts" },
      { id: "/repo/style.css", url: "/style.css" },
    ];
    const transform = { deps: ["/eager.ts"], dynamicDeps: ["/eager.ts", "/lazy.ts"] };
    expect(graphInputs(imports, transform, false)).toEqual(["/repo/eager.ts", "/repo/style.css"]);
    expect(graphInputs(imports, transform, true)).toEqual(imports.map(({ id }) => id));
  });

  it("keeps tooling and native tests on the uncached runner", () => {
    const cacheable = "src/shared/markdown.test.ts";
    const tooling = "scripts/build-blocknote.test.ts";
    const native = "packages/mobile/src/native-tests/pinned-http.test.ts";
    expect(partitionCacheFiles("unit", [cacheable, tooling, native])).toEqual({
      cacheable: [cacheable],
      uncached: [native, tooling],
    });
  });

  it("selects unique hits reproducibly for one run and rotates the selection", () => {
    const hits = ["a", "b", "c", "d"];
    const first = chooseCacheAudits(hits, "first", 2);
    expect(first).toHaveLength(2);
    expect(new Set(first).size).toBe(2);
    expect(first.every((file) => hits.includes(file))).toBe(true);
    expect(chooseCacheAudits([...hits.toReversed(), "a"], "first", 2)).toEqual(first);
    expect(
      new Set(Array.from({ length: 16 }, (_, seed) => chooseCacheAudits(hits, String(seed))[0])),
    ).toEqual(new Set(hits));
    expect(chooseCacheAudits([], "empty")).toEqual([]);
  });
});

describe("changed checks", () => {
  it("merges tracked and untracked paths without splitting unusual names", () => {
    expect(mergePathLists("b c.ts\0gone.ts\0", "a\nb.ts\0b c.ts\0", "")).toEqual([
      "a\nb.ts",
      "b c.ts",
      "gone.ts",
    ]);
  });

  it("sizes concurrent tasks from the tighter resource", () => {
    const GiB = 1024 ** 3;
    expect(validationConcurrency(4, 64 * GiB)).toBe(2);
    expect(validationConcurrency(12, 16 * GiB)).toBe(2);
    expect(validationConcurrency(1, 2 * GiB)).toBe(1);
  });
});
