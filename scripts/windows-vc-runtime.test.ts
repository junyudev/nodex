import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { windowsPeFixture } from "./testing/windows-pe-fixture";
import { stageWindowsVcRuntime } from "./windows-vc-runtime.mjs";
import { assertPeDependencies, verifyWindowsArchitectureClosure } from "./windows-pe.mjs";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-vc-runtime-"));
  roots.push(root);
  const payload = join(root, "payload");
  const redistDirectory = join(root, "MSVC/arm64/Microsoft.VC143.CRT");
  mkdirSync(payload);
  mkdirSync(redistDirectory, { recursive: true });
  return { payload, redistDirectory };
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("stages only missing retail CRT dependencies beside each consumer, including transitive imports", () => {
  const { payload, redistDirectory } = fixture();
  mkdirSync(join(payload, "codex-path"));
  const rg = windowsPeFixture(0xaa64, ["VCRUNTIME140.dll", "kernel32.dll"]);
  writeFileSync(join(payload, "codex-path/rg.exe"), rg);
  writeFileSync(
    join(redistDirectory, "vcruntime140.dll"),
    windowsPeFixture(0xaa64, [], ["vcruntime140_1.dll"]),
  );
  writeFileSync(
    join(redistDirectory, "vcruntime140_1.dll"),
    windowsPeFixture(0xaa64, ["ucrtbase.dll"]),
  );
  writeFileSync(join(redistDirectory, "msvcp140.dll"), windowsPeFixture(0xaa64));
  expect(() => verifyWindowsArchitectureClosure(payload, "arm64")).toThrow("VCRUNTIME140.dll");
  expect(stageWindowsVcRuntime(payload, "arm64", { redistDirectory })).toEqual([
    "codex-path/vcruntime140.dll",
    "codex-path/vcruntime140_1.dll",
  ]);
  expect(readFileSync(join(payload, "codex-path/rg.exe"))).toEqual(rg);
  expect(verifyWindowsArchitectureClosure(payload, "arm64")).toHaveLength(3);
  expect(stageWindowsVcRuntime(payload, "arm64", { redistDirectory })).toEqual([]);
});

test("rejects the wrong CRT architecture and never fills arbitrary or first-party imports from the host", () => {
  const { payload, redistDirectory } = fixture();
  writeFileSync(join(payload, "rg.exe"), windowsPeFixture(0xaa64, ["vcruntime140.dll"]));
  writeFileSync(join(redistDirectory, "vcruntime140.dll"), windowsPeFixture(0x8664));
  expect(() => stageWindowsVcRuntime(payload, "arm64", { redistDirectory })).toThrow(
    "architecture mismatch",
  );
  rmSync(join(payload, "rg.exe"));
  writeFileSync(join(payload, "nodex-core.exe"), windowsPeFixture(0xaa64, ["vcruntime140.dll"]));
  expect(() => stageWindowsVcRuntime(payload, "arm64", { redistDirectory })).toThrow(
    "must use static CRT",
  );
  rmSync(join(payload, "nodex-core.exe"));
  writeFileSync(join(payload, "vendor.exe"), windowsPeFixture(0xaa64, ["custom.dll"]));
  writeFileSync(join(redistDirectory, "custom.dll"), windowsPeFixture(0xaa64));
  expect(stageWindowsVcRuntime(payload, "arm64", { redistDirectory })).toEqual([]);
  expect(() => verifyWindowsArchitectureClosure(payload, "arm64")).toThrow("custom.dll");
});

test("binds only an addon's node.exe delay import to an explicitly verified host", () => {
  const { payload } = fixture();
  const addon = join(payload, "addon.node");
  const host = join(payload, "Nodex.exe");
  writeFileSync(addon, windowsPeFixture(0xaa64, [], ["node.exe"]));
  writeFileSync(host, windowsPeFixture(0xaa64));
  expect(() => assertPeDependencies(addon, "arm64")).toThrow("node.exe");
  expect(() => assertPeDependencies(addon, "arm64", { nodeHost: host })).not.toThrow();
  writeFileSync(host, windowsPeFixture(0x8664));
  expect(() => assertPeDependencies(addon, "arm64", { nodeHost: host })).toThrow(
    "architecture mismatch",
  );
  writeFileSync(host, windowsPeFixture(0xaa64));
  writeFileSync(addon, windowsPeFixture(0xaa64, ["node.exe"]));
  expect(() => assertPeDependencies(addon, "arm64", { nodeHost: host })).toThrow("node.exe");
});

test("distinguishes the third-party Electron shell from Nodex's native CLI", () => {
  const { payload, redistDirectory } = fixture();
  writeFileSync(join(redistDirectory, "vcruntime140.dll"), windowsPeFixture(0xaa64));
  writeFileSync(join(payload, "Nodex.exe"), windowsPeFixture(0xaa64, ["vcruntime140.dll"]));
  expect(stageWindowsVcRuntime(payload, "arm64", { redistDirectory })).toEqual([
    "vcruntime140.dll",
  ]);
  mkdirSync(join(payload, "bin"));
  writeFileSync(join(payload, "bin/nodex.exe"), windowsPeFixture(0xaa64, ["vcruntime140.dll"]));
  expect(() => stageWindowsVcRuntime(payload, "arm64", { redistDirectory })).toThrow(
    "must use static CRT",
  );
});
