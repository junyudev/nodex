import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { assertDesktopRuntimePayload } from "./desktop-runtime-payload.mjs";

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
  const dependency = "out/agent-runtime/node_modules";
  const binary = `${dependency}/@anthropic-ai/claude-agent-sdk-${platform}-${arch}/${platform === "win32" ? "claude.exe" : "claude"}`;
  write(join(sourceRoot, binary));
  write(join(sourceRoot, dependency, "@anthropic-ai/claude-agent-sdk/sdk.mjs"));
  mkdirSync(resourcesPath);
  cpSync(join(sourceRoot, "out"), join(resourcesPath, "app.asar.unpacked/out"), {
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
  return { resourcesPath, sourceRoot, platform, arch, binary };
}
test.each([
  ["win32", "x64"],
  ["win32", "arm64"],
  ["darwin", "arm64"],
])("%s %s ships one verified Claude closure", (platform, arch) => {
  const input = fixture(platform, arch);
  expect(assertDesktopRuntimePayload(input)).toBe(
    join(input.resourcesPath, "app.asar.unpacked", input.binary),
  );
  write(join(input.resourcesPath, "app.asar.unpacked", input.binary), "damaged");
  expect(() => assertDesktopRuntimePayload(input)).toThrow("differs");
});
test.each([
  "node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64/claude.exe",
  "extra/claude.exe",
])("rejects a second unpacked Claude at %s", (duplicate) => {
  const input = fixture("win32", "arm64");
  write(join(input.resourcesPath, duplicate));
  expect(() => assertDesktopRuntimePayload(input)).toThrow("exactly one Claude");
});
test("rejects a second Claude hidden inside ASAR", () => {
  const input = fixture("win32", "x64");
  archive(join(input.resourcesPath, "app.asar"), [
    "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
  ]);
  expect(() => assertDesktopRuntimePayload(input)).toThrow("exactly one Claude");
});
test.each([
  "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
  "node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/package.json",
  "node_modules/node-pty/prebuilds/win32-x64/pty.node",
  "out/agent-runtime/node_modules/node-pty/third_party/conpty/win10-x64/OpenConsole.exe",
  "node_modules/node-pty/build/Release/conpty.pdb",
  "node_modules/node-pty/build/Release/conpty.ipdb",
  "node_modules/node-pty/build/Release/conpty.iobj",
  "node_modules/node-pty/build/deps/winpty/src/Release/winpty.dll",
  "out/agent-runtime/entry.mjs.map",
])("rejects unused payload at %s", (file) => {
  const input = fixture("win32", "x64");
  write(join(input.resourcesPath, "app.asar.unpacked", file));
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
  archive(join(input.resourcesPath, "app.asar"), ["out/main/bootstrap.js.map"]);
  expect(() => assertDesktopRuntimePayload(input)).toThrow("Unused desktop");
});
