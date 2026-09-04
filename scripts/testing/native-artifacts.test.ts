import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  cargoBuildArguments,
  prepareNativeArtifacts,
  readCargoExecutables,
  requiredNativeExecutable,
} from "./native-artifacts";

const root = path.resolve("/tmp/work space");
const executable = path.resolve("/tmp/custom target/debug/nodex-core");
const artifact = {
  reason: "compiler-artifact",
  package_id: "path+" + pathToFileURL(path.join(root, "crates/nodex-core-server")).href + "#0.2.2",
  target: {
    name: "nodex-core",
    kind: ["bin"],
    src_path: path.join(root, "crates/nodex-core-server/src/main.rs"),
  },
  executable,
  fresh: true,
};

describe("native test preparation", () => {
  test("requests only required targets with no duplicate package selections", () => {
    expect(cargoBuildArguments([])).toEqual([]);
    expect(cargoBuildArguments(["core-server", "yjs-yrs-bridge", "core-server"])).toEqual([
      "build",
      "-p",
      "nodex-core-server",
      "-p",
      "nodex-core",
      "--bin",
      "nodex-core",
      "--example",
      "yjs_yrs_bridge",
      "--message-format=json-render-diagnostics",
    ]);
  });
  test("uses Cargo's executable even outside the default target directory", () => {
    expect(readCargoExecutables(JSON.stringify(artifact), ["core-server"], root)).toEqual({
      executables: { "core-server": executable },
    });
    expect(requiredNativeExecutable("core-server", { NODEX_CORE_EXECUTABLE: executable })).toBe(
      executable,
    );
  });
  test("rejects missing, ambiguous and unrelated artifacts", () => {
    expect(() => readCargoExecutables("", ["core-server"], root)).toThrow("exactly one");
    expect(() =>
      readCargoExecutables(
        [artifact, artifact].map((v) => JSON.stringify(v)).join("\n"),
        ["core-server"],
        root,
      ),
    ).toThrow("exactly one");
    expect(() =>
      readCargoExecutables(
        JSON.stringify({ ...artifact, package_id: "registry+different#nodex-core-server@0.2.2" }),
        ["core-server"],
        root,
      ),
    ).toThrow("exactly one");
    expect(() => requiredNativeExecutable("yjs-yrs-bridge", {})).toThrow("Missing prepared");
    expect(() =>
      requiredNativeExecutable("core-server", { NODEX_CORE_EXECUTABLE: "target/debug/nodex-core" }),
    ).toThrow("Missing prepared");
  });
  test("does not execute Cargo for a non-native selection", async () => {
    expect(
      await prepareNativeArtifacts([], {
        repositoryRoot: root,
        execute: async () => {
          throw new Error("unexpected build");
        },
      }),
    ).toEqual({ executables: {} });
  });
  test("checks freshness on every invocation and forwards build environment", async () => {
    let calls = 0;
    const env = { CARGO_TARGET_DIR: "/tmp/custom target" };
    const execute: NonNullable<Parameters<typeof prepareNativeArtifacts>[1]["execute"]> = async (
      command,
    ) => {
      calls++;
      expect(command.env).toBe(env);
      command.onStdout?.(JSON.stringify(artifact) + "\n");
      return { exitCode: 0, signal: null, durationMs: 1 };
    };
    await prepareNativeArtifacts(["core-server"], { repositoryRoot: root, env, execute });
    await prepareNativeArtifacts(["core-server"], { repositoryRoot: root, env, execute });
    expect(calls).toBe(2);
  });
  test("fails preparation rather than reusing an old executable after Cargo fails", async () => {
    await expect(
      prepareNativeArtifacts(["core-server"], {
        repositoryRoot: root,
        execute: async () => ({ exitCode: 7, signal: null, durationMs: 1 }),
      }),
    ).rejects.toThrow("exit 7");
  });
});
