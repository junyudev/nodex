/* oxlint-disable nodex/no-manual-effect-runtime-in-tests -- This Node integration test bridges the existing Promise-based isolated Core scenario harness and real shell subprocesses. */
/* @effect-diagnostics asyncFunction:off -- This Node integration test bridges the existing Promise-based isolated Core scenario harness and real shell subprocesses. */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vite-plus/test";
import { MainConfig, testLayer } from "../../app/MainConfig";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import { withCoreScenario } from "../../../../scripts/scenarios/harness/core-scenario-harness";
import {
  buildAgentRuntimeCliContext,
  buildNodexCliBootstrap,
  type NodexCliTaskContext,
} from "./NodexCliBootstrap";
import type { NodexAgentTurnContext } from "../../../shared/nodex-agent-authority";
import {
  nodexCliShellLaunchArgs,
  nodexCliShellPaths,
  prepareNodexCliShell,
  bindNodexCliShell,
  shellQuote,
} from "./NodexCliShell";

const exec = promisify(execFile);

const task: NodexCliTaskContext = {
  threadId: "thread-a",
  hostId: "local",
  projectId: "project",
};
const identity = { profileId: "profile:test", libraryId: "library:test", storeEpoch: "epoch:test" };
const config = Effect.runSync(MainConfig.pipe(Effect.provide(testLayer())));

describe("Nodex per-Turn CLI connection", () => {
  test("routes Agent shell work through the exact build, Profile and Project", async () => {
    const root = await mkdtemp(join(tmpdir(), "nodex runtime ' "));
    try {
      const bin = join(root, "bin");
      const skill = join(root, ".generated/official-agent-skills/skills/nodex");
      await mkdir(bin, { recursive: true });
      await mkdir(skill, { recursive: true });
      await symlink(requiredNativeExecutable("cli"), join(bin, "nodex"));
      await symlink(resolve("agent-skills/nodex/SKILL.md"), join(skill, "SKILL.md"));
      await withCoreScenario({ scenarioId: "library/files" }, async (current) => {
        const selected = {
          ...config,
          projectRootPath: root,
          nodexHome: current.profile.nodexHome,
          environment: { NODEX_CORE_EXECUTABLE: join(bin, "nodex-core") },
        };
        const authority: NodexAgentTurnContext = {
          threadId: "engine:thread",
          turnId: "run:turn",
          rootThreadId: "session:root",
          libraryId: current.runtime.identity.libraryId,
          storeEpoch: current.runtime.identity.storeEpoch,
          admittedAtMs: 1,

          actorProjectId: current.manifest.projectId,
        };
        const context = await Effect.runPromise(
          buildAgentRuntimeCliContext(selected, current.runtime.identity, authority, null),
        );
        expect(context).not.toBeNull();
        const command = context!
          .split("For shell content work, use ")[1]!
          .split(" followed by the command")[0]!;
        const result = await exec("/bin/sh", ["-c", `${command} --json context`], {
          cwd: tmpdir(),
          env: { PATH: "/usr/bin:/bin", NODEX_HOME: join(root, "wrong-profile") },
        });
        const actual = JSON.parse(result.stdout).result;
        expect(actual.profile.id).toBe(current.runtime.identity.profileId);
        expect(actual.project.id).toBe(current.manifest.projectId);
        const projectless = await Effect.runPromise(
          buildAgentRuntimeCliContext(
            selected,
            current.runtime.identity,
            { ...authority, actorProjectId: null },
            null,
          ),
        );
        expect(projectless).not.toBeNull();
        expect(
          await Effect.runPromise(
            buildAgentRuntimeCliContext(
              { ...selected, platform: "win32" },
              current.runtime.identity,
              authority,
              "codex-task",
            ),
          ),
        ).toBeNull();
        // A Codex shell names its task, so plain nodex reaches this Profile and Project.
        await prepareNodexCliShell(current.profile.nodexHome);
        const bound = await Effect.runPromise(
          buildAgentRuntimeCliContext(selected, current.runtime.identity, authority, "codex-task"),
        );
        expect(bound).toContain("Use nodex directly");
        const plain = await exec("/bin/sh", ["-c", "nodex context"], {
          cwd: tmpdir(),
          env: {
            PATH: `${nodexCliShellPaths(current.profile.nodexHome).bin}:/usr/bin:/bin`,
            CODEX_THREAD_ID: "codex-task",
            NODEX_HOME: join(root, "wrong-profile"),
          },
        });
        const routed = JSON.parse(plain.stdout).result;
        expect(routed.profile.id).toBe(current.runtime.identity.profileId);
        expect(routed.project.id).toBe(current.manifest.projectId);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
  test("withholds the connection outside verified local execution and when artifacts are missing", async () => {
    for (const [override, reason] of [
      [{ hostId: "remote" }, "remote execution host"],
      [{}, "unavailable"],
    ] as const) {
      const result = await Effect.runPromise(
        buildNodexCliBootstrap(config, identity, { ...task, ...override }),
      );
      expect(result.kind).toBe("application");
      expect(result.value).toContain(reason);
      expect(result.value).not.toContain("/usr/bin/env NODEX_HOME=");
    }
  });

  test("plain nodex refreshes task routing and checks Profile identity from unrelated directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "nodex bootstrap ' "));
    try {
      const bin = join(root, "bin");
      const skillRoot = join(root, ".generated/official-agent-skills/skills/nodex");
      await mkdir(bin, { recursive: true });
      await mkdir(skillRoot, { recursive: true });
      await symlink(requiredNativeExecutable("cli"), join(bin, "nodex"));
      await symlink(resolve("agent-skills/nodex/SKILL.md"), join(skillRoot, "SKILL.md"));
      await withCoreScenario({ scenarioId: "library/files" }, async (first) => {
        await withCoreScenario({ scenarioId: "library/files" }, async (second) => {
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
            exec("/bin/sh", ["-c", "nodex context"], {
              cwd: root,
              env: {
                PATH: nodexCliShellPaths(first.profile.nodexHome).bin,
                CODEX_THREAD_ID: threadId,
                ...(sessionId ? { CODEX_SESSION_ID: sessionId } : {}),
              },
            });
          await Promise.all([
            Effect.runPromise(
              buildNodexCliBootstrap(firstConfig, first.runtime.identity, {
                ...task,
                projectId: first.manifest.projectId,
              }),
            ),
            Effect.runPromise(
              buildNodexCliBootstrap(firstConfig, first.runtime.identity, {
                ...task,
                threadId: "thread-b",
                projectId: otherProject.id,
              }),
            ),
          ]);
          const userShellHome = join(root, "user-shell");
          const otherBin = join(root, "old-cli");
          await mkdir(userShellHome);
          await mkdir(otherBin);
          await writeFile(join(otherBin, "nodex"), "#!/bin/sh\nprintf old-cli\n", { mode: 0o700 });
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
              PATH: "/usr/bin:/bin",
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
          const shells = process.platform === "darwin" ? ["/bin/zsh", "/bin/bash"] : ["/bin/bash"];
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
          const concurrent = await Promise.all([runContext(task.threadId), runContext("thread-b")]);
          expect(concurrent.map((entry) => JSON.parse(entry.stdout).result.project.id)).toEqual([
            first.manifest.projectId,
            otherProject.id,
          ]);
          expect(
            JSON.parse((await runContext("spawned-child", task.threadId)).stdout).result.project.id,
          ).toBe(first.manifest.projectId);
          await Effect.runPromise(
            buildNodexCliBootstrap(firstConfig, first.runtime.identity, {
              ...task,
              threadId: "spawned-child",
              projectId: otherProject.id,
            }),
          );
          expect(
            JSON.parse((await runContext("spawned-child", task.threadId)).stdout).result.project.id,
          ).toBe(otherProject.id);
          await Effect.runPromise(
            buildNodexCliBootstrap(firstConfig, first.runtime.identity, {
              ...task,
              projectId: first.manifest.projectId,
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
            stderr: expect.stringContaining("no valid task binding"),
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
                current.runtime.identity,
                { ...task, projectId },
              ),
            );
            expect(entry.value).toContain("Use nodex directly");
            expect(entry.value).toContain(shellQuote(projectId));
            expect(entry.value).toContain(shellQuote(join(skillRoot, "SKILL.md")));
            const env = {
              PATH: nodexCliShellPaths(current.profile.nodexHome).bin,
              CODEX_THREAD_ID: task.threadId,
              NODEX_HOME: second.profile.nodexHome,
            };
            const result = await exec("/bin/sh", ["-c", "nodex --json context"], {
              cwd: root,
              env,
              maxBuffer: 1024 * 1024,
            });
            const context = JSON.parse(result.stdout).result;
            expect(context.profile.id).toBe(current.runtime.identity.profileId);
            expect(context.project.id).toBe(projectId);
            if (projectId === otherProject.id) continue;
            const pageId = current.manifest.pageIdsByKey.sharedImageA;
            const body = await exec("/bin/sh", ["-c", `nodex read '@${pageId}'`], {
              cwd: root,
              env,
            });
            expect(body.stdout).toContain("Shared image A");
            await bindNodexCliShell({
              nodexHome: current.profile.nodexHome,
              threadId: task.threadId,
              executable: join(bin, "nodex"),
              profileId: "wrong-profile",
              projectId,
            });
            const rejected = await exec(
              "/bin/sh",
              ["-c", `nodex page rename '${pageId}' --if-match unused 'Unexpected title'`],
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
                home: current.profile.nodexHome,
              },
            });
            await bindNodexCliShell({
              nodexHome: current.profile.nodexHome,
              threadId: task.threadId,
              executable: join(bin, "nodex"),
              profileId: current.runtime.identity.profileId,
              projectId,
            });
            const unchanged = await exec("/bin/sh", ["-c", `nodex read '${pageId}'`], {
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
  }, 60_000);
});
