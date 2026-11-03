import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import type { Command } from "../tooling/process";
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
  test("stages the locked production runtime once without invoking Cargo", async () => {
    const commands: Command[] = [];
    const env = { NODEX_BUILD_CACHE_DIR: "/tmp/verified cache" };
    const signal = new AbortController().signal;
    const prepared = await prepareNativeArtifacts(["agent-runtime", "agent-runtime"], {
      repositoryRoot: root,
      env,
      signal,
      execute: async (command) => {
        commands.push(command);
        return { exitCode: 0, signal: null, durationMs: 1 };
      },
    });
    expect(prepared).toEqual({ executables: {} });
    expect(commands).toEqual([
      {
        command: "vp",
        args: ["run", "stage:codex-runtime:mac:cached"],
        cwd: root,
        env,
        signal,
      },
    ]);
  });
  test("prepares runtime and Cargo artifacts together without passing runtime IDs to Cargo", async () => {
    const commands: Command[] = [];
    const prepared = await prepareNativeArtifacts(["agent-runtime", "core-server"], {
      repositoryRoot: root,
      execute: async (command) => {
        commands.push(command);
        if (command.command === "cargo") command.onStdout?.(JSON.stringify(artifact) + "\n");
        return { exitCode: 0, signal: null, durationMs: 1 };
      },
    });
    expect(commands.map((command) => command.command)).toEqual(["vp", "cargo"]);
    expect(commands[1]?.args).toEqual(cargoBuildArguments(["core-server"]));
    expect(prepared.executables).toEqual({ "core-server": executable });
  });
  test("fails runtime preparation before building or executing tests", async () => {
    let calls = 0;
    await expect(
      prepareNativeArtifacts(["agent-runtime", "core-server"], {
        repositoryRoot: root,
        execute: async () => {
          calls++;
          return { exitCode: 7, signal: null, durationMs: 1 };
        },
      }),
    ).rejects.toThrow("Agent runtime test preparation failed (exit 7)");
    expect(calls).toBe(1);
  });
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
  test("prepares optimized native executables for performance measurements", async () => {
    const releaseExecutable = path.resolve("/tmp/custom target/release/nodex-core");
    const prepared = await prepareNativeArtifacts(["core-server"], {
      repositoryRoot: root,
      profile: "release",
      execute: async (command) => {
        expect(command.args).toContain("--release");
        command.onStdout?.(JSON.stringify({ ...artifact, executable: releaseExecutable }) + "\n");
        return { exitCode: 0, signal: null, durationMs: 1 };
      },
    });
    expect(prepared.executables["core-server"]).toBe(releaseExecutable);
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
