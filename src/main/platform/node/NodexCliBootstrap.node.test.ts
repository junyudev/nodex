/* oxlint-disable nodex/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/strict-effect-provide -- This Node integration test bridges the existing Promise-based isolated Core scenario harness and real shell subprocesses. */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vite-plus/test";
import { MainConfig, testLayer } from "../../app/MainConfig";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import { withCoreScenario } from "../../../../scripts/scenarios/harness/core-scenario-harness";
import { buildNodexCliBootstrap, type NodexCliTaskContext } from "./NodexCliBootstrap";

const exec = promisify(execFile);

const task: NodexCliTaskContext = {
  hostId: "local",
  projectId: "project",
  verifiedBuiltinFullAccess: true,
  planMode: false,
  sandboxPolicy: { type: "dangerFullAccess" },
};
const config = Effect.runSync(MainConfig.pipe(Effect.provide(testLayer())));

describe("Nodex per-Turn CLI connection", () => {
  test("withholds the connection outside verified local execution and when artifacts are missing", async () => {
    for (const [override, reason] of [
      [{ hostId: "remote" }, "remote execution host"],
      [{ projectId: null }, "no Project"],
      [{ planMode: true }, "Plan Mode"],
      [{ verifiedBuiltinFullAccess: false }, "Full access"],
      [{ sandboxPolicy: { type: "readOnly" } }, "runtime sandbox"],
      [{ sandboxPolicy: undefined }, "runtime sandbox"],
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

  test("executes the current CLI with no installed PATH and refreshes Profile and Project on each Turn", async () => {
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
          const otherProject = await first.seed.createProject({
            name: "Other bootstrap Project",
            sources: [root],
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
                  profileId: current.runtime.identity.profileId,
                  environment: { NODEX_CORE_EXECUTABLE: join(bin, "nodex-core") },
                },
                { ...task, projectId },
              ),
            );
            const prefix = entry.value
              .split("\n")
              .find((line) => line.startsWith("/usr/bin/env NODEX_HOME="));
            expect(prefix).toBeDefined();
            const result = await exec("/bin/sh", ["-c", `${prefix} --json context`], {
              cwd: root,
              env: { PATH: "", NODEX_HOME: second.profile.nodexHome },
              maxBuffer: 1024 * 1024,
            });
            const context = JSON.parse(result.stdout).result;
            expect(context.profile.id).toBe(current.runtime.identity.profileId);
            expect(context.project.id).toBe(projectId);
            if (projectId === otherProject.id) continue;
            const pageId = current.manifest.pageIdsByKey.sharedImageA;
            const body = await exec("/bin/sh", ["-c", `${prefix} read '@${pageId}'`], {
              cwd: root,
              env: { PATH: "", NODEX_HOME: second.profile.nodexHome },
            });
            expect(body.stdout).toContain("Shared image A");
          }
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
