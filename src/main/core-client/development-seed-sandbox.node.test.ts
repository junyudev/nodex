import { localProjectSourceRoots } from "../../shared/project-sources";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { CoreClientSeedAdapter } from "../../../scripts/scenarios/adapters/core-client-seed-adapter";
import { runScenarioProjectWorkspace } from "../../../scripts/scenarios/adapters/core-client-seed-runtime";
import { materializeDevelopmentSeed } from "../../../scripts/scenarios/harness/development-seed";
import {
  cleanupIsolatedProfile,
  createIsolatedProfile,
  waitForCoreRuntimeRemoval,
} from "../../../scripts/scenarios/profile/isolated-profile";
import { listScenarioIds } from "../../../scripts/scenarios/registry";
import { assertSeededSourceFolder } from "../../../scripts/scenarios/seed/source-folder";
import { initializeStandaloneDataAuthority, type RustDataAuthorityRuntime } from "./index";

const execFileAsync = promisify(execFile);

test.each(listScenarioIds())(
  "development seed %s keeps every Project and scheduled cwd in its disposable repo",
  async (scenarioId) => {
    const profile = await createIsolatedProfile({ label: `seed-source:${scenarioId}` });
    let runtime: RustDataAuthorityRuntime | null = null;
    try {
      const manifest = await materializeDevelopmentSeed({
        scenarioId,
        nodexHome: profile.nodexHome,
      });
      const source = await assertSeededSourceFolder(profile.runRoot, scenarioId);
      expect(path.relative(profile.runRoot, source)).toMatch(/^workspace[/\\][^/\\]+$/u);
      expect(source.startsWith(`${profile.repositoryRealpath}${path.sep}`)).toBe(false);
      runtime = await initializeStandaloneDataAuthority({
        buildId: "test:development-seed-source",
        isPackaged: false,
        nodexHome: profile.nodexHome,
      });
      const projects = await runScenarioProjectWorkspace(
        runtime,
        (workspace) => workspace.listProjects,
      );
      expect(projects.some((project) => project.id === manifest.projectId)).toBe(true);
      expect(
        projects.every(
          (project) =>
            project.primaryWorkspaceRoot &&
            localProjectSourceRoots(project.sources).includes(project.primaryWorkspaceRoot),
        ),
      ).toBe(true);
      const roots = projects.flatMap((project) => localProjectSourceRoots(project.sources));
      expect(roots.length).toBeGreaterThan(0);
      const gitRoot = (
        await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: source })
      ).stdout.trim();
      expect(path.resolve(gitRoot)).toBe(source);
      const seed = new CoreClientSeedAdapter(runtime);
      const tasks = await seed.readAutomations();
      // Some scenarios put Project files in a dedicated directory inside the seeded repo.
      for (const directory of new Set([...roots, ...tasks.flatMap((task) => task.cwds)])) {
        const relative = path.relative(source, await realpath(directory));
        expect(path.isAbsolute(relative) || relative.split(path.sep)[0] === "..", directory).toBe(
          false,
        );
      }
    } finally {
      if (runtime) {
        await runtime.rootClient.shutdown();
        await waitForCoreRuntimeRemoval(profile.nodexHome);
      }
      expect(await cleanupIsolatedProfile(profile)).toEqual({ status: "deleted" });
    }
  },
  90_000,
);
