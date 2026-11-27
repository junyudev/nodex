import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import type { TestModule } from "vite-plus/test/node";
import { mergePathLists, validationConcurrency } from "./check-changed.ts";
import { chooseCacheAudits } from "./test-cache-policy.ts";
import { dependencyReader, graphInputs, virtualModuleReason } from "./test-cache-graph.ts";
import type { TestEvidence } from "./test-cache-evidence.ts";
import { pathSnapshot } from "./test-observation.mts";
import { localInputReader } from "./test-cache-inputs.ts";
import {
  CorruptCachedPass,
  fileHasher,
  findPass,
  globalCacheKey,
  savePass,
  stampDigests,
  workspaceInputs,
} from "./test-cache-store.ts";

function testModule(
  root: string,
  file: string,
  {
    state = "passed",
    result = "passed",
    imports = [] as string[],
    sharedImports = {} as Record<string, readonly string[]>,
    resolveId = (request: string, importer: string) =>
      path.resolve(path.dirname(importer), request),
  } = {},
): TestModule {
  const moduleImports = { [path.join(root, file)]: imports, ...sharedImports };
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
      config: { plugins: [], resolve: { extensions: [".ts", ".tsx", ".js"] } },
      moduleGraph: {
        getModulesByFile: () => [],
        getModuleById: (id: string) =>
          Object.hasOwn(moduleImports, id)
            ? { id, importedModules: moduleImports[id].map((edge) => ({ id: edge, url: edge })) }
            : undefined,
      },
      pluginContainer: {
        getModuleInfo: () => undefined,
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
  it("explains misses using the closest pass under the current global key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex-cache-lookup-"));
    const file = "sample.test.ts";
    const asset = "kernel.wasm";
    const dependency = "dependency.ts";
    const lookup = (key = "key") => findPass(root, file, key, fileHasher(root));
    try {
      await writeInputs(root, { [file]: "test", [asset]: "old", [dependency]: "old" });
      expect(await lookup()).toEqual({ kind: "unrecorded" });
      await savePass(root, file, await passFor(root, [file, asset, dependency]));
      expect(await lookup("other")).toEqual({ kind: "globalKeyMiss" });
      expect(await lookup()).toEqual({ kind: "hit" });

      await writeFile(path.join(root, asset), "new bytes");
      await rm(path.join(root, dependency));
      expect(await lookup()).toEqual({ kind: "changed", inputs: [asset, dependency] });
      await writeFile(path.join(root, dependency), "new source");
      await savePass(root, file, await passFor(root, [file, asset, dependency]));
      await writeFile(path.join(root, asset), "newer bytes");
      expect(await lookup()).toEqual({ kind: "changed", inputs: [asset] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reruns with the new resolution and invalidates only the recorded fixture inputs", async () => {
    const repository = path.resolve(import.meta.dirname, "../..");
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nodex-cache-fixture-")));
    const testFile = "sample.test.ts";
    const existingSnapshotTest = "snapshot.test.ts";
    const usesLazyJson = "opens-catalog.test.ts";
    const usesRealModule = "uses-real-module.test.ts";
    const lazyJson = "locale.json";
    const fixture = "read.fixture";
    const spawns = "spawns.test.ts";
    const observationSetup = "./tooling/setup-test-observation.ts";
    const observationRunner = "./tooling/test-observation-runner.ts";
    const recorderSource = path.join(import.meta.dirname, "test-observation.mts");
    const observationPreload = pathToFileURL(recorderSource).href;
    const observations = path.join(root, "batch.local", "observations");
    const existingSnapshot = "__snapshots__/snapshot.test.ts.snap";
    const asset = "crates/nodex-search-kernel/generated/nodex_search_kernel_bg.wasm";
    const staging = path.join(root, "batch.local");
    const store = path.join(root, "store.local");
    const batchModule = pathToFileURL(path.join(import.meta.dirname, "run-cache-batch.mts")).href;
    async function run(files: readonly string[]) {
      await rm(observations, { recursive: true, force: true });
      const workspace = await workspaceInputs(root);
      await writeFile(
        path.join(staging, "batch.json"),
        JSON.stringify({
          files,
          workspace: [...workspace.files],
        }),
      );
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          "--input-type=module",
          "--eval",
          `
          import { runCacheBatch } from ${JSON.stringify(batchModule)};
          const evidence = await runCacheBatch(process.cwd(), ${JSON.stringify(staging)}, {
            config: "./fixture.config.ts", reporters: ["default"],
          });
          console.log("CACHE_EVIDENCE=" + JSON.stringify(evidence));
        `,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_ENV: "test",
            NODEX_TEST_OBSERVATIONS: observations,
            NODEX_TEST_OBSERVATION_ROOT: root,
          },
        },
      );
      const line = stdout.split("\n").find((value) => value.startsWith("CACHE_EVIDENCE="));
      const evidence = JSON.parse(line!.slice("CACHE_EVIDENCE=".length)) as TestEvidence[];
      return { stdout, evidence };
    }
    const lookup = async (file = testFile) =>
      findPass(store, file, "key", fileHasher(root), {
        topology: (await workspaceInputs(root)).topology,
        reader: localInputReader(root),
      });
    try {
      await mkdir(staging);
      await symlink(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
      const describeObservation = async (filename: string) =>
        (await readFile(path.join(import.meta.dirname, path.basename(filename)), "utf8")).replace(
          'require("./test-observation.mts")',
          () => `require(${JSON.stringify(recorderSource)})`,
        );
      await writeInputs(root, {
        [observationSetup]: await describeObservation(observationSetup),
        [observationRunner]: await describeObservation(observationRunner),
        "package.json": JSON.stringify({
          name: "cache-fixture",
          type: "module",
          exports: { "./schema/*.json": "./fixtures/*.json" },
        }),
        "fixture.config.ts": `export default { test: { maxWorkers: 2, environment: "node", pool: "threads",
          runner: ${JSON.stringify(observationRunner)}, sequence: { setupFiles: "list" },
          execArgv: ["--import", ${JSON.stringify(observationPreload)}],
          setupFiles: [${JSON.stringify(observationSetup)}, "./config/setup-search-kernel.ts"] } };`,
        [fixture]: "fixture bytes",
        [spawns]: `
          import { spawnSync } from "node:child_process";
          import { expect, test } from "vite-plus/test";
          test("spawns", () => expect(spawnSync(process.execPath, ["--version"]).status).toBe(0));
        `,
        [lazyJson]: '{"label":"hello"}',
        "catalog.ts": `
          export async function label(translated: boolean) {
            return translated ? (await import("./locale.json")).default.label : "default";
          }
        `,
        [usesLazyJson]: `
          import { expect, test } from "vite-plus/test";
          import { label } from "./catalog";
          test("reads the requested catalog", async () => expect(await label(true)).toBe("hello"));
        `,
        "service.ts": 'export { value } from "./real-service";',
        "real-service.ts": 'export const value = "implementation";',
        [usesRealModule]: `
          import { expect, test } from "vite-plus/test";
          import { value } from "./service";
          test("uses the real module", () => expect(value).toBe("implementation"));
        `,
        "foo/index.ts": 'export const value = "index";',
        "fixtures/package.json": '{"name":"nested-cache-fixture"}',
        "fixtures/first.ts": "export const first = 1;",
        "fixtures/schema.json": '{"version":1}',
        [testFile]: `
          import { expect, test } from "vite-plus/test";
          import { spawnSync } from "node:child_process";
          import { readFileSync } from "node:fs";
          import { vi } from "vite-plus/test";
          import { value as service } from "./service";
          vi.mock("./service", () => ({ value: "mock" }));
          import { value } from "./foo";
          import schema from "cache-fixture/schema/schema.json";
          import { label } from "./catalog";
          const inputs = import.meta.glob("./fixtures/*.ts");
          test("runs the selected module", async () => {
            expect(spawnSync).toBeTypeOf("function");
            expect(service).toBe("mock");
            expect(readFileSync("./read.fixture", "utf8")).toBe("fixture bytes");
            expect(await label(false)).toBe("default");
            expect(schema.version).toBe(1);
            expect(Object.keys(inputs)).toContain("./fixtures/first.ts");
            console.log("CACHE_RESOLUTION=" + value);
          });
        `,
        [existingSnapshotTest]: `
          import { expect, test } from "vite-plus/test";
          test("keeps a snapshot", () => expect("known").toMatchSnapshot());
        `,
        [existingSnapshot]:
          '// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html\n\nexports[`keeps a snapshot 1`] = `"known"`;\n',
      });
      for (const file of [
        asset,
        "config/setup-search-kernel.ts",
        "crates/nodex-search-kernel/wasm.ts",
        "crates/nodex-search-kernel/generated/nodex_search_kernel.js",
      ]) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await copyFile(path.join(repository, file), path.join(root, file));
      }
      const initial = await run([
        testFile,
        existingSnapshotTest,
        usesLazyJson,
        usesRealModule,
        spawns,
      ]);
      expect(initial.stdout).toContain("CACHE_RESOLUTION=index");
      expect(initial.evidence).toHaveLength(5);
      const alone = (await run([testFile])).evidence[0];
      const alongsideRealModule = initial.evidence.find(({ file }) => file === testFile);
      expect(alone?.deps).toBeDefined();
      expect(alone?.deps).not.toContain("real-service.ts");
      expect(alongsideRealModule).toMatchObject({ deps: alone?.deps, local: alone?.local });
      expect(initial.evidence.find(({ file }) => file === usesRealModule)?.deps).toContain(
        "real-service.ts",
      );
      expect(initial.evidence.find(({ file }) => file === spawns)?.exclusions).toEqual([
        { reason: "subprocess", input: process.execPath },
      ]);
      for (const entry of initial.evidence.filter(({ file }) => file !== spawns)) {
        expect(entry).toMatchObject({ passed: true });
        expect(entry.reason).toBeUndefined();
        expect(entry.exclusions).toBeUndefined();
        await savePass(store, entry.file, {
          ...(await passFor(root, entry.deps)),
          local: entry.local,
        });
      }
      expect(await lookup()).toEqual({ kind: "hit" });

      await writeInputs(root, { [fixture]: "edited fixture" });
      expect(await lookup()).toEqual({ kind: "changed", inputs: [fixture] });
      await writeInputs(root, { [fixture]: "fixture bytes" });

      await writeInputs(root, { "elsewhere.ts": "export const unrelated = true;" });
      expect(await lookup()).toEqual({ kind: "hit" });

      await writeInputs(root, { "foo.ts": 'export const value = "higher-priority";' });
      expect(await lookup()).toEqual({ kind: "changed", inputs: ["foo.ts"] });
      const rerun = await run([testFile]);
      expect(rerun.stdout).toContain("CACHE_RESOLUTION=higher-priority");
      expect(rerun.evidence[0]?.deps).toContain("foo.ts");
      await rm(path.join(root, "foo.ts"));

      await writeInputs(root, { "fixtures/second.ts": "export const second = 2;" });
      expect(await lookup()).toEqual({ kind: "changed", inputs: ["fixtures/*.ts"] });
      await rm(path.join(root, "fixtures/second.ts"));

      const addedSnapshot = "__snapshots__/sample.test.ts.snap";
      await writeInputs(root, { [addedSnapshot]: "// snapshot" });
      expect(await lookup()).toEqual({ kind: "changed", inputs: [addedSnapshot] });
      await rm(path.join(root, addedSnapshot));
      await rm(path.join(root, existingSnapshot));
      expect(await lookup(existingSnapshotTest)).toEqual({
        kind: "changed",
        inputs: [existingSnapshot],
      });

      await writeFile(path.join(root, lazyJson), '{"label":"edited"}');
      expect(await lookup()).toEqual({ kind: "hit" });
      expect(await lookup(usesLazyJson)).toEqual({ kind: "changed", inputs: [lazyJson] });

      await writeFile(path.join(root, asset), "different WASM bytes");
      expect(await lookup()).toEqual({ kind: "changed", inputs: [asset] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists stable content stamps and rehashes fresh writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex-cache-stamps-"));
    const source = path.join(root, "source.ts");
    const filename = path.join(root, "digest-cache.json");
    try {
      await writeFile(source, "first");
      const before = await stat(source, { bigint: true });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Number(before.ctimeNs / 1_000_000n));
      let initial: string | undefined;
      try {
        const fresh = stampDigests(filename);
        initial = await fresh.hash(source, before);
        await fresh.flush();
        await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });

        clock.mockReturnValue(Number(before.ctimeNs / 1_000_000n) + 2_000);
        const stable = stampDigests(filename);
        expect(await stable.hash(source, before)).toBe(initial);
        await stable.flush();
        const reopened = stampDigests(filename);
        expect(await reopened.hash(source, before)).toBe(initial);
      } finally {
        clock.mockRestore();
      }

      // A same-size edit needs a new digest even if the inode is unchanged.
      await writeFile(source, "other");
      expect(await fileHasher(root, stampDigests(filename))("source.ts")).not.toBe(initial);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays observed directory listings and absent paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex-cache-observed-"));
    const file = "sample.test.ts";
    const observed = (name: string, kind: "readdir" | "exists") => ({
      path: name,
      kind,
      evidence: pathSnapshot(path.join(root, name), kind, undefined),
    });
    const find = () =>
      findPass(path.join(root, "cache"), file, "key", fileHasher(root), {
        topology: "",
        reader: localInputReader(root),
      });
    try {
      await writeInputs(root, { [file]: "test", "fixtures/first.txt": "first" });
      const local = {
        probes: {},
        globs: {},
        observed: [observed("fixtures", "readdir"), observed("absent.txt", "exists")],
      };
      await savePass(path.join(root, "cache"), file, { ...(await passFor(root, [file])), local });
      expect(await find()).toEqual({ kind: "hit" });
      const reader = localInputReader(root);
      const transient = observed("transient.txt", "exists");
      const rejected = { probes: {}, globs: {}, observed: [transient] };
      expect(await reader.matches(transient)).toBe(true);
      await writeInputs(root, { "transient.txt": "written after lookup" });
      expect(await reader.unchanged([local])).toBe(true);
      expect(await reader.unchanged([local, rejected])).toBe(false);
      await writeInputs(root, { "fixtures/first.txt": "new bytes" });
      expect(await find()).toEqual({ kind: "hit" });
      await writeInputs(root, { "fixtures/second.txt": "second", "absent.txt": "present" });
      expect(await find()).toEqual({ kind: "changed", inputs: ["fixtures", "absent.txt"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("keeps watched and static inputs without borrowing another file's lazy imports", () => {
    const imports = [
      { id: "/repo/eager.ts", url: "/eager.ts" },
      { id: "/repo/lazy.ts", url: "/lazy.ts" },
      { id: "/repo/style.css", url: "/style.css" },
    ];
    expect(graphInputs(imports, ["/eager.ts"], ["/eager.ts", "/repo/lazy.ts"])).toEqual([
      "/repo/eager.ts",
      "/repo/style.css",
    ]);
  });

  it("keeps shared stylesheet edges only when the implementation may have loaded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex-cache-mocked-styles-"));
    const test = "card.test.ts";
    const component = "card.ts";
    const stylesheet = "card.css";
    const componentId = path.join(root, component);
    const files = {
      [test]: 'import "./card.ts";',
      [component]: 'import "./card.css";',
      [stylesheet]: "body { color: red; }",
    };
    try {
      await writeInputs(root, files);
      const cold = testModule(root, test);
      const warm = testModule(root, test, {
        sharedImports: { [componentId]: [path.join(root, stylesheet)] },
      });
      const read = dependencyReader(root, new Set(Object.keys(files)));
      const recorded = [componentId];
      const mocked = await read(warm, recorded, [componentId]);
      expect(mocked).toEqual(await read(cold, recorded, [componentId]));
      expect(mocked.deps).toEqual([test, component].sort());
      expect(mocked.local?.probes[component]).toBe("file");
      const loaded = await read(warm, recorded, []);
      expect(loaded.deps).toContain(stylesheet);
      expect(await read(warm, recorded)).toEqual(loaded);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
        const runtimeDependencies = [path.join(root, input)];
        const read = dependencyReader(root, new Set(Object.keys(files)));
        const evidence = await read(
          testModule(root, dependent, { imports: [runtimeEdge] }),
          runtimeDependencies,
        );
        expect(evidence.deps).toEqual([dependent, input].sort());
        await savePass(root, dependent, await passFor(root, evidence.deps));
        const unrelatedEvidence = await read(testModule(root, unrelated), []);
        await savePass(root, unrelated, await passFor(root, unrelatedEvidence.deps));
        expect(await findPass(root, dependent, "key", fileHasher(root))).toEqual({ kind: "hit" });
        await writeFile(path.join(root, input), source.replace("1", "2"));
        expect(await findPass(root, dependent, "key", fileHasher(root))).toEqual({
          kind: "changed",
          inputs: [input],
        });
        expect(await findPass(root, unrelated, "key", fileHasher(root))).toEqual({ kind: "hit" });
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
      const key = async () =>
        globalCacheKey(
          root,
          "renderer",
          {},
          "",
          await workspaceInputs(root),
          fileHasher(root),
          { versions: process.versions, platform: process.platform, arch: process.arch },
          undefined,
        );
      const original = await key();
      expect(original).toBeDefined();
      await writeFile(path.join(root, "unrelated.ts"), "export {};");
      expect(await key()).toBe(original);
      await writeFile(path.join(root, setup), "changed");
      const setupChanged = await key();
      expect(setupChanged).not.toBe(original);
      await writeFile(path.join(root, lock), "changed");
      expect(await key()).not.toBe(setupChanged);
      await symlink(path.join(root, setup), path.join(root, "tsconfig.linked.json"));
      expect(await key()).toBeUndefined();
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
