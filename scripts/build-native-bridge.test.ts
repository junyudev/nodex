import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { buildNativeBridge } from "./build-native-bridge";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const roots: string[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let builds = 0;
let toolchain = "toolchain-one";
let architecture = "arm64";
let failBuild = false;
let selectedSdk: string | undefined;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  builds = 0;
  toolchain = "toolchain-one";
  architecture = "arm64";
  failBuild = false;
  selectedSdk = undefined;
  for (const key of Object.keys(process.env)) {
    if (
      /^(?:CC|CXX|MAKE|MFLAGS|SDKROOT|PYTHON|NODE_OPTIONS|GYP_|npm_config_|npm_package_config_node_gyp_)/iu.test(
        key,
      )
    ) {
      vi.stubEnv(key, undefined);
    }
  }
  vi.mocked(execFileSync).mockImplementation((command, args) => {
    if (command === "/usr/bin/lipo") return architecture;
    if (args?.includes("--show-sdk-path") && selectedSdk) return selectedSdk;
    if (args?.[1] !== "rebuild") return toolchain;
    builds += 1;
    const directory = args[args.indexOf("--directory") + 1]!;
    const target = JSON.parse(readFileSync(path.join(directory, "binding.gyp"), "utf8")).targets[0]
      .target_name;
    const output = path.join(directory, "build", "Release");
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, `${target}.node`), "native-output");
    if (failBuild) throw new Error("compiler failed");
    return "";
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: "clipboard" | "devicecheck" | "notifications" = "clipboard") {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-native-bridge-"));
  roots.push(root);
  vi.stubEnv("HOME", root);
  const source = path.join(root, "native", `macos-${name}`);
  mkdirSync(path.join(source, "src"), { recursive: true });
  writeFileSync(
    path.join(source, "binding.gyp"),
    JSON.stringify({ targets: [{ target_name: `nodex_${name}` }] }),
  );
  writeFileSync(path.join(source, "src", `nodex_${name}.mm`), "source");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ devDependencies: { electron: "44.4.4" } }),
  );
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "locked toolchain");
  writeFileSync(path.join(root, "builder.ts"), "builder");
  const output = path.join(root, ".generated", `${name}-runtime`, "arm64", `nodex-${name}.node`);
  return {
    root,
    source,
    output,
    build: () =>
      buildNativeBridge({
        repositoryRoot: root,
        architecture: "arm64",
        name,
        script: "builder.ts",
      }),
  };
}

test.each(["clipboard", "devicecheck", "notifications"] as const)(
  "reuses verified %s output without rebuilding or changing its bytes",
  (name) => {
    const instance = fixture(name);
    expect(instance.build()).toBe("built");
    expect(instance.build()).toBe("reused");
    expect(builds).toBe(1);
    expect(readFileSync(instance.output, "utf8")).toBe("native-output");
    expect(
      vi.mocked(execFileSync).mock.calls.filter(([command]) => command === "/usr/bin/lipo"),
    ).toHaveLength(2);
  },
);

test.each(["source", "binding", "builder", "lock", "electron", "toolchain", "environment"])(
  "rebuilds after the %s input changes",
  (change) => {
    const instance = fixture();
    instance.build();
    if (change === "source")
      writeFileSync(path.join(instance.source, "src/nodex_clipboard.mm"), "changed");
    if (change === "binding")
      writeFileSync(
        path.join(instance.source, "binding.gyp"),
        '{"targets":[{"target_name":"nodex_clipboard","defines":["CHANGED"]}]}',
      );
    if (change === "builder") writeFileSync(path.join(instance.root, "builder.ts"), "changed");
    if (change === "lock") writeFileSync(path.join(instance.root, "pnpm-lock.yaml"), "changed");
    if (change === "electron")
      writeFileSync(
        path.join(instance.root, "package.json"),
        '{"devDependencies":{"electron":"45.0.0"}}',
      );
    if (change === "toolchain") toolchain = "toolchain-two";
    if (change === "environment") vi.stubEnv("DEVELOPER_DIR", "/different/Xcode");
    expect(instance.build()).toBe("built");
    expect(instance.build()).toBe("reused");
    expect(builds).toBe(2);
  },
);

test.each(["missing", "tampered", "non-executable", "symlink", "bad-receipt"])(
  "rebuilds %s cached output instead of trusting the receipt",
  (damage) => {
    const instance = fixture();
    instance.build();
    if (damage === "missing") rmSync(instance.output);
    if (damage === "tampered") writeFileSync(instance.output, "tampered-data");
    if (damage === "non-executable") chmodSync(instance.output, 0o644);
    if (damage === "symlink") {
      rmSync(instance.output);
      const other = path.join(instance.root, "other.node");
      writeFileSync(other, "native-output", { mode: 0o755 });
      symlinkSync(other, instance.output);
    }
    if (damage === "bad-receipt") writeFileSync(`${instance.output}.build.json`, "invalid JSON");
    expect(instance.build()).toBe("built");
    expect(builds).toBe(2);
  },
);

test.each(["compiler", "architecture"])("does not publish failed %s output", (failure) => {
  const instance = fixture();
  failBuild = failure === "compiler";
  architecture = failure === "architecture" ? "x86_64" : "arm64";
  expect(() => instance.build()).toThrow();
  expect(existsSync(instance.output)).toBe(false);
  expect(existsSync(`${instance.output}.build.json`)).toBe(false);
  failBuild = false;
  architecture = "arm64";
  expect(instance.build()).toBe("built");
  expect(instance.build()).toBe("reused");
});

test.each(["CXX", "MAKEFLAGS", "MFLAGS", "MAKEFILES"])(
  "does not reuse external %s overrides with untracked dependencies",
  (key) => {
    const instance = fixture();
    instance.build();
    vi.stubEnv(key, "/custom/build-input");
    expect(instance.build()).toBe("built");
    expect(instance.build()).toBe("built");
    expect(existsSync(`${instance.output}.build.json`)).toBe(false);
  },
);

test("does not reuse an implicit home Gyp include with external dependencies", () => {
  const instance = fixture();
  instance.build();
  mkdirSync(path.join(instance.root, ".gyp"));
  writeFileSync(path.join(instance.root, ".gyp/include.gypi"), "external include");
  expect(instance.build()).toBe("built");
  expect(instance.build()).toBe("built");
  expect(existsSync(`${instance.output}.build.json`)).toBe(false);
});

test("reuses Vite+ system CA configuration but rebuilds for injected Node modules", () => {
  const instance = fixture();
  vi.stubEnv("NODE_OPTIONS", "--use-system-ca");
  expect(instance.build()).toBe("built");
  expect(instance.build()).toBe("reused");
  vi.stubEnv("NODE_OPTIONS", "--require /external/build-hook.cjs");
  expect(instance.build()).toBe("built");
  expect(instance.build()).toBe("built");
});

test("reuses the selected Xcode SDK when an Apple launcher exports its SDKROOT alias", () => {
  const instance = fixture();
  selectedSdk = path.join(instance.root, "MacOSX27.0.sdk");
  mkdirSync(selectedSdk);
  const alias = path.join(instance.root, "MacOSX.sdk");
  symlinkSync(selectedSdk, alias);
  expect(instance.build()).toBe("built");
  vi.stubEnv("SDKROOT", alias);
  expect(instance.build()).toBe("reused");
  expect(builds).toBe(1);
});

test("does not reuse a custom SDK with untracked headers", () => {
  const instance = fixture();
  selectedSdk = path.join(instance.root, "MacOSX.sdk");
  mkdirSync(selectedSdk);
  const externalSdk = path.join(instance.root, "custom.sdk");
  mkdirSync(externalSdk);
  expect(instance.build()).toBe("built");
  vi.stubEnv("SDKROOT", externalSdk);
  expect(instance.build()).toBe("built");
  expect(instance.build()).toBe("built");
  expect(existsSync(`${instance.output}.build.json`)).toBe(false);
});
