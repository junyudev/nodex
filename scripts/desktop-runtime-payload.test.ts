import { ripgrepFixture, writeRipgrepFixture } from "./testing/ripgrep-runtime-fixture";
import { writePackagedStockNodeFixture } from "./testing/packaged-stock-node-fixture";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { assertDesktopRuntimePayload } from "./desktop-runtime-payload.mjs";
import { assertPackagedAgentRuntimeNative } from "./agent-runtime-native-inventory.mjs";

vi.mock("./ripgrep-runtime-payload.mjs", async (importOriginal) => {
  const { assertRipgrepRuntimePayload } =
    await importOriginal<typeof import("./ripgrep-runtime-payload.mjs")>();
  return {
    assertRipgrepRuntimePayload: (
      ...[directory, target, options]: Parameters<typeof assertRipgrepRuntimePayload>
    ) =>
      assertRipgrepRuntimePayload(directory, target, {
        ...options,
        release: ripgrepFixture(target).release,
      }),
  };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const write = (path: string, contents = "runtime") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};
function archive(path: string, paths: string[]) {
  interface Entry {
    files?: Record<string, Entry>;
    size?: number;
    offset?: string;
  }
  const files: Record<string, Entry> = {};
  for (const file of paths) {
    const segments = file.split("/");
    let parent = files;
    for (const segment of segments.slice(0, -1)) {
      parent[segment] ??= { files: {} };
      parent = parent[segment]!.files!;
    }
    parent[segments.at(-1)!] = { size: 0, offset: "0" };
  }
  const header = Buffer.from(JSON.stringify({ files }));
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(header.length, 12);
  writeFileSync(path, Buffer.concat([preamble, header]));
}
function fixture(platform: string, arch: string) {
  const root = mkdtempSync(join(tmpdir(), "nodex-runtime-payload-"));
  roots.push(root);
  const resourcesPath = join(root, "resources");
  const sourceRoot = join(root, "source");
  const dependency = "agent-runtime/node_modules";
  const binary = `${dependency}/@anthropic-ai/claude-agent-sdk-${platform}-${arch}/${platform === "win32" ? "claude.exe" : "claude"}`;

  write(join(sourceRoot, "out", dependency, "@anthropic-ai/claude-agent-sdk/sdk.mjs"));
  mkdirSync(resourcesPath);
  cpSync(join(sourceRoot, "out/agent-runtime"), join(resourcesPath, "agent-runtime"), {
    recursive: true,
  });
  for (const file of platform === "win32"
    ? [
        "pty.node",
        "conpty.node",
        "conpty_console_list.node",
        "conpty/conpty.dll",
        "conpty/OpenConsole.exe",
      ]
    : ["pty.node", "spawn-helper"])
    write(join(resourcesPath, "app.asar.unpacked/node_modules/node-pty/build/Release", file));
  archive(join(resourcesPath, "app.asar"), ["out/main/bootstrap.js", "package.json"]);
  writePackagedStockNodeFixture(resourcesPath);
  if (platform === "win32") {
    write(join(resourcesPath, "codex-crt/vcruntime140.dll"));
    write(join(resourcesPath, "third-party/codex/LICENSE"));
    write(join(resourcesPath, "third-party/codex/NOTICE"));
  }
  writeRipgrepFixture(
    resourcesPath,
    platform === "darwin" ? "darwin-arm64" : arch === "arm64" ? "win32-arm64" : "win32-x64",
  );
  return { resourcesPath, sourceRoot, platform, arch, binary };
}
test.each([
  ["win32", "x64"],
  ["win32", "arm64"],
])("%s %s keeps the shared SDK and rejects the native Claude package", (platform, arch) => {
  const input = fixture(platform, arch);
  expect(() => assertDesktopRuntimePayload(input)).not.toThrow();
  write(join(input.resourcesPath, input.binary));
  expect(() => assertDesktopRuntimePayload(input)).toThrow(
    "must install Claude Code as a Component",
  );
});

test.each([
  ["app.asar.unpacked/bin/codex.exe", "Codex"],
  ["codex-resources/voice/bin/codex-voice-host.exe", "Codex"],
  ["codex-path/rg.exe", "Codex"],
  ["browser-runtime/bin/node.exe", "Desktop Tools"],
  ["extra/claude.exe", "Claude Code"],
  [
    "app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64/package.json",
    "Claude Code",
  ],
])("rejects a Windows Component at %s", (file, component) => {
  const input = fixture("win32", "x64");
  write(join(input.resourcesPath, file));
  expect(() => assertDesktopRuntimePayload(input)).toThrow(
    `must install ${component} as a Component`,
  );
});

test("also rejects Windows Component payload from the ASAR file table", () => {
  const input = fixture("win32", "x64");
  archive(join(input.resourcesPath, "app.asar"), [
    "out/main/bootstrap.js",
    "package.json",
    "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
  ]);
  expect(() => assertDesktopRuntimePayload(input)).toThrow("app.asar/node_modules");
});

test.each([
  "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
  "node_modules/node-pty/prebuilds/win32-x64/pty.node",
  "agent-runtime/node_modules/node-pty/third_party/conpty/win10-x64/OpenConsole.exe",
  "node_modules/node-pty/build/Release/conpty.pdb",
  "node_modules/node-pty/build/Release/conpty.ipdb",
  "node_modules/node-pty/build/Release/conpty.iobj",
  "node_modules/node-pty/build/deps/winpty/src/Release/winpty.dll",
  "agent-runtime/entry.mjs.map",
])("rejects unused payload at %s", (file) => {
  const input = fixture("win32", "x64");
  write(
    join(input.resourcesPath, file.startsWith("agent-runtime/") ? "" : "app.asar.unpacked", file),
  );
  expect(() => assertDesktopRuntimePayload(input)).toThrow(
    /Main must share|Unexpected Claude|Unused desktop/,
  );
});
test("requires the rebuilt Electron PTY before removing its fallback prebuilds", () => {
  const input = fixture("win32", "arm64");
  rmSync(
    join(input.resourcesPath, "app.asar.unpacked/node_modules/node-pty/build/Release/conpty.node"),
  );
  expect(() => assertDesktopRuntimePayload(input)).toThrow("Electron PTY runtime is missing");
});
test("checks archived maps and redundant native payload too", () => {
  const input = fixture("darwin", "arm64");
  archive(join(input.resourcesPath, "app.asar"), ["package.json", "out/main/bootstrap.js.map"]);
  expect(() => assertDesktopRuntimePayload(input)).toThrow("Unused desktop");
});

test.each(["agent-runtime/entry.mjs", "app-tools/server.mjs"])(
  "requires the prepared bytes for %s",
  (file) => {
    const input = fixture("darwin", "arm64");
    write(join(input.resourcesPath, file), "changed");
    expect(() => assertDesktopRuntimePayload(input)).toThrow("differs from the prepared build");
    rmSync(join(input.resourcesPath, file));
    expect(() => assertDesktopRuntimePayload(input)).toThrow("ENOENT");
  },
);
test.each(["out/agent-runtime/entry.mjs", "out/main/app-tools/server.mjs"])(
  "rejects stock Node programs in ASAR or its companion: %s",
  (file) => {
    const input = fixture("darwin", "arm64");
    write(join(input.resourcesPath, "app.asar.unpacked", file));
    expect(() => assertDesktopRuntimePayload(input)).toThrow("must be detached");
    rmSync(join(input.resourcesPath, "app.asar.unpacked/out"), { recursive: true });
    archive(join(input.resourcesPath, "app.asar"), ["out/main/bootstrap.js", "package.json", file]);
    expect(() => assertDesktopRuntimePayload(input)).toThrow("must be detached");
  },
);

test("rejects Desktop Tools in macOS Resources", () => {
  const input = fixture("darwin", "arm64");
  mkdirSync(join(input.resourcesPath, "browser-runtime"));
  expect(() => assertDesktopRuntimePayload(input)).toThrow(
    "macOS app must install Desktop Tools as a Component",
  );
});

test.each([
  "bin/codex",
  "bin/codex-code-mode-host",
  "bin/codex-exec-server",
  "codex-resources/voice/NOTICE.md",
  "codex-path/rg",
  "codex-package.json",
  "agent-runtime.json",
])("rejects %s in macOS Resources", (file) => {
  const input = fixture("darwin", "arm64");
  write(join(input.resourcesPath, file));
  expect(() => assertDesktopRuntimePayload(input)).toThrow("must install Codex as a Component");
});

test("rejects a Codex package embedded inside the macOS application archive", () => {
  const input = fixture("darwin", "arm64");
  archive(join(input.resourcesPath, "app.asar"), [
    "out/main/bootstrap.js",
    "out/main/bin/codex",
    "package.json",
  ]);
  expect(() => assertDesktopRuntimePayload(input)).toThrow("app.asar/out/main/bin/codex");
});

describe("packaged Agent native closure", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  test("packaging retains native bytes, helper execution permissions and the complete JS closure", () => {
    const root = mkdtempSync(join(tmpdir(), "nodex-pty-closure-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const packagedRoot = join(root, "packaged");
    mkdirSync(sourceRoot);
    writeFileSync(join(sourceRoot, "pty.node"), "native");
    writeFileSync(join(sourceRoot, "index.js"), "module");
    writeFileSync(join(sourceRoot, "spawn-helper"), "helper", { mode: 0o755 });
    cpSync(sourceRoot, packagedRoot, { recursive: true });
    expect(() => assertPackagedAgentRuntimeNative({ sourceRoot, packagedRoot })).not.toThrow();
    writeFileSync(join(packagedRoot, "pty.node"), "electron native");
    expect(() => assertPackagedAgentRuntimeNative({ sourceRoot, packagedRoot })).toThrow("differs");
    cpSync(sourceRoot, packagedRoot, { recursive: true });
    if (process.platform !== "win32") {
      chmodSync(join(packagedRoot, "spawn-helper"), 0o644);
      expect(() => assertPackagedAgentRuntimeNative({ sourceRoot, packagedRoot })).toThrow(
        "differs",
      );
      chmodSync(join(packagedRoot, "spawn-helper"), 0o755);
    }
    rmSync(join(packagedRoot, "index.js"));
    expect(() => assertPackagedAgentRuntimeNative({ sourceRoot, packagedRoot })).toThrow("differs");
  });
});
