import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { prepareDesktopEnvironment } from "../../../scripts/agent-eval/desktop-environment";
import {
  prepareNodexCliShell,
  bindNodexCliShell,
  nodexCliShellPaths,
} from "../platform/node/NodexCliShell";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";

test("ordinary shell pipelines, redirects, jq and Python preserve development CLI routing", async () => {
  await withCoreScenario(
    { scenarioId: "agent/cli-workflow" },
    async ({ profile, manifest, runtime }) => {
      const { environment } = await prepareDesktopEnvironment({
        repository: process.cwd(),
        workspace: profile.initialProjectsDirectory,
        nodexHome: profile.nodexHome,
        codexHome: profile.codexHome,
        projectId: manifest.projectId,
      });
      await prepareNodexCliShell(profile.nodexHome);
      await bindNodexCliShell({
        nodexHome: profile.nodexHome,
        threadId: "eval-test",
        executable: `${process.cwd()}/target/debug/nodex`,
        profileId: runtime.identity.profileId,
        projectId: manifest.projectId,
      });
      const result = await promisify(execFile)(
        "/bin/bash",
        [
          "-c",
          "set -euo pipefail\nnodex context | jq -r '.result.project.id' > selected-project.txt\npython3 -c 'import pathlib; print(pathlib.Path(\"selected-project.txt\").read_text().strip())'",
        ],
        {
          cwd: profile.initialProjectsDirectory,
          env: {
            ...process.env,
            ...environment,
            CODEX_THREAD_ID: "eval-test",
            PATH: `${nodexCliShellPaths(profile.nodexHome).bin}:${process.env.PATH}`,
          },
          encoding: "utf8",
        },
      );
      expect(result.stdout.trim()).toBe(manifest.projectId);
      expect(result.stderr).toBe("");
    },
  );
});
