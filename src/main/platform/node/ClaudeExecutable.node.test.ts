// @effect-diagnostics asyncFunction:off - Node adapter filesystem resolution is the boundary under test.
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { expect, test, vi } from "vite-plus/test";
import {
  inheritedHostShellEnvironment,
  type HostShellOutcome,
} from "../../host-runtime/HostShellEnvironment";
import { executableCandidates, hostEnvironmentHome } from "./HostExecutableSearch";
import { claudeWindowsPackageEntries, resolveClaudeLaunch } from "./ClaudeExecutable";

test("Windows launch resolution accepts native environment casing and npm entrypoints", () => {
  const environment = {
    Path: "bin;C:\\tools",
    PATHEXT: ".EXE;.CMD",
    USERPROFILE: "C:\\users\\dev",
  };
  expect(executableCandidates("claude", environment, "win32", "C:\\workspace")).toEqual([
    "C:\\workspace\\bin\\claude.exe",
    "C:\\workspace\\bin\\claude.cmd",
    "C:\\workspace\\bin\\claude",
    "C:\\tools\\claude.exe",
    "C:\\tools\\claude.cmd",
    "C:\\tools\\claude",
  ]);
  expect(executableCandidates("~/bin/claude.exe", environment, "win32")).toEqual([
    "C:\\users\\dev\\bin\\claude.exe",
  ]);
  expect(claudeWindowsPackageEntries("C:\\tools\\claude.cmd")).toEqual([
    "C:\\tools\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    "C:\\tools\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
  ]);
  expect(hostEnvironmentHome(environment, "win32")).toBe("C:\\users\\dev");
  expect(executableCandidates("~/bin/claude", {}, "darwin")).toEqual([]);
});

const writeExecutable = async (root: string, name = "claude", contents = "#!/bin/sh\nexit 0\n") => {
  await mkdir(root, { recursive: true });
  const executable = join(root, name);
  await writeFile(executable, contents);
  await chmod(executable, 0o700);
  return executable;
};

const resolveClaudeExecutable = (
  binary: string,
  environment: NodeJS.ProcessEnv,
  platform: string,
  cwd: string,
) =>
  resolveClaudeLaunch(
    { binary, environment, platform, cwd, homeDirectory: cwd, allowPathDiscovery: false },
    inheritedHostShellEnvironment(environment),
  ).pipe(Effect.map(({ executable }) => executable));

const shellWith = (load: () => NodeJS.ProcessEnv) => {
  let current: HostShellOutcome | null = null;
  return {
    latest: Effect.sync(() => current),
    recover: Effect.sync(() => {
      current = { status: "captured", environment: load() };
      return current;
    }),
  };
};

const temporaryHome = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-claude-executable-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

// Login-shell discovery is a POSIX contract; native Windows/npm resolution is covered below.
it.effect.skipIf(process.platform === "win32")(
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
        {
          binary: "claude",
          environment,
          platform: "darwin",
          cwd: root,
          homeDirectory: root,
          allowPathDiscovery: true,
        },
        shellWith(load),
      );
      expect(launch.executable).toBe(yield* Effect.promise(() => realpath(executable)));
      expect(launch.environment).toEqual({
        ...environment,
        PATH: expect.stringContaining(
          `/usr/bin:/bin:${bin}:${dirname(process.execPath)}:${root}/.local/bin`,
        ),
      });
      const output = yield* Effect.promise(() =>
        promisify(execFile)(launch.executable, [], { env: launch.environment }),
      );
      expect(output.stdout).toBe("ready");
      expect(load).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped),
);

it.effect.skipIf(process.platform === "win32")(
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
          homeDirectory: root,
          allowPathDiscovery: true,
        },
        {
          ...inheritedHostShellEnvironment({}),
          recover: Effect.succeed({
            status: "failed",
            reason: "capture",
            message: "Shell unavailable",
          }),
        },
      );
      expect(launch.executable).toBe(yield* Effect.promise(() => realpath(executable)));
      expect(launch.environment.PATH?.split(":").slice(0, 3)).toEqual([
        "/usr/bin",
        "/bin",
        join(root, ".local", "bin"),
      ]);
    }).pipe(Effect.scoped),
);

it.effect.skipIf(process.platform === "win32")(
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
        {
          binary: "claude",
          environment,
          platform: "darwin",
          cwd: root,
          homeDirectory: root,
          allowPathDiscovery: true,
        },
        shellWith(load),
      );
      expect(launch.executable).toBe(yield* Effect.promise(() => realpath(executable)));
      expect(launch.environment.PATH?.split(":")[0]).toBe(bin);
    }).pipe(Effect.scoped),
);

it.effect.skipIf(process.platform === "win32")(
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
            {
              ...input,
              environment: { HOME: root, PATH: "" },
              platform: "darwin",
              cwd: root,
              homeDirectory: root,
            },
            shellWith(load),
          ),
        );
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure") expect(outcome.failure.message).toContain("was not found");
      }
      expect(load).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
);

it.effect.skipIf(process.platform === "win32")(
  "relative PATH entries belong to the explicit Claude workspace",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryHome;
      yield* Effect.promise(() => writeExecutable(join(root, "bin")));
      const resolved = yield* resolveClaudeExecutable(
        "claude",
        { PATH: "missing:bin" },
        "darwin",
        root,
      );
      expect(resolved.endsWith("/bin/claude")).toBe(true);
      const missing = yield* Effect.result(
        resolveClaudeExecutable("claude", { PATH: "bin" }, "darwin", join(root, "missing")),
      );
      expect(missing._tag).toBe("Failure");
    }).pipe(Effect.scoped),
);

test("explicit relative Windows commands resolve against the execution workspace", () => {
  expect(
    executableCandidates(
      ".\\tools\\claude.exe",
      { Path: "D:\\another" },
      "win32",
      "C:\\工作 workspace",
    ),
  ).toEqual(["C:\\工作 workspace\\tools\\claude.exe"]);
});

// Windows resolves the JavaScript entry behind npm's .cmd launcher without evaluating a shell.
it.effect.skipIf(process.platform !== "win32")(
  "resolves an installed Windows npm launcher from the workspace PATH",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryHome;
      const bin = join(root, "bin");
      const packageRoot = join(bin, "node_modules", "@anthropic-ai", "claude-code");
      yield* Effect.promise(() => mkdir(packageRoot, { recursive: true }));
      yield* Effect.promise(() => writeFile(join(bin, "claude.cmd"), "npm launcher fixture"));
      const entry = join(packageRoot, "cli.js");
      yield* Effect.promise(() => writeFile(entry, "process.exit(0)"));
      const resolved = yield* resolveClaudeExecutable(
        "claude",
        { Path: "missing;bin" },
        "win32",
        root,
      );
      expect(resolved).toBe(yield* Effect.promise(() => realpath(entry)));
    }).pipe(Effect.scoped),
);
