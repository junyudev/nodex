/* @effect-diagnostics asyncFunction:off -- Exercises the native Windows command interpreter and Git. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, test } from "vite-plus/test";
import { runCodexGitCommand } from "../../codex/codex-git-command";
import { GitCommandPlatform } from "../../git-worker/git-command-platform";
import { nodeLive } from "./GitCommandPlatformNode";
import { resolveGitLaunch } from "./git-launch";

test("native Git takes priority over a PATH batch shim", () => {
  const launch = resolveGitLaunch(
    ["status"],
    { Path: "C:\\shim;C:\\Git\\cmd", PATHEXT: ".CMD;.EXE" },
    "win32",
    (file) => ["C:\\shim\\git.cmd", "C:\\Git\\cmd\\git.exe"].includes(file),
  );
  expect(launch).toMatchObject({
    command: "C:\\Git\\cmd\\git.exe",
    args: ["status"],
    shell: false,
  });
  expect(launch.env.PATH).toBe("C:\\shim;C:\\Git\\cmd");
});

test("batch fallback uses the captured ComSpec and escapes command arguments", () => {
  const launch = resolveGitLaunch(
    ["a & b"],
    { PATH: "C:\\shim", PATHEXT: ".CMD", comspec: "C:\\Windows\\System32\\cmd.exe" },
    "win32",
    (file) => file === "C:\\shim\\git.cmd",
  );
  expect(launch.shell).toBe("C:\\Windows\\System32\\cmd.exe");
  expect(launch.env.comspec).toBe("C:\\Windows\\System32\\cmd.exe");
});

test("batch launchers reject command-line separators that cmd cannot quote safely", () => {
  expect(() =>
    resolveGitLaunch(
      ["message\r\necho injected"],
      { PATH: "C:\\shim", PATHEXT: ".CMD" },
      "win32",
      (file) => file === "C:\\shim\\git.cmd",
    ),
  ).toThrow("line breaks");
});

it.live.runIf(process.platform === "win32")(
  "both Git launchers round-trip batch arguments through cmd without evaluation",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "nodex git 汉字 & "))),
        (directory) =>
          Effect.promise(() =>
            rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
          ),
      );
      const git = execFileSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true })
        .trim()
        .split(/\r?\n/)[0]!;
      yield* Effect.promise(() => writeFile(join(root, "git.cmd"), `@echo off\r\n"${git}" %*\r\n`));
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
        ),
        PATH: root,
        PATHEXT: ".CMD;.BAT",
        NODEX_GIT_PROBE: "expanded",
      };
      const platform = yield* GitCommandPlatform;
      for (const value of [
        "space 汉字",
        "a & echo injected > sentinel.txt",
        "%NODEX_GIT_PROBE%",
        "!NODEX_GIT_PROBE!",
        '"quoted" trailing\\',
        "a|b^(c)",
      ]) {
        const args = ["-c", `test.value=${value}`, "config", "--get", "test.value"];
        const ordinary = yield* Effect.promise(() => runCodexGitCommand(args, root, { env }));
        expect(ordinary.stdout.trimEnd()).toBe(value);
        const worker = yield* platform.run({
          args,
          cwd: root,
          environment: env,
          outputBytesCap: 4096,
          timeoutMs: 10000,
        });
        expect(worker).toMatchObject({ code: 0, failureReason: null });
        expect(worker.stdout.trimEnd()).toBe(value);
      }
    }).pipe(Effect.scoped, Effect.provide(nodeLive)),
);
