import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import { resolveConfig, type Plugin, type TransformResult } from "vite";
import { createRendererVitePlugins } from "./renderer-vite-shared";

const transform = async (plugin: Plugin, code: string, id: string, ssr = false) => {
  const hook = plugin.transform;
  if (!hook) throw new Error(`Missing transform hook: ${plugin.name}`);
  return (await Reflect.apply(
    typeof hook === "function" ? hook : hook.handler,
    { environment: { name: ssr ? "ssr" : "client" } },
    [code, id, { ssr }],
  )) as TransformResult;
};

async function initializeCompilerEnvironment(plugin: Plugin) {
  if (!plugin.applyToEnvironment) throw new Error("Missing Babel environment hook");
  await Reflect.apply(plugin.applyToEnvironment, {}, [
    { name: "client", config: { consumer: "client" } },
  ]);
}

test("skips Babel outside the compiler boundary while retaining native React transforms", async () => {
  const config = await resolveConfig(
    { configFile: false, logLevel: "silent", plugins: await createRendererVitePlugins() },
    "serve",
  );
  const babel = config.plugins.find((plugin) => plugin.name === "@rolldown/plugin-babel");
  if (!babel) throw new Error("Missing compiler Babel plugin");

  await initializeCompilerEnvironment(babel);

  for (const path of [
    "src/shared/values.ts",
    "third_party/blocknote/Component.tsx",
    "src/renderer/features/Component.test.tsx",
  ]) {
    expect(
      await transform(babel, "export const value: number = 1;", resolve(path)),
    ).toBeUndefined();
  }
  expect(config.optimizeDeps.include).toContain("react/compiler-runtime");
  expect(config.oxc).toMatchObject({ jsx: { refresh: true } });
  const oxc = config.oxc;
  if (
    !oxc ||
    !(oxc.jsxRefreshInclude instanceof RegExp) ||
    !(oxc.jsxRefreshExclude instanceof RegExp)
  )
    throw new Error("Expected native React refresh filters");
  const workspaceComponent = resolve("third_party/blocknote/Component.tsx");
  expect(oxc.jsxRefreshInclude.test(workspaceComponent)).toBe(true);
  expect(oxc.jsxRefreshExclude.test(workspaceComponent)).toBe(false);
  expect(oxc.jsxRefreshExclude.test(resolve("node_modules/package/Component.tsx"))).toBe(true);
});

test("compiles components and hooks through the real Babel hook and preserves coverage", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "nodex-renderer-compiler-"));
  try {
    const config = await resolveConfig(
      { configFile: false, logLevel: "silent", plugins: await createRendererVitePlugins(root) },
      "serve",
    );
    const coverage = config.plugins.find(
      (plugin) => plugin.name === "nodex:renderer-compiler-coverage",
    );
    const babel = config.plugins.find((plugin) => plugin.name === "@rolldown/plugin-babel");
    if (!coverage || !babel) throw new Error("Missing renderer compiler plugins");
    await initializeCompilerEnvironment(babel);
    const inputs = [
      [
        "Greeting.tsx",
        "export function Greeting({ name }: { name: string }) { return <span>{name}</span>; }",
        "Greeting",
      ],
      [
        "use-value.ts",
        'import { useState } from "react"; export function useValue(value: string) { const [selected] = useState(value); return { selected }; }',
        "useValue",
      ],
    ] as const;
    for (const [filename, code] of inputs) {
      const id = resolve(root, "src/renderer", filename);
      await transform(coverage, code, id);
      expect(await transform(babel, code, id)).toMatchObject({
        code: expect.any(String),
        map: expect.objectContaining({ sources: [filename], sourcesContent: [code] }),
      });
    }
    const ssrId = resolve(root, "src/renderer/server-probe.tsx");
    await transform(coverage, inputs[0][1], ssrId, true);
    expect(await transform(babel, inputs[0][1], ssrId, true)).toBeUndefined();

    const close = coverage.closeBundle;
    if (!close) throw new Error("Missing compiler coverage finalizer");
    await Reflect.apply(typeof close === "function" ? close : close.handler, {}, []);
    const report = JSON.parse(
      await readFile(resolve(root, ".generated/react-compiler/serve-development.json"), "utf8"),
    );
    expect(report.noEmit).toBe(false);
    for (const [filename, , fnName] of inputs) {
      const entry = report.files[`src/renderer/${filename}`];
      expect(entry.transform).toBe("client");
      expect(entry.events).toContainEqual(
        expect.objectContaining({ kind: "CompileSuccess", fnName }),
      );
    }
    expect(report.ssrFiles["src/renderer/server-probe.tsx"]).toMatchObject({
      transform: "ssr",
      events: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reuses compiler output across dev servers and invalidates changed source or configuration", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "nodex-renderer-compiler-cache-"));
  const filename = "src/renderer/Greeting.tsx";
  const code =
    "export function Greeting({ name }: { name: string }) { return <span>{name}</span>; }";
  const compile = async (source: string, command: "serve" | "build" = "serve") => {
    const config = await resolveConfig(
      { configFile: false, logLevel: "silent", plugins: await createRendererVitePlugins(root) },
      command,
    );
    const coverage = config.plugins.find(
      (plugin) => plugin.name === "nodex:renderer-compiler-coverage",
    );
    const babel = config.plugins.find((plugin) => plugin.name === "@rolldown/plugin-babel");
    if (!coverage || !babel || !coverage.closeBundle)
      throw new Error("Missing renderer compiler plugins");
    await initializeCompilerEnvironment(babel);
    await transform(coverage, source, resolve(root, filename));
    const result = await transform(babel, source, resolve(root, filename));
    const close = coverage.closeBundle;
    await Reflect.apply(typeof close === "function" ? close : close.handler, {}, []);
    const report = JSON.parse(
      await readFile(
        resolve(root, `.generated/react-compiler/${command}-development.json`),
        "utf8",
      ),
    );
    return { result, coverage: report.files[filename] };
  };
  try {
    const initial = await compile(code);
    expect(initial.coverage.cache).toBe("miss");
    expect(initial.coverage.events).toContainEqual(
      expect.objectContaining({ kind: "CompileSuccess", fnName: "Greeting" }),
    );
    const restarted = await compile(code);
    expect(restarted.result).toEqual(initial.result);
    expect(restarted.coverage.events).toEqual(initial.coverage.events);
    expect(restarted.coverage.cache).toBe("hit");

    const changed = await compile(
      code.replace("<span>", "<strong>").replace("</span>", "</strong>"),
    );
    expect(changed.coverage.cache).toBe("miss");
    expect(changed.result).not.toEqual(initial.result);
    expect((await compile(code)).coverage.cache).toBe("miss");
    expect((await compile(code)).coverage.cache).toBe("hit");

    await writeFile(resolve(root, "pnpm-lock.yaml"), "changed dependency graph");
    expect((await compile(code)).coverage.cache).toBe("miss");
    await mkdir(resolve(root, "config"));
    await writeFile(
      resolve(root, "config/renderer-vite-shared.ts"),
      "changed compiler configuration",
    );
    expect((await compile(code)).coverage.cache).toBe("miss");

    const directory = resolve(root, ".generated/react-compiler/cache");
    const [cacheFile] = await readdir(directory);
    await writeFile(resolve(directory, cacheFile), "interrupted write");
    const repaired = await compile(code);
    expect(repaired.coverage.cache).toBe("miss");
    expect(repaired.result).toEqual(initial.result);
    expect((await compile(code, "build")).coverage.cache).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
