import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { browserRequestInput } from "./browser-cache-inputs.ts";
import { memoizeSuite, type CachedSuiteReport } from "./run-cached-tests.ts";
import { digest, fileHasher, workspaceInputs } from "./test-cache-store.ts";

const origin = "http://localhost:63315";
const root = path.resolve("browser-workspace");
const served = "src/renderer/probe worker.ts";
const optimized = path.join(root, "node_modules/.vite/deps/tool.js");
const requestInputs = {
  root,
  origins: new Set([origin]),
  files: new Set([served, "public/logo.svg"]),
  isOptimized: (file: string) => file === optimized,
  publicDir: path.join(root, "public"),
};
const viteFs = (file: string) => "/@fs/" + file.split(path.sep).join("/");
const get = (url: string) => browserRequestInput({ url, method: "GET" }, requestInputs);

describe("browser request inputs", () => {
  it("maps Vite paths, workers, public assets and optimized modules", () => {
    expect(get(origin + "/src/renderer/probe%20worker.ts?worker_file&type=module")).toEqual({
      kind: "file",
      input: served,
    });
    expect(get(origin + viteFs(root) + "/src/renderer/probe%20worker.ts?v=123")).toEqual({
      kind: "file",
      input: served,
    });
    expect(
      get(
        origin +
          "/" +
          root.split(path.sep).join("/").replace(/^\//u, "") +
          "/src/renderer/probe%20worker.ts?t=1",
      ),
    ).toEqual({
      kind: "file",
      input: served,
    });
    expect(get(origin + "/logo.svg")).toEqual({ kind: "file", input: "public/logo.svg" });
    expect(get(origin + viteFs(optimized) + "?v=123")).toEqual({ kind: "install" });
    expect(get(origin + "/src/renderer/missing.ts")).toMatchObject({ kind: "opaque" });
  });

  it("rejects external responses and service workers", () => {
    const pinned = "https://unpkg.com/@floating-ui/core@1.7.3/dist/core.js";
    expect(get(pinned)).toMatchObject({
      kind: "opaque",
      exclusion: { reason: "external browser request" },
    });
    expect(get("https://unpkg.com/@floating-ui/core@^1.7/dist/core.js")).toEqual({
      kind: "opaque",
      exclusion: {
        reason: "external browser request",
        input: "https://unpkg.com/@floating-ui/core@%5E1.7/dist/core.js",
      },
    });
    expect(get("https://example.test/framework@1.2.3/dist/index.js")).toMatchObject({
      kind: "opaque",
    });
    expect(
      browserRequestInput({ url: pinned, method: "GET", serviceWorker: true }, requestInputs),
    ).toMatchObject({ kind: "opaque", exclusion: { reason: "service worker" } });
  });
});

it("restores one browser pass only while its collection and inputs still match", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nodex-browser-cache-test-"));
  const workspaceRoot = path.join(directory, "worktree");
  const store = path.join(directory, "store");
  const unit = "config/vitest.browser.config.ts";
  const existing = "src/renderer/existing.browser.test.ts";
  const newTest = "src/renderer/new.browser.test.ts";
  const used = "src/renderer/used.ts";
  const unused = "unrelated.md";
  const key = "browser";
  const put = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(workspaceRoot, file)), { recursive: true });
    await writeFile(path.join(workspaceRoot, file), content);
  };
  let runs = 0;
  let report: CachedSuiteReport | undefined;
  const run = async (files = [existing]) => {
    const code = await memoizeSuite(
      "browser",
      {
        units: [{ id: unit, files }],
        globalKey: digest(JSON.stringify([key, files])),
        directory: store,
        workspace: await workspaceInputs(workspaceRoot),
        hash: fileHasher(workspaceRoot),
        browser: true,
        stable: async () => true,
      },
      {
        repositoryRoot: workspaceRoot,
        env: {},
        signal: new AbortController().signal,
        onStdout: () => {},
        onReport: (result) => {
          report = result;
        },
      },
      performance.now(),
      async () => {
        throw new Error("unexpected fallback");
      },
      async (batch) => {
        runs++;
        expect(batch).toEqual(files);
        return {
          started: Number.MAX_SAFE_INTEGER,
          exitCode: 0,
          evidence: [
            {
              file: unit,
              passed: true,
              deps: [unit, ...files, used],
              local: { probes: {}, globs: {} },
              broadTopology: true,
            },
          ],
        };
      },
      false,
    );
    expect(code).toBe(0);
  };
  try {
    await Promise.all([
      put(unit, "config"),
      put(existing, "test"),
      put(used, "used"),
      put(unused, "initial"),
    ]);
    await run();
    expect(report).toMatchObject({ hits: 0, ran: 1, selected: 1, cacheable: 1, uncacheable: [] });
    await put(unused, "changed");
    await run();
    expect(report).toMatchObject({ hits: 1, ran: 0, selected: 1 });
    expect(runs).toBe(1);
    await put(used, "changed");
    await run();
    expect(report).toMatchObject({ hits: 0, ran: 1, missCauses: [{ input: used, count: 1 }] });
    await put(newTest, "new test");
    await run([existing, newTest]);
    expect(report).toMatchObject({ hits: 0, ran: 2, globalKeyMisses: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
