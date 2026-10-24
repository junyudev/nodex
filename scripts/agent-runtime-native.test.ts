import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  agentRuntimeNativeBuildEnvironment,
  materializeAgentRuntimeNative,
} from "./agent-runtime-native";
import { readBrowserRuntimeSourceManifest } from "./stage-browser-runtime";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("./stage-browser-runtime", () => ({
  readBrowserRuntimeSourceManifest: vi.fn(),
  assertBrowserRuntimeSourceClosure: vi.fn(),
}));
const roots: string[] = [];
let builds = 0;
let failLoad = false;
const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
beforeEach(() => {
  builds = 0;
  failLoad = false;
  vi.mocked(readBrowserRuntimeSourceManifest).mockReturnValue({
    targetPlatform: process.platform,
    targetArch: process.arch,
    entrypoints: { node: "bin/node" },
    runtimeVersions: { node: "24.21.0" },
  } as ReturnType<typeof readBrowserRuntimeSourceManifest>);
  vi.mocked(execFileSync).mockImplementation((_command, args, options) => {
    if (args?.[0] === "-p")
      return JSON.stringify({
        version: "24.21.0",
        modules: "137",
        napi: "10",
        platform: process.platform,
        architecture: process.arch,
      });
    if (args?.includes("rebuild")) {
      builds += 1;
      const source = String(options?.cwd);
      expect(readFileSync(join(source, "src/pty.cc"), "utf8")).toContain("source");
      expect(() => readFileSync(join(source, "build/Release/pty.node"))).toThrow();
      write(join(source, "build/Release/pty.node"), `runtime-addon-${builds}`);
      write(join(source, "build/Release/spawn-helper"), "helper");
    }
    if (args?.[0] === "-e" && failLoad) throw new Error("native load failed");
    return "test toolchain";
  });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-native-test-"));
  roots.push(root);
  for (const [file, contents] of Object.entries({
    "package.json": "{}",
    "pnpm-lock.yaml": "locked",
    ".generated/codex-runtime/agent-runtime/browser-runtime/bin/node": "staged-node",
    "node_modules/node-pty/package.json": '{"name":"node-pty","version":"1.1.0"}',
    "node_modules/node-pty/src/pty.cc": "source",
    "node_modules/node-pty/lib/index.js": "module.exports = {}",
    "node_modules/node-pty/LICENSE": "MIT",
    "node_modules/node-pty/build/Release/pty.node": "electron-addon",
    "node_modules/node-pty/node_modules/node-addon-api/package.json": '{"name":"node-addon-api"}',
    "node_modules/node-pty/node_modules/node-addon-api/napi.h": "source-header",
    "node_modules/node-gyp/package.json": '{"name":"node-gyp"}',
    "node_modules/node-gyp/bin/node-gyp.js": "compiler",
  }))
    write(join(root, file), contents);
  return root;
};
test("builds only a private source clone with the staged Node and reuses a verified closure", () => {
  const root = fixture();
  const first = materializeAgentRuntimeNative(root);
  expect(readFileSync(join(first.packageRoot, "build/Release/pty.node"), "utf8")).toBe(
    "runtime-addon-1",
  );
  expect(readFileSync(join(root, "node_modules/node-pty/build/Release/pty.node"), "utf8")).toBe(
    "electron-addon",
  );
  expect(materializeAgentRuntimeNative(root)).toEqual(first);
  expect(builds).toBe(1);
  const build = vi.mocked(execFileSync).mock.calls.find((call) => call[1]?.includes("rebuild"));
  expect(build?.[0]).toBe(first.node.executable);
  expect(build?.[1]).toContain("--target=24.21.0");
});
test.each([
  "node_modules/node-pty/src/pty.cc",
  ".generated/codex-runtime/agent-runtime/browser-runtime/bin/node",
  "node_modules/node-gyp/bin/node-gyp.js",
])("invalidates changed native input %s", (file) => {
  const root = fixture();
  const first = materializeAgentRuntimeNative(root);
  write(join(root, file), "changed source");
  expect(materializeAgentRuntimeNative(root).identity).not.toBe(first.identity);
  expect(builds).toBe(2);
});
test("repairs corrupted private artifacts and preserves the last output on failed replacement", () => {
  const root = fixture();
  const first = materializeAgentRuntimeNative(root);
  write(join(first.packageRoot, "lib/index.js"), "corrupted");
  materializeAgentRuntimeNative(root);
  expect(builds).toBe(2);
  write(join(root, "node_modules/node-pty/src/pty.cc"), "new source");
  failLoad = true;
  expect(() => materializeAgentRuntimeNative(root)).toThrow("native load failed");
  expect(readFileSync(join(first.packageRoot, "build/Release/pty.node"), "utf8")).toBe(
    "runtime-addon-2",
  );
});
test("rejects an unreviewed dependency version before compilation", () => {
  const root = fixture();
  write(join(root, "node_modules/node-pty/package.json"), '{"version":"2.0.0"}');
  expect(() => materializeAgentRuntimeNative(root)).toThrow("requires node-pty 1.1.0");
  expect(builds).toBe(0);
});

test("Node native builds cannot inherit Electron target or external loader overrides", () => {
  const root = fixture();
  const node = materializeAgentRuntimeNative(root).node;
  const env = agentRuntimeNativeBuildEnvironment(node, {
    PATH: "/tools",
    HOME: "/private",
    HTTPS_PROXY: "https://proxy.invalid",
    npm_config_nodedir: "/electron",
    npm_package_config_node_gyp_target: "999",
    NPM_CONFIG_ARCH: "wrong",
    NODE_OPTIONS: "--import inject.mjs",
    NODE_PATH: "/electron_modules",
  });
  expect(env.HOME).toBe("/private");
  expect(env.HTTPS_PROXY).toBe("https://proxy.invalid");
  expect(env.PATH).toContain("browser-runtime/bin");
  expect(Object.keys(env).sort()).toEqual(["HOME", "HTTPS_PROXY", "PATH"]);
});
