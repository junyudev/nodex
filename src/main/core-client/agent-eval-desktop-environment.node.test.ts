import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { prepareDesktopEnvironment } from "../../../scripts/agent-eval/desktop-environment";
import { prepareNodexCliShell, bindNodexCliShell } from "../platform/node/NodexCliShell";
import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
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
        executable: requiredNativeExecutable("cli"),
        profileId: runtime.identity.profileId,
        projectId: manifest.projectId,
        agentAttribution: null,
      });
      // Windows PowerShell's native argument parser strips embedded quotes from Python -c.
      await writeFile(
        path.join(profile.initialProjectsDirectory, "read-selected-project.py"),
        'import pathlib\nprint(pathlib.Path("selected-project.txt").read_text(encoding="utf-8-sig").strip())\n',
      );
      const result = await promisify(execFile)(
        process.platform === "win32" ? "powershell.exe" : "/bin/bash",
        process.platform === "win32"
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              "$ErrorActionPreference='Stop'; nodex context | ConvertFrom-Json | ForEach-Object { $_.result.project.id } | Set-Content -Encoding utf8 selected-project.txt; python read-selected-project.py",
            ]
          : [
              "-c",
              "set -euo pipefail\nnodex context | jq -r '.result.project.id' > selected-project.txt\npython3 read-selected-project.py",
            ],
        {
          cwd: profile.initialProjectsDirectory,
          env: {
            ...process.env,
            ...environment,
            CODEX_THREAD_ID: "eval-test",
          },
          encoding: "utf8",
        },
      );
      expect(result.stdout.trim()).toBe(manifest.projectId);
      expect(result.stderr).toBe("");
    },
  );
});
