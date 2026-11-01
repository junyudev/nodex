import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import {
  assertPeArchitecture,
  readPeArchitecture,
  verifyWindowsArchitectureClosure,
} from "./windows-pe.mjs";
import { desktopBuildTarget } from "./desktop-build-target";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-pe-"));
  roots.push(root);
  return root;
};
function image(machine: number): Buffer {
  const buffer = Buffer.alloc(256);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(128, 0x3c);
  buffer.writeUInt32LE(0x4550, 128);
  buffer.writeUInt16LE(machine, 132);
  return buffer;
}

test.each([
  ["x64", 0x8664],
  ["arm64", 0xaa64],
] as const)("reads %s from the COFF header", (arch, machine) => {
  const file = join(fixture(), "native.node");
  writeFileSync(file, image(machine));
  expect(readPeArchitecture(file)).toBe(arch);
  expect(() => assertPeArchitecture(file, arch === "x64" ? "arm64" : "x64")).toThrow(
    "architecture mismatch",
  );
});

test.each([
  Buffer.alloc(4),
  Buffer.alloc(64),
  image(0x14c),
  (() => {
    const b = image(0x8664);
    b.writeUInt32LE(4096, 0x3c);
    return b;
  })(),
])("rejects corrupt, truncated, or unsupported native images", (bytes) => {
  const file = join(fixture(), "native.exe");
  writeFileSync(file, bytes);
  expect(() => readPeArchitecture(file)).toThrow();
});

test("rejects a foreign architecture anywhere in a Windows payload", () => {
  const root = fixture();
  mkdirSync(join(root, "resources/native"), { recursive: true });
  writeFileSync(join(root, "Nodex.exe"), image(0x8664));
  writeFileSync(join(root, "resources/native/conpty.dll"), image(0xaa64));
  expect(() => verifyWindowsArchitectureClosure(root, "x64")).toThrow("conpty.dll");
  writeFileSync(join(root, "resources/native/conpty.dll"), image(0x8664));
  expect(verifyWindowsArchitectureClosure(root, "x64")).toEqual([
    "Nodex.exe",
    "resources/native/conpty.dll",
  ]);
});

test("Windows targets select native Rust triples and omit macOS helpers", () => {
  expect(desktopBuildTarget("win32", "x64").rustTarget).toBe("x86_64-pc-windows-msvc");
  expect(desktopBuildTarget("win32", "arm64").rustTarget).toBe("aarch64-pc-windows-msvc");
  expect(desktopBuildTarget("win32", "arm64").rustPackages).toEqual([
    "nodex-core-server",
    "nodex-cli",
  ]);
  expect(() => desktopBuildTarget("win32", "ia32")).toThrow("Unsupported Nodex desktop target");
});

test("inspects renamed PE images as part of the payload closure", () => {
  const root = fixture();
  writeFileSync(join(root, "hidden-image.bin"), image(0xaa64));
  expect(() => verifyWindowsArchitectureClosure(root, "x64")).toThrow("architecture mismatch");
});
