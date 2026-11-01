/* @effect-diagnostics asyncFunction:off -- Exercises Windows shell processes and filesystem routing. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import {
  bindNodexCliShell,
  composeNodexCliShellEnvironment,
  nodexCliShellPaths,
  prepareNodexCliShell,
  unbindNodexCliShell,
} from "./NodexCliShell";

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

test.runIf(process.platform === "win32")(
  "routes PowerShell and cmd to the current task and denies a revoked child binding",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "nodex shell 汉字 ' "));
    try {
      const executable = join(root, "probe.ps1");
      await writeFile(
        executable,
        "@{ home = $env:NODEX_HOME; attribution = $env:NODEX_AGENT_ATTRIBUTION; arguments = @($args) } | ConvertTo-Json -Compress\n",
      );
      await prepareNodexCliShell(root, "win32");
      await bindNodexCliShell({
        nodexHome: root,
        platform: "win32",
        threadId: "parent",
        executable,
        profileId: "profile",
        projectId: "project",
        agentAttribution: "credential",
      });
      const routing = await composeNodexCliShellEnvironment({
        nodexHome: root,
        platform: "win32",
        homeDirectory: root,
        inheritedEnvironment: process.env,
        searchPaths: [],
      });
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
        ),
        ...routing,
        CODEX_THREAD_ID: "child",
        CODEX_SESSION_ID: "parent",
      };
      const dispatcher = join(nodexCliShellPaths(root).bin, "nodex.cmd");
      const shells = [
        [
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `& ${quote(dispatcher)} context 'space 汉字'`,
          ],
        ],
        ["cmd.exe", ["/d", "/s", "/c", `""${dispatcher}" context "space 汉字""`]],
      ] as const;
      for (const [shell, args] of shells) {
        const result = await execute(shell, [...args], {
          env,
          cwd: tmpdir(),
          encoding: "utf8",
          windowsHide: true,
          windowsVerbatimArguments: shell === "cmd.exe",
        });
        expect(JSON.parse(result.stdout)).toEqual({
          home: root,
          attribution: "credential",
          arguments: [
            "--expect-profile",
            "profile",
            "--project",
            "project",
            "context",
            "space 汉字",
          ],
        });
      }
      await unbindNodexCliShell(root, "child", "win32");
      await expect(execute("powershell.exe", [...shells[0][1]], { env })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
