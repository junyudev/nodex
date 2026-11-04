import { it as effectIt } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as Layer from "effect/Layer";
import fs from "node:fs";
import path from "node:path";
import os, { tmpdir } from "node:os";
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
  test.each(["/bin/zsh", "/bin/bash", "/bin/sh", "/opt/local/bin/fish"])(
    "starts the POSIX account shell %s with no extra arguments",
    (shell) => {
      expect(resolveTerminalCommand(shell, "darwin")).toEqual([shell]);
    },
  );

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

test("prefers the account shell and falls back to SHELL or the platform default", () => {
  const account = vi.spyOn(os, "userInfo");
  try {
    account.mockReturnValue({ ...os.userInfo(), shell: "/bin/account" });
    expect(terminalShellCandidates("darwin", { SHELL: "/bin/launcher" })).toEqual(["/bin/account"]);
    account.mockImplementation(() => {
      throw new Error("Account shell unavailable");
    });
    expect(terminalShellCandidates("darwin", { SHELL: "/bin/launcher" })).toEqual([
      "/bin/launcher",
    ]);
    expect(terminalShellCandidates("darwin", {})).toEqual(["/bin/zsh"]);
    expect(terminalShellCandidates("linux", {})).toEqual(["/bin/sh"]);
  } finally {
    account.mockRestore();
  }
});

const toolShell = {
  NO_COLOR: "1",
  FORCE_COLOR: "1",
  CLICOLOR_FORCE: "1",
  COLORTERM: "",
  TERM_PROGRAM: "Launcher",
  TERM_PROGRAM_VERSION: "1",
  TERM_SESSION_ID: "terminal",
  TERMCAP: "launch-terminal",
  COLUMNS: "100",
  LINES: "20",
  TMUX: "launch-mux",
  TMUX_PANE: "%1",
  STY: "launch-screen",
  WINDOW: "1",
  WINDOWID: "2",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
  AGENT: "1",
  DISABLE_AUTO_UPDATE: "true",
  ZSH_TMUX_AUTOSTART: "false",
  ZSH_TMUX_AUTOSTARTED: "true",
  CODEX_CI: "1",
  CODEX_THREAD_ID: "thread",
  CODEX_SESSION_ID: "session",
  CODEX_TOOL_CALL_ID: "call",
  CODEX_SHELL: "1",
  CODEX_PERMISSION_PROFILE: "tool-shell",
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "agent",
  CLAUDECODE: "1",
  BROWSER_USE_ACCESS_PIPE_PATH: "launcher.sock",
  CODEX_APP_TOOLS_PIPE_PATH: "launcher.sock",
  NODE_REPL_HOST_SERVICES_PIPE_PATH: "launcher.sock",
  SKY_CUA_SERVICE_PATH: "launcher.sock",
};
const userEnvironment = {
  CODEX_HOME: "/user/.codex",
  CODEX_USER_OPTION: "keep",
  PATH: "/usr/bin:/bin",
  LANG: "en_US.UTF-8",
  LC_TIME: "en_GB.UTF-8",
  LOG_FORMAT: "json",
  BROWSER_USE_CUSTOM_SETTING: "keep",
  USER_SETTING: "keep",
};

test.each(["darwin", "linux", "win32"])(
  "describes a fresh %s terminal when launched from a tool shell",
  (platform) => {
    const pollution =
      platform === "win32"
        ? Object.fromEntries(
            Object.entries(toolShell).map(([key, value]) => [key.toLowerCase(), value]),
          )
        : toolShell;
    expect(
      buildTerminalEnvironment({ ...pollution, ...userEnvironment, TERM: "dumb" }, platform),
    ).toEqual({ ...userEnvironment, TERM: "xterm-256color" });
  },
);

test("applies the login and worktree layers before final terminal and host settings", () => {
  expect(
    buildTerminalEnvironment(
      { ...toolShell, ...userEnvironment, TERMINFO: "/launch/terminfo", REMOVED: "launch" },
      "darwin",
      "/bin/zsh",
      {
        login: { NO_COLOR: "user-rc", REMOVED: "login", USER_SETTING: "login" },
        worktree: {
          version: 1,
          exclude: ["REMOVED", "USER_SETTING"],
          set: {
            USER_SETTING: "worktree",
            TERM: "other",
            TERMINFO_DIRS: "/worktree/terminfo",
            NODE_OPTIONS: "--inspect --no-warnings",
          },
        },
      },
    ),
  ).toEqual({
    ...userEnvironment,
    NO_COLOR: "user-rc",
    USER_SETTING: "worktree",
    TERM: "xterm-256color",
    NODE_OPTIONS: "--no-warnings",
  });
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
        live({
          login: () => Effect.die("Windows should not probe the login shell"),
          worktree: () => Effect.die("Windows should not load a worktree delta"),
        }).pipe(
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
      expect(second.env.CODEX_THREAD_ID).toBeUndefined();
      expect(first.command).toBe(pwsh);
      installed.delete(bash);
      expect(yield* terminal.availableShells).toEqual(["pwsh"]);
      expect((yield* terminal.resolve(input)).command).toBe(pwsh);
      expect((yield* settings.snapshot()).terminalShell.windowsShell).toBe("git-bash");
    }),
);

effectIt.effect("probes once on a clean base and reads each worktree using its resolved cwd", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => fs.mkdtempSync(path.join(tmpdir(), "nodex-terminal-environment-"))),
      (directory) => Effect.sync(() => fs.rmSync(directory, { recursive: true, force: true })),
    );
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const settings = yield* makeApplicationSettings({
      hostHomeDirectory: root,
      environment: {},
      settingsPath: path.join(root, "config.toml"),
    });
    const probe = vi.fn((base: NodeJS.ProcessEnv) =>
      Effect.succeed({
        ...base,
        NO_COLOR: "from-rc",
        ZSH_TMUX_AUTOSTARTED: "true",
      }),
    );
    const worktree = vi.fn((cwd: string) =>
      cwd === workspace
        ? Effect.succeed({ version: 1 as const, exclude: ["USER_SETTING"], set: { WORKTREE: "1" } })
        : Effect.fail(new Error("Unreadable worktree environment")),
    );
    const context = yield* Layer.build(
      live({ login: probe, worktree }).pipe(
        Layer.provide(
          Layer.mergeAll(
            testLayer({
              platform: "darwin",
              homeDirectory: root,
              environment: { ...toolShell, ...userEnvironment },
            }),
            Layer.succeed(ApplicationSettings, settings),
          ),
        ),
      ),
    );
    const terminal = Context.get(context, TerminalEnvironment);
    const first = yield* terminal.resolve({ sessionId: "first", cwd: workspace });
    const second = yield* terminal.resolve({
      sessionId: "second",
      cwd: path.join(root, "missing"),
    });
    expect(probe).toHaveBeenCalledExactlyOnceWith(
      { ...userEnvironment, TERM: "xterm-256color" },
      "darwin",
    );
    expect(worktree.mock.calls.map(([cwd]) => cwd)).toEqual([workspace, root]);
    expect(first.cwd).toBe(workspace);
    expect(first.env).toEqual({
      ...Object.fromEntries(
        Object.entries(userEnvironment).filter(([key]) => key !== "USER_SETTING"),
      ),
      NO_COLOR: "from-rc",
      TERM: "xterm-256color",
      WORKTREE: "1",
    });
    expect(second.env).toEqual({ ...userEnvironment, NO_COLOR: "from-rc", TERM: "xterm-256color" });
  }),
);

effectIt.effect("cancels a slow login probe and reuses the cleaned fallback", () =>
  Effect.gen(function* () {
    let interrupted = false;
    const probe = vi.fn(() =>
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );
    const context = yield* Layer.build(
      live({
        login: probe,
        worktree: () => Effect.succeed(null),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            testLayer({ platform: "darwin", environment: { ...toolShell, ...userEnvironment } }),
            Layer.succeed(ApplicationSettings, {} as ApplicationSettings["Service"]),
          ),
        ),
      ),
    );
    const terminal = Context.get(context, TerminalEnvironment);
    const pending = yield* terminal.resolve({ sessionId: "first" }).pipe(Effect.forkScoped);
    yield* TestClock.adjust("5 seconds");
    expect((yield* Fiber.join(pending)).env).toEqual({
      ...userEnvironment,
      TERM: "xterm-256color",
    });
    expect(interrupted).toBe(true);
    expect((yield* terminal.resolve({ sessionId: "second" })).env).toEqual({
      ...userEnvironment,
      TERM: "xterm-256color",
    });
    expect(probe).toHaveBeenCalledOnce();
  }),
);
