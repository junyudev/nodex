import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { browserRequestInput } from "./browser-cache-inputs.ts";
import { localInputReader } from "./test-cache-inputs.ts";
import { digest, fileHasher, findPass, savePass, workspaceInputs } from "./test-cache-store.ts";

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

  it("admits a pinned CDN file and rejects mutable URLs and service workers", () => {
    const pinned = "https://unpkg.com/@floating-ui/core@1.7.3/dist/core.js";
    expect(get(pinned)).toEqual({ kind: "external", input: pinned });
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
  const inputs = async () => {
    const workspace = await workspaceInputs(workspaceRoot);
    return {
      topology: workspace.topology,
      reader: localInputReader(workspaceRoot),
      identity: {
        "browser test files": digest(
          JSON.stringify(
            [...workspace.files].filter((file) => file.endsWith(".browser.test.ts")).sort(),
          ),
        ),
      },
    };
  };
  const lookup = async () => findPass(store, unit, key, fileHasher(workspaceRoot), await inputs());
  try {
    await Promise.all([
      put(unit, "config"),
      put(existing, "test"),
      put(used, "used"),
      put(unused, "initial"),
    ]);
    const before = await inputs();
    await savePass(store, unit, {
      globalKey: key,
      identity: before.identity,
      deps: { [unit]: digest("config"), [existing]: digest("test"), [used]: digest("used") },
      local: { topology: before.topology, probes: {}, globs: {} },
    });
    expect(await lookup()).toEqual({ kind: "hit" });
    await put(unused, "changed");
    expect(await lookup()).toEqual({ kind: "hit" });
    await put(used, "changed");
    expect(await lookup()).toEqual({ kind: "changed", inputs: [used] });
    await put(used, "used");
    await put(newTest, "new test");
    expect(await lookup()).toEqual({
      kind: "changed",
      inputs: ["browser test files", "workspace file names"],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
