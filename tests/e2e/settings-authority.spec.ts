import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";

const fileEvidence = (filePath: string) => {
  const bytes = fs.readFileSync(filePath);
  const stats = fs.statSync(filePath);
  return {
    bytes,
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
};

test("isolates Profile settings without replacing the launcher HOME", async () => {
  test.setTimeout(90_000);
  const executablePath = process.env.NODEX_E2E_PACKAGED_EXECUTABLE;
  const externalHome = fs.mkdtempSync(path.join(os.tmpdir(), "ndx-settings-home-"));
  const externalConfigPath = path.join(externalHome, ".nodex", "config.toml");
  const externalProfilePath = path.join(externalHome, "external-profile");
  fs.mkdirSync(path.dirname(externalConfigPath), { recursive: true });
  fs.writeFileSync(
    externalConfigPath,
    `[server]\nhome = ${JSON.stringify(externalProfilePath)}\nhistory_retention = 999\n`,
  );
  const externalBefore = fileEvidence(externalConfigPath);
  const harness = await ElectronScenarioHarness.create({
    ...(executablePath ? { executablePath } : {}),
    label: executablePath ? "packaged-settings-authority" : "settings-authority",
    cwd: process.cwd(),
    environment: {
      HOME: externalHome,
      NODEX_CORE_IDLE_TIMEOUT_MS: "250",
      NODEX_LOG_CONSOLE: "0",
      NODEX_LOG_FILE: "1",
    },
    prepareAgentRuntime: false,
  });

  try {
    const managedRoot = path.join(harness.profile.runRoot, "managed-worktrees");
    fs.mkdirSync(managedRoot, { recursive: true });
    const legacyRoots = Array.from({ length: 128 }, (_, index) =>
      path.join(harness.profile.runRoot, `legacy-${index}`),
    );
    fs.writeFileSync(
      harness.profile.settingsPath,
      [
        "[server]",
        `worktree_root = ${JSON.stringify(managedRoot)}`,
        `worktree_known_roots = [${legacyRoots.map((root) => JSON.stringify(root)).join(", ")}]`,
        "history_retention = 4",
        "",
      ].join("\n"),
    );

    const page = await harness.launch();
    const result = await page.evaluate(
      async ({ nextRoot }) => {
        const api = window.api;
        if (!api) throw new Error("Nodex preload API is unavailable");
        const [worktrees, history] = (await Promise.all([
          api.invoke("worktrees:settings:update", {
            worktreeRoot: nextRoot,
            autoDeleteEnabled: false,
          }),
          api.invoke("settings:history:update", { retentionCount: 37 }),
        ])) as [{ readonly worktreeRoot: string | null }, { readonly retentionCount: number }];
        const inventory = await api.invoke("worktrees:list", "local");
        return {
          worktreeRoot: worktrees.worktreeRoot,
          retentionCount: history.retentionCount,
          inventory,
        };
      },
      { nextRoot: managedRoot },
    );

    expect(result.worktreeRoot).toBe(managedRoot);
    expect(result.retentionCount).toBe(37);
    expect(result.inventory).toEqual([]);

    const profileDocument = parseToml(fs.readFileSync(harness.profile.settingsPath, "utf8")) as {
      readonly server?: Record<string, unknown>;
    };
    expect(profileDocument.server?.worktree_root).toBe(managedRoot);
    expect(profileDocument.server?.history_retention).toBe(37);
    expect(profileDocument.server?.worktree_known_roots).toBeUndefined();

    const shellHome = await harness.application.evaluate(() => {
      const childProcess = process.getBuiltinModule("node:child_process");
      return childProcess.execFileSync("/bin/sh", ["-lc", 'printf %s "$HOME"'], {
        encoding: "utf8",
      });
    });
    expect(shellHome).toBe(externalHome);

    const externalAfter = fileEvidence(externalConfigPath);
    expect(externalAfter.bytes).toEqual(externalBefore.bytes);
    expect(externalAfter.hash).toBe(externalBefore.hash);
    expect(externalAfter.size).toBe(externalBefore.size);
    expect(externalAfter.mtimeMs).toBe(externalBefore.mtimeMs);
    expect(fs.existsSync(externalProfilePath)).toBe(false);
  } catch (error) {
    console.error(await readBoundedElectronRuntimeLogs(harness.profile));
    throw error;
  } finally {
    await harness.close();
    fs.rmSync(externalHome, { recursive: true, force: true });
  }
});
