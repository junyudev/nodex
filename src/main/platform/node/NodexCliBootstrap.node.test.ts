/* oxlint-disable nodex/no-manual-effect-runtime-in-tests -- This Node integration test bridges the existing Promise-based isolated Core scenario harness and real shell subprocesses. */
/* @effect-diagnostics asyncFunction:off -- This Node integration test bridges the existing Promise-based isolated Core scenario harness and real shell subprocesses. */
import { execFile, type ExecFileOptions } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vite-plus/test";
import { MainConfig, testLayer } from "../../app/MainConfig";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import { withAgentCliScenario } from "../../../../scripts/scenarios/harness/agent-cli-gateway";
import { buildNodexCliBootstrap, type NodexCliTaskContext } from "./NodexCliBootstrap";
import {
  nodexCliShellLaunchArgs,
  nodexCliShellPaths,
  prepareNodexCliShell,
  shellQuote,
} from "./NodexCliShell";

const exec = promisify(execFile);

const cliName = process.platform === "win32" ? "nodex.exe" : "nodex";
const runShell = (command: string, options: ExecFileOptions) => {
  if (process.platform !== "win32")
    return exec("/bin/sh", ["-c", command], { ...options, encoding: "utf8" });
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  return exec(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      ...options,
      env: { ...inherited, ...options?.env },
      windowsHide: true,
      encoding: "utf8",
    },
  );
};
const shellPath = (bin: string) =>
  [
    bin,
    ...(process.platform === "win32"
      ? [process.env.PATH ?? process.env.Path ?? ""]
      : ["/usr/bin", "/bin"]),
  ].join(delimiter);

const task: NodexCliTaskContext = {
  threadId: "thread-a",
  hostId: "local",
  scopedConnection: { endpoint: "http://127.0.0.1:10000", credential: "fixture" },
};
const config = Effect.runSync(
  MainConfig.pipe(Effect.provide(testLayer({ platform: process.platform }))),
);

describe("Nodex per-Turn CLI connection", () => {
  test("withholds the connection outside verified local execution and when artifacts are missing", async () => {
    for (const [override, reason] of [
      [{ hostId: "remote" }, "remote execution host"],
      [{}, "unavailable"],
    ] as const) {
      const result = await Effect.runPromise(
        buildNodexCliBootstrap(config, { ...task, ...override }),
      );
      expect(result.kind).toBe("application");
      expect(result.value).toContain(reason);
      expect(result.value).not.toContain("/usr/bin/env NODEX_HOME=");
    }
  });

  // Two Profiles and repeated fresh CLI processes share I/O with native scenario workers.
  test("plain nodex refreshes task routing and checks Profile identity from unrelated directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "nodex bootstrap ' "));
    try {
      const bin = join(root, "bin");
      const skillRoot = join(root, ".generated/official-agent-skills/skills/nodex");
      await mkdir(bin, { recursive: true });
      await mkdir(skillRoot, { recursive: true });
      await copyFile(requiredNativeExecutable("cli"), join(bin, cliName));
      await copyFile(
        requiredNativeExecutable("core-server"),
        join(bin, process.platform === "win32" ? "nodex-core.exe" : "nodex-core"),
      );
      await copyFile(resolve("agent-skills/nodex/SKILL.md"), join(skillRoot, "SKILL.md"));
      await withAgentCliScenario({ scenarioId: "library/files" }, async (first, issueFirst) => {
        await withAgentCliScenario({ scenarioId: "library/files" }, async (second, issueSecond) => {
          await prepareNodexCliShell(first.profile.nodexHome);
          await prepareNodexCliShell(second.profile.nodexHome);
          const otherProject = await first.seed.createProject({
            name: "Other bootstrap Project",
            sources: [root],
          });
          const firstConfig = {
            ...config,
            projectRootPath: root,
            nodexHome: first.profile.nodexHome,
            environment: { NODEX_CORE_EXECUTABLE: join(bin, "nodex-core") },
          };
          const runContext = (threadId: string, sessionId?: string) =>
            runShell("nodex context", {
              cwd: root,
              env: {
                PATH: shellPath(nodexCliShellPaths(first.profile.nodexHome).bin),
                CODEX_THREAD_ID: threadId,
                ...(sessionId ? { CODEX_SESSION_ID: sessionId } : {}),
              },
            });
          await Promise.all([
            Effect.runPromise(
              buildNodexCliBootstrap(firstConfig, {
                ...task,
                scopedConnection: await issueFirst(task.threadId),
              }),
            ),
            Effect.runPromise(
              buildNodexCliBootstrap(firstConfig, {
                ...task,
                threadId: "thread-b",
                scopedConnection: await issueFirst("thread-b", otherProject.id),
              }),
            ),
          ]);
          // Unix startup files are separate from the PowerShell/cmd dispatch contract.
          if (process.platform !== "win32") {
            const userShellHome = join(root, "user-shell");
            const otherBin = join(root, "old-cli");
            await mkdir(userShellHome);
            await mkdir(otherBin);
            await writeFile(join(otherBin, "nodex"), "#!/bin/sh\nprintf old-cli\n", {
              mode: 0o700,
            });
            const startup = `export PATH='${otherBin.replaceAll("'", "'\\''")}':"$PATH"\nexport NODEX_STARTUP_MARKER=configured\n`;
            await writeFile(join(userShellHome, ".zshenv"), startup);
            await writeFile(join(userShellHome, "bash-env"), startup);
            const shellArgs = await nodexCliShellLaunchArgs({
              nodexHome: first.profile.nodexHome,
              codexHome: first.profile.codexHome,
              homeDirectory: userShellHome,
              inheritedEnvironment: {
                ZDOTDIR: userShellHome,
                BASH_ENV: join(userShellHome, "bash-env"),
                PATH: shellPath(""),
              },
              searchPaths: [],
            });
            const shellEnvironment = Object.fromEntries(
              shellArgs
                .filter((_, i) => i % 2 === 1)
                .map((value) => {
                  const equal = value.indexOf("=");
                  return [
                    value.slice("shell_environment_policy.set.".length, equal),
                    JSON.parse(value.slice(equal + 1)) as string,
                  ];
                }),
            );
            const shells =
              process.platform === "darwin" ? ["/bin/zsh", "/bin/bash"] : ["/bin/bash"];
            for (const shell of shells) {
              for (const mode of ["-c", "-lc"]) {
                const result = await exec(
                  shell,
                  [mode, 'test "$NODEX_STARTUP_MARKER" = configured && nodex context'],
                  {
                    cwd: root,
                    env: {
                      ...process.env,
                      ...shellEnvironment,
                      HOME: userShellHome,
                      CODEX_THREAD_ID: task.threadId,
                    },
                  },
                );
                expect(JSON.parse(result.stdout).result.project.id).toBe(first.manifest.projectId);
              }
            }
          }
          const concurrent = await Promise.all([runContext(task.threadId), runContext("thread-b")]);
          expect(concurrent.map((entry) => JSON.parse(entry.stdout).result.project.id)).toEqual([
            first.manifest.projectId,
            otherProject.id,
          ]);
          expect(
            JSON.parse((await runContext("spawned-child", task.threadId)).stdout).result.project.id,
          ).toBe(first.manifest.projectId);
          await Effect.runPromise(
            buildNodexCliBootstrap(firstConfig, {
              ...task,
              threadId: "spawned-child",
              scopedConnection: await issueFirst("spawned-child", otherProject.id),
            }),
          );
          expect(
            JSON.parse((await runContext("spawned-child", task.threadId)).stdout).result.project.id,
          ).toBe(otherProject.id);
          await Effect.runPromise(
            buildNodexCliBootstrap(firstConfig, {
              ...task,
              scopedConnection: await issueFirst(task.threadId),
            }),
          );
          expect(JSON.parse((await runContext(task.threadId)).stdout).result.project.id).toBe(
            first.manifest.projectId,
          );
          expect(JSON.parse((await runContext("thread-b")).stdout).result.project.id).toBe(
            otherProject.id,
          );
          await expect(runContext("missing-task")).rejects.toMatchObject({
            stderr: expect.stringContaining("unavailable"),
          });
          await expect(runContext("../thread-b")).rejects.toMatchObject({
            stderr: expect.stringContaining("AGENT_BINDING_MALFORMED"),
          });
          for (const [current, projectId] of [
            [first, first.manifest.projectId],
            [first, otherProject.id],
            [second, second.manifest.projectId],
            [first, first.manifest.projectId],
          ] as const) {
            const entry = await Effect.runPromise(
              buildNodexCliBootstrap(
                {
                  ...config,
                  projectRootPath: root,
                  nodexHome: current.profile.nodexHome,
                  environment: { NODEX_CORE_EXECUTABLE: join(bin, "nodex-core") },
                },
                {
                  ...task,
                  scopedConnection: await (current === first ? issueFirst : issueSecond)(
                    task.threadId,
                    projectId,
                  ),
                },
              ),
            );
            expect(entry.value).toContain("Run nodex for content work");
            expect(entry.value).toContain(shellQuote(join(skillRoot, "SKILL.md")));
            const env = {
              PATH: shellPath(nodexCliShellPaths(current.profile.nodexHome).bin),
              CODEX_THREAD_ID: task.threadId,
              NODEX_HOME: current.profile.nodexHome,
            };
            const result = await runShell("nodex --json context", {
              cwd: root,
              env,
              maxBuffer: 1024 * 1024,
            });
            const context = JSON.parse(result.stdout).result;
            expect(context.profile.id).toBe(current.runtime.identity.profileId);
            expect(context.project.id).toBe(projectId);
            if (current === first && projectId === first.manifest.projectId) {
              const alternate = await runShell("nodex --json context", {
                cwd: root,
                env: { ...env, NODEX_HOME: second.profile.nodexHome },
              });
              expect(JSON.parse(alternate.stdout).result).toMatchObject({
                profile: { id: second.runtime.identity.profileId, source: "environment" },
                actor: { type: "member" },
              });
            }
            if (projectId === otherProject.id) continue;
            const pageId = current.manifest.pageIdsByKey.sharedImageA;
            const body = await runShell(`nodex read '@${pageId}'`, {
              cwd: root,
              env,
            });
            expect(body.stdout).toContain("Shared image A");
            const rejected = await runShell(
              `nodex --expect-profile wrong-profile page rename '${pageId}' --if-match unused 'Unexpected title'`,
              {
                cwd: root,
                env,
              },
            ).then(
              () => {
                throw new Error("Mismatched Profile unexpectedly permitted a mutation");
              },
              (error: { stderr: string }) => JSON.parse(error.stderr),
            );
            expect(rejected.error).toMatchObject({
              code: "PROFILE_MISMATCH",
              details: {
                expected: "wrong-profile",
                actual: current.runtime.identity.profileId,
              },
            });
            const unchanged = await runShell(`nodex read '${pageId}'`, {
              cwd: root,
              env,
            });
            expect(unchanged.stdout).toBe(body.stdout);
          }
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
