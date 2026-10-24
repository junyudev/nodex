import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { assertPackagedAgentRuntimeNative } from "./agent-runtime-native-inventory.mjs";
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
    expect(() => assertPackagedAgentRuntimeNative({ sourceRoot, packagedRoot })).toThrow("differs");
    chmodSync(join(packagedRoot, "spawn-helper"), 0o755);
  }
  rmSync(join(packagedRoot, "index.js"));
  expect(() => assertPackagedAgentRuntimeNative({ sourceRoot, packagedRoot })).toThrow("differs");
});
