// @effect-diagnostics asyncFunction:off - Node adapter filesystem resolution is the boundary under test.
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { expect, test, vi } from "vite-plus/test";
import { CodexLocalShellEnvironmentRuntimeError } from "../../codex/CodexLocalShellEnvironmentRuntime";
import {
  claudeExecutableCandidates,
  claudeNativeHome,
  claudeWindowsPackageEntries,
  resolveClaudeExecutable,
  resolveClaudeLaunch,
} from "./ClaudeExecutable";

test("Windows launch resolution accepts native environment casing and npm entrypoints", () => {
  const environment = {
    Path: "bin;C:\\tools",
    PATHEXT: ".EXE;.CMD",
    USERPROFILE: "C:\\users\\dev",
  };
  expect(claudeExecutableCandidates("claude", environment, "win32", "C:\\workspace")).toEqual([
    "C:\\workspace\\bin\\claude",
    "C:\\workspace\\bin\\claude.exe",
    "C:\\workspace\\bin\\claude.cmd",
    "C:\\tools\\claude",
    "C:\\tools\\claude.exe",
    "C:\\tools\\claude.cmd",
  ]);
  expect(claudeExecutableCandidates("~/bin/claude.exe", environment, "win32")).toEqual([
    "C:\\users\\dev\\bin\\claude.exe",
  ]);
  expect(claudeWindowsPackageEntries("C:\\tools\\claude.cmd")).toEqual([
    "C:\\tools\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    "C:\\tools\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
  ]);
  expect(claudeNativeHome(environment, "win32")).toBe("C:\\users\\dev");
  expect(claudeExecutableCandidates("~/bin/claude", {}, "darwin")).toEqual([]);
});

const writeExecutable = async (root: string, name = "claude", contents = "#!/bin/sh\nexit 0\n") => {
  await mkdir(root, { recursive: true });
  const executable = join(root, name);
  await writeFile(executable, contents);
  await chmod(executable, 0o700);
  return executable;
};

const temporaryHome = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-claude-executable-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

it.effect(
  "discovers a shell-installed Claude and retains its runtime PATH without importing shell secrets",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryHome;
      const bin = join(root, "npm", "bin");
      const executable = yield* Effect.promise(() =>
        writeExecutable(bin, "claude", "#!/usr/bin/env node\nprocess.stdout.write('ready');\n"),
      );
      const shellPath = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
      const load = vi.fn(() => ({
        PATH: shellPath,
        HOME: "/another-account",
        ANTHROPIC_API_KEY: "shell-secret",
      }));
      const environment = {
        PATH: "/usr/bin:/bin",
        HOME: root,
        ANTHROPIC_API_KEY: "instance-secret",
        ELECTRON_RUN_AS_NODE: "1",
      };
      const launch = yield* resolveClaudeLaunch(
        { binary: "claude", environment, platform: "darwin", cwd: root, allowPathDiscovery: true },
        Effect.sync(load),
      );
      expect(launch.executable).toBe(yield* Effect.promise(() => realpath(executable)));
      expect(launch.environment).toEqual({
        ...environment,
        PATH: `${shellPath}:${root}/.local/bin`,
      });
      const output = yield* Effect.promise(() =>
        promisify(execFile)(launch.executable, [], { env: launch.environment }),
      );
      expect(output.stdout).toBe("ready");
      expect(load).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped),
);

it.effect(
  "finds the native Claude installation when desktop and login PATH omit its directory",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryHome;
      const executable = yield* Effect.promise(() => writeExecutable(join(root, ".local", "bin")));
      const launch = yield* resolveClaudeLaunch(
        {
          binary: "claude",
          environment: { HOME: root, PATH: "/usr/bin:/bin" },
          platform: "darwin",
          cwd: root,
          allowPathDiscovery: true,
        },
        Effect.fail(
          new CodexLocalShellEnvironmentRuntimeError({ cause: new Error("Shell unavailable") }),
        ),
      );
      expect(launch.executable).toBe(yield* Effect.promise(() => realpath(executable)));
      expect(launch.environment.PATH).toBe(`/usr/bin:/bin:${root}/.local/bin`);
    }).pipe(Effect.scoped),
);

it.effect(
  "keeps an already available executable ahead of login-shell and native installations",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryHome;
      const bin = join(root, "desktop-bin");
      const executable = yield* Effect.promise(() => writeExecutable(bin));
      yield* Effect.promise(() => writeExecutable(join(root, ".local", "bin")));
      const load = vi.fn(() => ({ PATH: join(root, "shell-bin") }));
      const environment = { HOME: root, PATH: bin };
      const launch = yield* resolveClaudeLaunch(
        { binary: "claude", environment, platform: "darwin", cwd: root, allowPathDiscovery: true },
        Effect.sync(load),
      );
      expect(launch.executable).toBe(yield* Effect.promise(() => realpath(executable)));
      expect(launch.environment).toBe(environment);
      expect(load).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
);

it.effect(
  "does not replace explicit executable paths or an instance/worktree PATH with a discovered install",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryHome;
      const nativeBin = join(root, ".local", "bin");
      yield* Effect.promise(() => writeExecutable(nativeBin));
      const load = vi.fn(() => ({ PATH: nativeBin }));
      for (const input of [
        { binary: join(root, "missing", "claude"), allowPathDiscovery: true },
        { binary: "~/missing/claude", allowPathDiscovery: true },
        { binary: "claude", allowPathDiscovery: false },
      ]) {
        const outcome = yield* Effect.result(
          resolveClaudeLaunch(
            { ...input, environment: { HOME: root, PATH: "" }, platform: "darwin", cwd: root },
            Effect.sync(load),
          ),
        );
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure") expect(outcome.failure.message).toContain("was not found");
      }
      expect(load).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
);

test("relative PATH entries belong to the explicit Claude workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodex-claude-executable-"));
  try {
    await mkdir(join(root, "bin"));
    const executable = join(root, "bin", "claude");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);
    const resolved = await resolveClaudeExecutable(
      "claude",
      { PATH: "missing:bin" },
      "darwin",
      root,
    );
    expect(resolved.endsWith("/bin/claude")).toBe(true);
    await expect(
      resolveClaudeExecutable("claude", { PATH: "bin" }, "darwin", join(root, "missing")),
    ).rejects.toThrow("was not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
