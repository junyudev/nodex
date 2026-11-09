import { localProjectSourceRoots } from "../../shared/project-sources";
import { execFile } from "node:child_process";
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
          (project) => project.sources.length > 0 && project.primaryWorkspaceRoot === source,
        ),
      ).toBe(true);
      // Includes the bootstrap Project and secondary Projects, not just the manifest's primary one.
      const roots = projects.flatMap((project) => localProjectSourceRoots(project.sources));
      expect(roots.length).toBeGreaterThan(0);
      expect(new Set(roots)).toEqual(new Set([source]));
      const gitRoot = (
        await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: source })
      ).stdout.trim();
      expect(path.resolve(gitRoot)).toBe(source);
      const seed = new CoreClientSeedAdapter(runtime);
      const tasks = await seed.readAutomations();
      expect(tasks.flatMap((task) => task.cwds).every((cwd) => path.resolve(cwd) === source)).toBe(
        true,
      );
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
