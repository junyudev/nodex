import { it as effectIt } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vite-plus/test";
import { testLayer } from "../../app/MainConfig";
import {
  ApplicationSettings,
  make as makeApplicationSettings,
} from "../../settings/ApplicationSettings";
import { describe, expect, test } from "vite-plus/test";
import {
  TerminalEnvironment,
  live,
  buildTerminalEnvironment,
  resolveTerminalCommand,
  terminalShellCandidates,
} from "./TerminalEnvironment";

describe("resolveTerminalCommand", () => {
  test("starts zsh as an interactive login shell", () => {
    expect(resolveTerminalCommand("/bin/zsh", "darwin")).toEqual(["/bin/zsh", "-l", "-i"]);
  });

  test("starts bash with its login and interactive flags", () => {
    expect(resolveTerminalCommand("/bin/bash", "linux")).toEqual(["/bin/bash", "--login", "-i"]);
  });

  test("starts unknown POSIX shells interactively without assuming login support", () => {
    expect(resolveTerminalCommand("/bin/sh", "linux")).toEqual(["/bin/sh", "-i"]);
  });

  test.each(["powershell.exe", "cmd.exe"])(
    "preserves %s interactive startup on Windows",
    (shell) => {
      expect(resolveTerminalCommand(shell, "win32")).toEqual([shell]);
    },
  );
});

test("finds machine PowerShell 7 and the user ZIP installer's default outside PATH", () => {
  expect(
    terminalShellCandidates("win32", {
      programfiles: "C:\\Program Files",
      localappdata: "C:\\Users\\测试\\AppData\\Local",
    }),
  ).toEqual([
    "pwsh.exe",
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Users\\测试\\AppData\\Local\\Microsoft\\PowerShell\\pwsh.exe",
    "powershell.exe",
    "cmd.exe",
  ]);
});

test("terminal children have one Windows PATH and no inherited Electron Node mode", () => {
  expect(
    buildTerminalEnvironment(
      {
        Path: "old",
        PATH: "new",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--inspect",
        term: "inherited-terminal",
        TERMINFO: "keep-on-windows",
      },
      "win32",
    ),
  ).toEqual({ PATH: "new", TERM: "xterm-256color", TERMINFO: "keep-on-windows" });
});

test("prefers PowerShell 7 and retains Windows PowerShell and cmd fallbacks", () => {
  expect(
    terminalShellCandidates("win32", {
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    }),
  ).toEqual([
    "pwsh.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "powershell.exe",
    "C:\\Windows\\System32\\cmd.exe",
    "cmd.exe",
  ]);
});

test("starts the Git Bash console wrapper as an interactive login shell", () => {
  expect(resolveTerminalCommand("C:\\Program Files\\Git\\bin\\bash.exe", "win32")).toEqual([
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "--login",
    "-i",
  ]);
});

test("Git Bash preserves the host cwd and inherited task CLI PATH during login", () => {
  const env = buildTerminalEnvironment(
    {
      Path: "C:\\Profile\\runtime\\agent-cli\\bin;C:\\Windows\\System32",
      CODEX_THREAD_ID: "task-1",
      CHERE_INVOKING: "0",
      MSYS2_PATH_TYPE: "strict",
      original_path: "C:\\stale-shell-path",
    },
    "win32",
    "C:\\Git\\bin\\bash.exe",
  );
  expect(env).toEqual({
    PATH: "C:\\Profile\\runtime\\agent-cli\\bin;C:\\Windows\\System32",
    CODEX_THREAD_ID: "task-1",
    CHERE_INVOKING: "1",
    MSYS2_PATH_TYPE: "inherit",
    TERM: "xterm-256color",
  });
});

effectIt.effect(
  "new terminal launches read the latest saved choice and rediscover removed shells",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => fs.mkdtempSync(path.join(tmpdir(), "nodex-terminal-preference-"))),
        (directory) => Effect.sync(() => fs.rmSync(directory, { recursive: true, force: true })),
      );
      const executable = path.join(root, "fixture.exe");
      fs.writeFileSync(executable, "fixture");
      const originalStat = fs.statSync;
      const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
      const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
      const installed = new Set([pwsh, bash]);
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(fs, "statSync").mockImplementation(((pathname: fs.PathLike) => {
            const name = String(pathname);
            if (installed.has(name)) return originalStat(executable);
            if (
              ["C:\\Program Files\\", "C:\\task-cli\\", "C:\\Windows\\"].some((prefix) =>
                name.startsWith(prefix),
              )
            ) {
              throw Object.assign(new Error("Fixture executable is not installed"), {
                code: "ENOENT",
              });
            }
            return originalStat(pathname);
          }) as typeof fs.statSync),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const settings = yield* makeApplicationSettings({
        hostHomeDirectory: root,
        environment: {},
        settingsPath: path.join(root, "config.toml"),
      });
      const context = yield* Layer.build(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              testLayer({
                platform: "win32",
                homeDirectory: root,
                environment: {
                  ProgramFiles: "C:\\Program Files",
                  Path: "C:\\task-cli;C:\\Windows\\System32",
                  CODEX_THREAD_ID: "task-1",
                },
              }),
              Layer.succeed(ApplicationSettings, settings),
            ),
          ),
        ),
      );
      const terminal = Context.get(context, TerminalEnvironment);
      const input = { sessionId: "test", cwd: root };
      const first = yield* terminal.resolve(input);
      expect(first.command).toBe(pwsh);
      yield* settings.update({
        type: "update-terminal-shell",
        input: { windowsShell: "git-bash" },
      });
      const second = yield* terminal.resolve(input);
      expect(second.command).toBe(bash);
      expect(second.args).toEqual(["--login", "-i"]);
      expect(second.cwd).toBe(root);
      expect(second.env.PATH).toBe("C:\\task-cli;C:\\Windows\\System32");
      expect(second.env.CODEX_THREAD_ID).toBe("task-1");
      expect(first.command).toBe(pwsh);
      installed.delete(bash);
      expect(yield* terminal.availableShells).toEqual(["pwsh"]);
      expect((yield* terminal.resolve(input)).command).toBe(pwsh);
      expect((yield* settings.snapshot()).terminalShell.windowsShell).toBe("git-bash");
    }),
);
