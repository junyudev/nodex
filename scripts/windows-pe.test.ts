import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, test } from "vite-plus/test";
import {
  assertPeArchitecture,
  readPeArchitecture,
  readPeImports,
  assertPeDependencies,
  verifyWindowsArchitectureClosure,
} from "./windows-pe.mjs";
import { desktopBuildTarget } from "./desktop-build-target";

import { windowsPeFixture as image } from "./testing/windows-pe-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-pe-"));
  roots.push(root);
  return root;
};

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

test("recognizes only the installed NSIS maintenance bootstrap outside the application CPU closure", () => {
  const root = fixture();
  writeFileSync(join(root, "Nodex.exe"), image(0xaa64));
  writeFileSync(join(root, "Uninstall Nodex.exe"), image(0x14c));
  expect(() => verifyWindowsArchitectureClosure(root, "arm64")).toThrow("Unsupported PE Machine");
  expect(verifyWindowsArchitectureClosure(root, "arm64", { installed: true })).toEqual([
    "Nodex.exe",
  ]);
  writeFileSync(join(root, "Uninstall Nodex.exe"), image(0x8664));
  expect(() => verifyWindowsArchitectureClosure(root, "arm64", { installed: true })).toThrow(
    "Unexpected NSIS uninstaller machine",
  );
});

test.each([false, true])("reads ordinary and delay imports with PE32=%s", (pe32) => {
  const file = join(fixture(), "native.exe");
  writeFileSync(file, image(0x8664, ["KERNEL32.dll", "VCRUNTIME140.dll"], ["late.dll"], { pe32 }));
  expect(readPeImports(file)).toEqual([
    { name: "KERNEL32.dll", kind: "import" },
    { name: "VCRUNTIME140.dll", kind: "import" },
    { name: "late.dll", kind: "delay" },
  ]);
});

test("reads legacy VA-based delay descriptors", () => {
  const file = join(fixture(), "native.exe");
  writeFileSync(file, image(0x8664, [], ["late.dll"], { pe32: true, delayVirtualAddresses: true }));
  expect(readPeImports(file)).toEqual([{ name: "late.dll", kind: "delay" }]);
});

test.each(["import", "delay"])(
  "requires same-directory app-local %s dependencies, recursively",
  (kind) => {
    const root = fixture();
    const app = join(root, "native.exe");
    writeFileSync(
      app,
      image(
        0x8664,
        kind === "import" ? ["VCRUNTIME140.dll"] : [],
        kind === "delay" ? ["VCRUNTIME140.dll"] : [],
      ),
    );
    mkdirSync(join(root, "unrelated"));
    writeFileSync(join(root, "unrelated/vcruntime140.dll"), image(0x8664));
    expect(() => verifyWindowsArchitectureClosure(root, "x64")).toThrow(
      `Unresolved Windows ${kind} dependency VCRUNTIME140.dll`,
    );
    writeFileSync(join(root, "vcruntime140.dll"), image(0x8664, ["missing.dll"]));
    expect(() => verifyWindowsArchitectureClosure(root, "x64")).toThrow("missing.dll");
    writeFileSync(join(root, "vcruntime140.dll"), image(0xaa64));
    expect(() => verifyWindowsArchitectureClosure(root, "x64")).toThrow("architecture mismatch");
    writeFileSync(
      join(root, "vcruntime140.dll"),
      image(0x8664, [
        "api-ms-win-crt-runtime-l1-1-0.dll",
        "ext-ms-win-ntuser-window-l1-1-0.dll",
        "ucrtbase.dll",
      ]),
    );
    expect(verifyWindowsArchitectureClosure(root, "x64")).toHaveLength(3);
    expect(() => assertPeDependencies(app, "x64", { systemOnly: true })).toThrow(
      "Nodex native image requires a non-OS",
    );
  },
);

test.each(["vcruntime140.dll", "msvcp140.dll", "python3.dll", "api-ms-fake.dll"])(
  "never treats %s as an OS component",
  (name) => {
    const file = join(fixture(), "native.exe");
    writeFileSync(file, image(0x8664, [name]));
    expect(() => assertPeDependencies(file, "x64")).toThrow(name);
  },
);

test("fails closed on malformed tables and DLL names", () => {
  const file = join(fixture(), "native.exe");
  const malformed = image(0x8664, ["kernel32.dll"]);
  malformed.writeUInt32LE(0xdeadbeef, 512 + 12);
  writeFileSync(file, malformed);
  expect(() => readPeImports(file)).toThrow("unmapped RVA");
  const unterminated = image(0x8664, ["kernel32.dll"]);
  unterminated.writeUInt32LE(20, 128 + 24 + 112 + 8 + 4);
  writeFileSync(file, unterminated);
  expect(() => readPeImports(file)).toThrow("unterminated import table");
  writeFileSync(file, image(0x8664, ["../outside.dll"]));
  expect(() => readPeImports(file)).toThrow("DLL basename");
});

test.each([
  ["x64", 0x8664],
  ["arm64", 0xaa64],
] as const)(
  "closes the complete pinned %s terminal payload, including nested helpers",
  (arch, machine) => {
    const require = createRequire(import.meta.url);
    const root = join(dirname(require.resolve("node-pty/package.json")), `prebuilds/win32-${arch}`);
    const host = join(fixture(), "node.exe");
    writeFileSync(host, image(machine));
    const files = verifyWindowsArchitectureClosure(root, arch, { nodeHost: host });
    expect(files).toContain("conpty/OpenConsole.exe");
  },
);

test.skipIf(process.platform !== "win32")(
  "closes the installed native Claude SDK payload before packaging",
  () => {
    const arch = process.arch;
    if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported Windows CPU ${arch}`);
    const require = createRequire(import.meta.url);
    const sdkRequire = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const root = dirname(
      sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-win32-${arch}/package.json`),
    );
    expect(verifyWindowsArchitectureClosure(root, arch)).toContain("claude.exe");
  },
);
