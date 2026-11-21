import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import release from "../../../../resources/agent-runtime/codex-app-server.lock.json";
import { classifyCodexExecutable, probeCodexExecutable } from "./CodexExecutable";

test.each([
  ["codex-cli 0.0.0", { status: "too-old", version: "0.0.0" }],
  ["codex-cli 0.140.9", { status: "too-old", version: "0.140.9" }],
  ["codex-cli 0.141.0-alpha.1", { status: "too-old", version: "0.141.0-alpha.1" }],
  ["codex-cli 0.141.0", { status: "ready", version: "0.141.0" }],
  [
    `codex-cli ${release.appServerRuntimeVersion}`,
    { status: "ready", version: release.appServerRuntimeVersion },
  ],
  ["codex-cli 0.170.1", { status: "ready", version: "0.170.1" }],
  ["oops", { status: "invalid-version" }],
])("classifies the external Codex version output %s", (output, classification) => {
  expect(classifyCodexExecutable(output, "/p/codex")).toMatchObject(classification);
});

test.skipIf(process.platform === "win32")(
  "probes only executable files in a credential-free home",
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nodex-executable-fixture-"));
    try {
      const bin = path.join(home, "bin");
      await mkdir(bin);
      const executable = path.join(bin, "codex");
      await writeFile(
        executable,
        '#!/bin/sh\n[ "$1" = "--version" ] && [ "$CODEX_HOME" = "$HOME" ] && [ -z "$OPENAI_API_KEY" ] && [ ! -e "$CODEX_HOME/auth.json" ] || exit 1\nprintf "codex-cli 0.170.1\\n"\n',
        { mode: 0o755 },
      );
      await writeFile(path.join(home, "auth.json"), "{}");
      await writeFile(path.join(bin, "broken"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const probe = (command: string) =>
        probeCodexExecutable({
          executable: command,
          home,
          platform: process.platform,
          environment: { HOME: home, CODEX_HOME: home, PATH: bin, OPENAI_API_KEY: "fixture" },
          signal: new AbortController().signal,
        });
      for (const command of ["codex", "~/bin/codex", executable]) {
        const result = await probe(command);
        expect(result).toMatchObject({ status: "ready", version: "0.170.1" });
        if (result.status === "ready") expect(path.isAbsolute(result.binaryPath)).toBe(true);
      }
      for (const command of [bin, "missing", "bin/codex"]) {
        await expect(probe(command)).resolves.toEqual({ status: "not-found" });
      }
      await expect(probe("broken")).resolves.toEqual({ status: "probe-failed" });
      await chmod(executable, 0o644);
      await expect(probe(executable)).resolves.toEqual({ status: "not-found" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
