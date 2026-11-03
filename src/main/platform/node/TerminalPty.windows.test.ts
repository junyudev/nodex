import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Option from "effect/Option";
import { prepareNodexCliShell, composeNodexCliShellEnvironment } from "./NodexCliShell";
import { buildTerminalEnvironment, resolveTerminalCommand } from "./TerminalEnvironment";
import {
  discoverWindowsTerminalShells,
  resolveWindowsTerminalShell,
} from "./WindowsTerminalShells";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { homedir } from "node:os";
import { testLayer } from "../../app/MainConfig";
import { live, TerminalPty } from "./TerminalPty";

it.live.runIf(process.platform === "win32")(
  "publishes a real ConPTY PID before accepting input and releases its process",
  () =>
    Effect.gen(function* () {
      const terminal = yield* TerminalPty;
      const handle = yield* terminal.spawn({
        command: "cmd.exe",
        args: ["/d", "/q"],
        cwd: homedir(),
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        cols: 80,
        rows: 24,
      });
      expect(handle.pid).toBeGreaterThan(0);
      yield* handle.write("echo NODEX_PTY_READY\r");
      yield* handle.output.pipe(
        Stream.scan(
          () => "",
          (output, chunk) => (output + chunk).slice(-4096),
        ),
        Stream.filter((data) => data.includes("NODEX_PTY_READY")),
        Stream.runHead,
        Effect.timeout("15 seconds"),
      );
      yield* handle.write("exit 0\r");
      const exited = yield* handle.exit.pipe(Effect.timeout("10 seconds"));
      expect(exited.exitCode).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(live.pipe(Layer.provide(testLayer({ platform: "win32" })))),
    ),
);

const gitBash =
  process.platform === "win32"
    ? discoverWindowsTerminalShells(process.env, homedir()).find((shell) => shell.id === "git-bash")
    : undefined;

it.live.runIf(process.platform === "win32" && gitBash !== undefined)(
  "runs Git Bash through ConPTY with its Windows cwd, environment and task CLI path",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "nodex Git Bash 测试 "))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const cwd = join(root, "workspace with spaces");
      yield* Effect.promise(() => mkdir(cwd));
      yield* Effect.promise(() => writeFile(join(cwd, "cwd-marker"), "requested-cwd"));
      yield* Effect.promise(() => prepareNodexCliShell(root, "win32"));
      const routing = yield* Effect.promise(() =>
        composeNodexCliShellEnvironment({
          nodexHome: root,
          platform: "win32",
          searchPaths: [],
          homeDirectory: homedir(),
          inheritedEnvironment: process.env,
        }),
      );
      const command = resolveWindowsTerminalShell(process.env, homedir(), "git-bash");
      const [executable, ...args] = resolveTerminalCommand(command, "win32");
      const env = buildTerminalEnvironment(
        {
          ...process.env,
          ...routing,
          CODEX_THREAD_ID: "terminal-shell-test",
          NODEX_PTY_MARKER: "environment-kept",
          ORIGINAL_PATH: "C:\\Windows\\System32",
        },
        "win32",
        command,
      );
      const terminal = yield* TerminalPty;
      const handle = yield* terminal.spawn({
        command: executable,
        args,
        cwd,
        env,
        cols: 160,
        rows: 32,
      });
      expect(handle.pid).toBeGreaterThan(0);
      // Require evaluated output: the marker is assembled so echoed input cannot satisfy it.
      yield* handle.write(
        "printf '\\n%s%s:%s:%s\\n' NODEX_ GIT_BASH \"$NODEX_PTY_MARKER\" \"$CODEX_THREAD_ID\"; printf '%s%s:%s\\n' NODEX_ CWD \"$(cat cwd-marker)\"; printf '%s%s:%s\\n' NODEX_ CLI \"$(command -v nodex)\"; printf '%s%s\\n' NODEX_ FINISHED\r",
      );
      const output = yield* handle.output.pipe(
        Stream.scan(
          () => "",
          (current, chunk) => (current + chunk).slice(-32768),
        ),
        Stream.filter((data) => data.includes("NODEX_FINISHED")),
        Stream.runHead,
        Effect.timeout("20 seconds"),
      );
      expect(Option.isSome(output)).toBe(true);
      const data = Option.getOrThrow(output)
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replaceAll("\r", "");
      expect(data).toContain("NODEX_GIT_BASH:environment-kept:terminal-shell-test");
      expect(data).toContain("NODEX_CWD:requested-cwd");
      expect(data).toMatch(/NODEX_CLI:.*\/runtime\/agent-cli\/bin\/nodex\n/);
      yield* handle.write("exit 0\r");
      expect((yield* handle.exit.pipe(Effect.timeout("10 seconds"))).exitCode).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(live.pipe(Layer.provide(testLayer({ platform: "win32" })))),
    ),
);
