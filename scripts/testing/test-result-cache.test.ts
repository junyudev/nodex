import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { TestModule } from "vite-plus/test/node";
import { mergePathLists } from "./check-changed.ts";
import { validationConcurrency } from "./run-cached-tests.ts";
import { cacheReach, chooseCacheAudits, partitionCacheFiles } from "./test-cache-policy.ts";
import {
  builtinReason,
  dependencyReader,
  graphInputs,
  sourceReason,
  virtualModuleReason,
} from "./test-cache-graph.ts";
import {
  CorruptCachedPass,
  fileHasher,
  findPass,
  globalCacheKey,
  matchesPass,
  savePass,
  workspaceInputs,
} from "./test-cache-store.ts";

function testModule(
  root: string,
  file: string,
  {
    state = "passed",
    result = "passed",
    imports = [] as string[],
    resolveId = (request: string, importer: string) =>
      path.resolve(path.dirname(importer), request),
  } = {},
): TestModule {
  return {
    relativeModuleId: file,
    moduleId: path.join(root, file),
    state: () => state,
    children: {
      allSuites: () => [],
      allTests: () => [
        { diagnostic: () => ({ retryCount: 0 }), result: () => ({ state: result }) },
      ],
    },
    toTestSpecification: () => ({ project: { config: { setupFiles: [] } } }),
    viteEnvironment: {
      moduleGraph: {
        getModulesByFile: () => [],
        getModuleById: (id: string) =>
          id === path.join(root, file)
            ? { importedModules: imports.map((edge) => ({ id: edge, url: edge })) }
            : undefined,
      },
      pluginContainer: {
        resolveId: (request: string, importer: string) =>
          Promise.resolve({ id: resolveId(request, importer) }),
      },
    },
  } as unknown as TestModule;
}

async function writeInputs(root: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([file, source]) => {
      const absolute = path.join(root, file);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, source);
    }),
  );
}

async function passFor(root: string, inputs: readonly string[] = []) {
  const hash = fileHasher(root);
  return {
    globalKey: "key",
    deps: Object.fromEntries(
      await Promise.all(inputs.map(async (input) => [input, (await hash(input))!] as const)),
    ),
  };
}

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

  it("checks tooling inputs through the graph and keeps native preparation uncached", () => {
    const pure = "scripts/generated-code-string.test.ts";
    const native = "packages/mobile/src/native-tests/pinned-http.test.ts";
    expect(partitionCacheFiles("unit", [pure, native])).toEqual({
      cacheable: [pure],
      uncached: [native],
    });
    expect(
      sourceReason(pure, 'import { serialize } from "./generated-code-string.mjs";'),
    ).toBeUndefined();
    expect(sourceReason("config/tool.test.ts", 'import { build } from "vite";')).toBe(
      "tooling dependency",
    );
    expect(sourceReason(pure, 'import { readFileSync } from "node:fs";')).toBe("Node builtin fs");
    expect(sourceReason(pure, "const root = process.env.PROFILE;")).toBe("ambient tooling inputs");
  });

  it("recognizes only the locked Oxc virtual helper", () => {
    expect(
      virtualModuleReason("\0@oxc-project+runtime@0.155.0/helpers/esm/usingCtx.js"),
    ).toBeUndefined();
    expect(virtualModuleReason("\0@oxc-project+runtime@0.155.0/helpers/esm/other.js")).toBe(
      "virtual module",
    );
    expect(virtualModuleReason("virtual:unknown")).toBe("virtual module");
  });

  it("records a jsdom worker URL, its entry and transitive static imports", async () => {
    const owner = "src/renderer/lib/highlight-pool.tsx";
    const worker = "src/renderer/lib/highlight.worker.ts";
    const helper = "src/renderer/lib/worker-helper.ts";
    const dependent = "src/renderer/lib/highlight.test.tsx";
    const unrelated = "src/renderer/lib/other.test.tsx";
    const files = {
      [dependent]: "",
      [unrelated]: "",
      [owner]:
        'import highlightWorkerUrl from "./highlight.worker.ts?worker&url"; new Worker(highlightWorkerUrl, { type: "module", name: profile.name });',
      [worker]: 'export { run } from "./worker-helper";',
      [helper]: "export const run = 1;",
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex-cache-worker-"));
    try {
      await writeInputs(root, files);
      const module = testModule(root, dependent, {
        resolveId: (request, importer) =>
          path.resolve(
            path.dirname(importer),
            request === "./worker-helper" ? "worker-helper.ts" : request,
          ),
      });
      const project = { modules: [owner], files: { [dependent]: [0], [unrelated]: [] } };
      const workspace = new Set(Object.keys(files));
      const read = dependencyReader(root, workspace, true);
      const evidence = await read(module, project);
      expect(evidence.deps).toEqual([worker, dependent, owner, helper].sort());
      expect((await dependencyReader(root, workspace)(module, project)).reason).toBe(
        "external execution",
      );
      expect(
        (await read(testModule(root, dependent, { state: "failed" }), project)).deps,
      ).toBeUndefined();
      expect(
        (await read(testModule(root, dependent, { result: "skipped" }), project)).deps,
      ).toBeUndefined();

      const unrelatedEvidence = await read(testModule(root, unrelated), project);
      await savePass(root, dependent, await passFor(root, evidence.deps));
      await savePass(root, unrelated, await passFor(root, unrelatedEvidence.deps));
      expect(await findPass(root, dependent, "key", fileHasher(root))).toBe(true);
      await writeFile(path.join(root, helper), "export const run = 2;");
      expect(await findPass(root, dependent, "key", fileHasher(root))).toBe(false);
      expect(await findPass(root, unrelated, "key", fileHasher(root))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      dependent: "src/renderer/lib/presentation.test.tsx",
      input: "src/renderer/lib/local-structural-transaction-presentation.ts",
      source: "class Local { run() { return this.require(); } private require() { return 1; } }",
      runtimeEdge: "\0@oxc-project+runtime@0.155.0/helpers/esm/usingCtx.js",
    },
    {
      dependent: "scripts/generated-code-string.test.ts",
      input: "scripts/generated-code-string.mjs",
      source: "export const generated = 1;",
      runtimeEdge: "node:buffer",
    },
  ])(
    "tracks the workspace dependency for $dependent",
    async ({ dependent, input, source, runtimeEdge }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "nodex-cache-input-"));
      const unrelated = "src/shared/other.test.ts";
      const files = { [dependent]: "", [unrelated]: "", [input]: source };
      try {
        await writeInputs(root, files);
        const project = { modules: [input], files: { [dependent]: [0], [unrelated]: [] } };
        const read = dependencyReader(root, new Set(Object.keys(files)));
        const evidence = await read(
          testModule(root, dependent, { imports: [runtimeEdge] }),
          project,
        );
        expect(evidence.deps).toEqual([dependent, input].sort());
        const pass = await passFor(root, evidence.deps);
        const independentPass = await passFor(
          root,
          (await read(testModule(root, unrelated), project)).deps,
        );
        expect(await matchesPass(pass, "key", dependent, fileHasher(root))).toBe(true);
        await writeFile(path.join(root, input), source.replace("1", "2"));
        expect(await matchesPass(pass, "key", dependent, fileHasher(root))).toBe(false);
        expect(await matchesPass(independentPass, "key", unrelated, fileHasher(root))).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("includes the lock and setup files in the global key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex-cache-globals-"));
    try {
      await mkdir(path.join(root, "node_modules/.pnpm"), { recursive: true });
      await mkdir(path.join(root, "src/renderer/test"), { recursive: true });
      const setup = "src/renderer/test/setup.ts";
      const lock = "pnpm-lock.yaml";
      await Promise.all(
        [setup, lock, "node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"].map((file) =>
          writeFile(path.join(root, file), "initial"),
        ),
      );
      const workspace = await workspaceInputs(root);
      const key = () => globalCacheKey(root, "renderer", {}, "", workspace, fileHasher(root));
      const original = await key();
      expect(original).toBeDefined();
      await writeFile(path.join(root, setup), "changed");
      const setupChanged = await key();
      expect(setupChanged).not.toBe(original);
      await writeFile(path.join(root, lock), "changed");
      expect(await key()).not.toBe(setupChanged);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flags a record whose bytes disagree with its digest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex-cache-corrupt-"));
    try {
      const file = "sample.test.ts";
      await writeFile(path.join(root, file), "source");
      const hash = fileHasher(root);
      await savePass(root, file, { globalKey: "key", deps: { [file]: (await hash(file))! } });
      const [directory] = await readdir(root, { withFileTypes: true }).then((entries) =>
        entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      );
      const [record] = await readdir(path.join(root, directory));
      await writeFile(path.join(root, directory, record), "corrupted");
      await expect(findPass(root, file, "key", hash)).rejects.toBeInstanceOf(CorruptCachedPass);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("weights cache reach by elapsed file time and counts only measured files", () => {
    expect(
      cacheReach(["slow", "fast", "unknown"], new Set(["fast"]), { slow: 90, fast: 10 }),
    ).toEqual({
      timed: 2,
      timeShare: 0.1,
    });
  });

  it("selects unique hits reproducibly for one run and rotates the selection", () => {
    const hits = ["a", "b", "c", "d"];
    const first = chooseCacheAudits(hits, "first", {}, 2);
    expect(first).toHaveLength(2);
    expect(new Set(first).size).toBe(2);
    expect(first.every((file) => hits.includes(file))).toBe(true);
    expect(chooseCacheAudits([...hits.toReversed(), "a"], "first", {}, 2)).toEqual(first);
    expect(
      new Set(Array.from({ length: 16 }, (_, seed) => chooseCacheAudits(hits, String(seed))[0])),
    ).toEqual(new Set(hits));
    expect(chooseCacheAudits(hits, "first", { a: 100, b: 100, c: 0, d: 100 })).toEqual(["c"]);
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
