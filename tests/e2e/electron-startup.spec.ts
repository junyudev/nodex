import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_RUNTIME_STARTUP_PROBE_ENV,
  AGENT_RUNTIME_STARTUP_EVIDENCE_FILE,
  parseAgentRuntimeStartupEvidence,
} from "../../src/shared/agent-runtime-startup-evidence";
import { ISOLATED_RUN_ID_ENV } from "../../src/main/core-client/isolated-run-ownership";
import {
  ElectronScenarioHarness,
  withElectronScenario,
} from "../../scripts/scenarios/harness/electron-e2e-harness";

function readMacApplicationType(processId: number): string | null {
  if (process.platform !== "darwin") return null;
  const appInfo = execFileSync("/usr/bin/lsappinfo", [
    "info",
    "-all",
    "-pid",
    String(processId),
  ]).toString();
  const processBlock = appInfo
    .split(/\n\s*\n/u)
    .find((block) => new RegExp(`\\bpid\\s*=\\s*${processId}\\b`, "u").test(block));
  if (!processBlock) return null;
  return (
    processBlock.match(/\btype="([^"]+)"/u)?.[1] ??
    processBlock.match(/"ApplicationType"="([^"]+)"/u)?.[1] ??
    null
  );
}

async function expectCanonicalStartup(harness: ElectronScenarioHarness): Promise<void> {
  try {
    const page = await harness.launch({ phase: "first-window" });
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await page.locator(".nodex-startup-logo-base").waitFor({ state: "visible" });
    const firstIdentity = await harness.application.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
      const window = windows[0];
      if (!window) throw new Error("Canonical startup window is unavailable");
      return {
        browserWindowId: window.id,
        webContentsId: window.webContents.id,
        windowCount: windows.length,
      };
    });
    const firstFrame = await page.evaluate(() => {
      const logo = document.querySelector<SVGElement>(".nodex-startup-logo-base");
      if (!logo) throw new Error("Parser-time Nodex logo is unavailable");
      return {
        color: getComputedStyle(logo).color,
        phase: document.querySelector<HTMLElement>(".nodex-startup-shell")?.dataset.startupPhase,
      };
    });

    expect(firstIdentity.windowCount).toBe(1);
    expect(firstFrame.phase).toBeTruthy();
    expect(firstFrame.phase).not.toBe("failed");
    expect(firstFrame.color).not.toBe("rgba(0, 0, 0, 0)");
    await harness.waitForApplicationReady();
    await expect(page.locator(".nodex-startup-shell")).toHaveCount(0, { timeout: 30_000 });
    const readyIdentity = await harness.application.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
      const window = windows[0];
      if (!window) throw new Error("Ready application window is unavailable");
      return {
        browserWindowId: window.id,
        webContentsId: window.webContents.id,
        windowCount: windows.length,
      };
    });

    expect(readyIdentity).toEqual({
      browserWindowId: firstIdentity.browserWindowId,
      webContentsId: firstIdentity.webContentsId,
      windowCount: 1,
    });
    expect(rendererErrors).toEqual([]);
    const processId = harness.application.process().pid;
    if (processId !== undefined && process.platform === "darwin") {
      expect(readMacApplicationType(processId)).toBe("Foreground");
    }
  } finally {
    await harness.waitForApplicationReady().catch(() => undefined);
    await harness.close();
  }
}

test("keeps one canonical window from branded frame through Workbench", async () => {
  // The app's Dock presence is under test, so its window is a real foreground window.
  const harness = await ElectronScenarioHarness.create({
    label: "canonical-startup-window",
    windows: "foreground",
  });
  await expectCanonicalStartup(harness);
});

test("keeps the packaged window identity through startup", async () => {
  const executablePath = process.env.NODEX_E2E_PACKAGED_EXECUTABLE;
  test.skip(!executablePath, "NODEX_E2E_PACKAGED_EXECUTABLE is not configured");
  const harness = await ElectronScenarioHarness.create({
    executablePath,
    label: "packaged-canonical-startup-window",
    prepareAgentRuntime: false,
    windows: "foreground",
  });
  await expectCanonicalStartup(harness);
});

test("publishes execution readiness for its isolated host after scrubbing the run token", async () => {
  await withElectronScenario(
    {
      scenarioId: null,
      label: "execution-startup-evidence",
      prepareAgentRuntime: false,
      environment: {
        [AGENT_RUNTIME_STARTUP_PROBE_ENV]: "1",
        NODEX_LOG_CONSOLE: "true",
        NODEX_LOG_FILE: "true",
      },
      onFailure: async ({ readRuntimeLogs }) => {
        console.error(await readRuntimeLogs());
      },
    },
    async ({ harness }) => {
      const file = join(harness.profile.nodexHome, "run", AGENT_RUNTIME_STARTUP_EVIDENCE_FILE);
      await expect.poll(() => existsSync(file), { timeout: 30_000 }).toBe(true);
      const hostPid = harness.application.process().pid!;
      expect(
        parseAgentRuntimeStartupEvidence(JSON.parse(readFileSync(file, "utf8")), {
          runId: harness.profile.runId,
          hostPid,
        }),
      ).toMatchObject({ hostPid, runId: harness.profile.runId });
      expect(
        await harness.application.evaluate((_, key) => process.env[key], ISOLATED_RUN_ID_ENV),
      ).toBeUndefined();
    },
  );
});
