import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { constants } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import release from "../../resources/agent-runtime/codex-app-server.lock.json";
import { pathToFileURL } from "node:url";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { openWorkbenchSettings } from "./support/workbench-settings";
import { openComposerModelPicker } from "./support/composer-model-picker";
import { invokeIpc } from "./support/editor-scenario";

test("opens the Workbench and runs Claude before activating Codex", async ({}, testInfo) => {
  const harness = await ElectronScenarioHarness.create({
    label: "codex-optional",
    isolateHostDirectories: true,
    environment: {
      NODEX_TEST_CODEX_ABSENT: "1",
      NODEX_TEST_APP_COMPONENTS: undefined,
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
      OPENAI_API_KEY: undefined,
    },
  });
  const binaryPath = path.join(harness.profile.runRoot, "claude");
  const scripted = pathToFileURL(
    path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"),
  );
  let codexAfterActivation: unknown;
  try {
    await writeFile(
      binaryPath,
      `#!${process.execPath}\nimport(${JSON.stringify(scripted.href)});\n`,
      {
        mode: 0o755,
      },
    );
    const started = performance.now();
    const page = await harness.launch({ phase: "first-window" });
    await harness.waitForApplicationReady();
    await testInfo.attach("workbench-ready-ms", {
      body: String(Math.round(performance.now() - started)),
      contentType: "text/plain",
    });
    const pid = harness.application.process().pid;
    await expect(page.getByRole("navigation", { name: "App navigation" })).toBeVisible();
    await expect(invokeIpc(page, "codex:account:read")).rejects.toThrow("Codex is not installed.");

    await openWorkbenchSettings(page);
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("region", { name: "Codex", exact: true })).toContainText(
      "Codex is not installed.",
    );
    await page.getByRole("button", { name: "Back to app", exact: true }).click();

    await page.getByRole("button", { name: "Open My Project", exact: true }).click();
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toBeVisible();

    await invokeIpc(page, "settings:agent-profiles:update", {
      driver: "claudeAgent",
      instances: [
        {
          driver: "claudeAgent",
          settings: { configDirectory: harness.profile.claudeConfigHome, customModels: [] },
          id: "claude_DwwtN-gWKTuDgY0CipiA2mDkEAwUiZeUsBeQSfYr0Ks",
          displayName: "Claude Code",
          binaryPath,
          enabled: true,
          environment: [],
        },
      ],
    });
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    await openComposerModelPicker(page);
    await expect(page.getByText("Not installed", { exact: true })).toBeVisible();
    await page.getByRole("option", { name: "Claude Opus 5", exact: true }).click();
    const composer = page
      .locator('[data-codex-composer="true"][contenteditable="true"]:visible')
      .first();
    await composer.fill("Verify imported copy continuation");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect(
      page.getByText("Independent Claude copy continued", { exact: true }),
    ).toBeVisible();

    const run = path.join(harness.profile.nodexHome, "run");
    await mkdir(run, { recursive: true });
    await writeFile(path.join(run, "activate-codex"), "");
    await expect
      .poll(() => invokeIpc(page, "codex:account:read").catch(() => null))
      .toMatchObject({ account: { type: "chatgpt" } });
    await openWorkbenchSettings(page);
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("region", { name: "Codex", exact: true })).not.toContainText(
      "Codex is not installed.",
    );
    await expect
      .poll(async () => {
        codexAfterActivation = (
          await invokeIpc(page, "agent-runtime:providers:read", { refresh: true })
        ).find(({ instanceId }) => instanceId === "codex");
        return codexAfterActivation;
      })
      .toMatchObject({ installed: true });
    expect(harness.application.process().pid).toBe(pid);
  } catch (error) {
    if (codexAfterActivation)
      await testInfo.attach("codex-readiness", {
        body: Buffer.from(JSON.stringify(codexAfterActivation)),
        contentType: "application/json",
      });
    await testInfo.attach("runtime", {
      body: await readBoundedElectronRuntimeLogs(harness.profile),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await harness.close();
  }
});

test("installs the official Codex Component on first use and reuses it after restart", async ({}, testInfo) => {
  test.skip(
    process.platform !== "darwin" || process.arch !== "arm64",
    "The Codex Component targets Apple silicon.",
  );
  // oxlint-disable-next-line nodex/no-explicit-test-timeout -- The official archive download, native signature check and restart share one disposable Profile.
  test.setTimeout(780_000);
  const directory = process.env.NODEX_COMPONENTS_REVIEW_DIR ?? testInfo.outputPath();
  await mkdir(directory, { recursive: true });
  const harness = await ElectronScenarioHarness.create({
    label: "codex-first-use",
    cwd: process.cwd(),
    prepareAgentRuntime: false,
    isolateHostDirectories: true,
    environment: {
      NODEX_TEST_APP_COMPONENTS: "1",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: undefined,
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "info",
      NODEX_LOG_DIR: undefined,
      OPENAI_API_KEY: undefined,
    },
  });
  const pin = release.builds["darwin-arm64"];
  const store = path.join(harness.profile.nodexHome, "components");
  const root = path.join(store, "codex", pin.archiveSha256);
  const partial = path.join(store, "downloads", `${pin.archiveSha256}.part`);
  const readCodex = async (page: Page) =>
    (await invokeIpc(page, "app-components:read")).components.find(({ id }) => id === "codex");
  const appearance = async (page: Page) => {
    await harness.application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800),
    );
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  };
  const openComponents = async (page: Page) => {
    await openWorkbenchSettings(page);
    await page.getByRole("link", { name: "General", exact: true }).click();
    return page.getByRole("region", { name: "Components", exact: true });
  };
  const codexRow = (region: Locator) =>
    region
      .locator("[data-app-component-row]")
      .filter({ hasText: "Runs Codex with your ChatGPT account, an API key or Nodex credits." });
  const capture = async (page: Page, target: Locator, name: string) => {
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: path.join(directory, `${name}.png`), scale: "css" });
    await target.screenshot({ path: path.join(directory, `${name}-detail.png`), scale: "css" });
  };

  try {
    const page = await harness.launch({ phase: "first-window" });
    await harness.waitForApplicationReady();
    await appearance(page);
    await invokeIpc(page, "app-components:set-enabled", { id: "desktop-tools", enabled: false });
    const components = await openComponents(page);
    await expect(codexRow(components).getByRole("status")).toHaveText(
      /^Installs on first use · \d+(?:\.\d+)?\s+MB$/u,
    );
    await expect(codexRow(components).getByRole("progressbar")).toHaveCount(0);
    await expect(invokeIpc(page, "codex:account:read")).rejects.toThrow("Codex is not installed.");
    expect((await readCodex(page))?.installation.status).toBe("on-demand");
    await expect(stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
    await capture(page, components, "09-codex-first-use-row");

    await page.getByRole("button", { name: "Back to app", exact: true }).click();
    const pid = harness.application.process().pid;
    const navigation = page.getByRole("navigation", { name: "App navigation" });
    const openPlugins = () =>
      navigation.getByRole("button", { name: "Plugins", exact: true }).click();
    const openNewChat = async () => {
      await navigation.getByRole("button", { name: "Home", exact: true }).click();
      await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    };
    await openPlugins();
    const needsCodex = page.getByText("Plugins need Codex", { exact: true });
    const requirement = needsCodex.locator("xpath=../..");
    await expect(requirement.getByRole("button", { name: "Install Codex" })).toBeEnabled();
    await capture(page, requirement, "13-plugins-need-codex");
    const started = performance.now();
    await requirement.getByRole("button", { name: "Install Codex" }).click();
    // oxlint-disable-next-line nodex/no-explicit-test-timeout -- The official archive can take time to start transferring.
    await expect(requirement.getByRole("status")).toHaveText(/^Downloading [1-9]\d*% of /u, {
      timeout: 120_000,
    });
    await openNewChat();
    const installingSearch = await openComposerModelPicker(page);
    const picker = page.getByRole("listbox");
    const popup = page.locator('[data-slot="popover-content"]').filter({ has: installingSearch });
    // oxlint-disable-next-line nodex/no-explicit-test-timeout -- The GitHub release asset can take time to begin transferring.
    await expect(popup.getByText(/^Installing Codex… [1-9]\d*%$/u)).toBeVisible({
      timeout: 120_000,
    });
    await expect(
      popup.getByRole("option").filter({ hasText: /GPT-6 Luna.*Installing/u }),
    ).toBeVisible();
    const progressMs = Math.round(performance.now() - started);
    await capture(page, popup, "10-codex-installing-picker");
    await installingSearch.press("Escape");
    await openPlugins();
    await expect(needsCodex).toBeVisible();
    // oxlint-disable-next-line nodex/no-explicit-test-timeout -- Wait for the official archive and the activated provider catalog.
    await expect(page.getByRole("textbox", { name: "Search plugins" })).toBeVisible({
      timeout: 600_000,
    });
    await expect(needsCodex).toHaveCount(0);
    const installMs = Math.round(performance.now() - started);
    const installation = (await readCodex(page))?.installation;
    expect(installation?.status).toBe("installed");
    expect(harness.application.process().pid).toBe(pid);
    await expect(invokeIpc(page, "codex:account:read")).resolves.toMatchObject({
      status: "ready",
      account: null,
    });
    await openNewChat();
    const search = await openComposerModelPicker(page);
    await expect(picker.getByRole("option", { name: "GPT-6 Luna", exact: true })).toBeEnabled();
    await search.press("Escape");
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", path.join(root, "bin", "codex")]);
    await capture(page, await openComponents(page), "11-codex-installed-row");

    const beforeRestart = await stat(path.join(root, "agent-runtime.json"));
    const restartStarted = performance.now();
    const restarted = await harness.restart();
    await expect(invokeIpc(restarted, "codex:account:read")).resolves.toMatchObject({
      account: null,
    });
    const restartMs = Math.round(performance.now() - restartStarted);
    expect((await readCodex(restarted))?.installation).toEqual(installation);
    expect((await stat(path.join(root, "agent-runtime.json"))).ino).toBe(beforeRestart.ino);
    await expect(stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
    const disabled = await invokeIpc(restarted, "app-components:set-enabled", {
      id: "codex",
      enabled: false,
    });
    expect(disabled.components.find(({ id }) => id === "codex")).toMatchObject({
      enabled: false,
      removalPending: true,
    });
    const turnedOff = "Codex is turned off in Settings → General → Components.";
    await expect(invokeIpc(restarted, "codex:account:read")).rejects.toThrow(turnedOff);
    const providers = await invokeIpc(restarted, "agent-runtime:providers:read", {});
    expect(providers.find(({ instanceId }) => instanceId === "codex")).toMatchObject({
      installed: false,
      componentUnavailableReason: "turned-off",
      message: turnedOff,
    });
    expect((await stat(path.join(root, "bin", "codex"))).isFile()).toBe(true);
    await harness.restart();
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });

    const evidence = { progressMs, installMs, restartMs, installation };
    await testInfo.attach("codex-first-use-timings", {
      body: JSON.stringify(evidence),
      contentType: "application/json",
    });
    console.log("Codex first use", evidence);
  } catch (error) {
    await testInfo.attach("runtime", {
      body: await readBoundedElectronRuntimeLogs(harness.profile),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await harness.close();
  }
});

async function choosePendingCodex(page: Page, testInfo: TestInfo) {
  const search = await openComposerModelPicker(page);
  await search.fill("GPT-6 Luna");
  const picker = page.getByRole("listbox");
  try {
    const option = picker.getByRole("option", { name: /^GPT-6 Luna(?:$| )/u });
    await expect(option).toBeEnabled();
    const started = performance.now();
    await option.click();
    return started;
  } catch (error) {
    const providers = await invokeIpc(page, "agent-runtime:providers:read", {});
    const codex = providers.find(({ instanceId }) => instanceId === "codex");
    await testInfo.attach("codex-model-picker", {
      body: JSON.stringify(
        {
          picker: await picker.ariaSnapshot(),
          codex: codex && {
            installed: codex.installed,
            installationSource: codex.installationSource,
            reason: codex.componentUnavailableReason,
            models: codex.models.map(({ slug }) => slug),
          },
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    throw error;
  }
}

async function pinnedCodexFixture(testInfo: TestInfo) {
  const root = testInfo.outputPath("local-codex");
  const staged = path.resolve(".generated/codex-runtime/agent-runtime");
  for (const file of release.requiredArtifacts) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(staged, file), target, constants.COPYFILE_FICLONE);
  }
  return path.join(root, "bin", "codex");
}

const withCodexComponent = async (
  label: string,
  testInfo: TestInfo,
  run: (harness: ElectronScenarioHarness, binary: string) => Promise<void>,
) => {
  test.skip(
    process.platform !== "darwin" || process.arch !== "arm64",
    "Requires the macOS Codex Component.",
  );
  const binary = await pinnedCodexFixture(testInfo);
  const harness = await ElectronScenarioHarness.create({
    label,
    cwd: process.cwd(),
    prepareAgentRuntime: false,
    isolateHostDirectories: true,
    environment: {
      NODEX_TEST_APP_COMPONENTS: "1",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: undefined,
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "info",
      NODEX_LOG_DIR: undefined,
      OPENAI_API_KEY: undefined,
      PATH: [path.dirname(binary), process.env.PATH].join(path.delimiter),
    },
  });
  try {
    await run(harness, binary);
  } catch (error) {
    await testInfo.attach("runtime", {
      body: await readBoundedElectronRuntimeLogs(harness.profile),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await harness.close();
  }
};

const readCodexComponent = async (page: Page) =>
  (await invokeIpc(page, "app-components:read")).components.find(({ id }) => id === "codex");

const codexTimers = async (testInfo: TestInfo, timers: Record<string, number>) => {
  await testInfo.attach("codex-timings", {
    body: JSON.stringify(timers),
    contentType: "application/json",
  });
  console.log(testInfo.title, timers);
};

function expectNoCodexDownload(logs: string) {
  expect(
    logs
      .split("\n")
      .filter(
        (line) =>
          line.includes("Preparing Component archive download") &&
          /"component"\s*:\s*"codex"/u.test(line),
      ),
  ).toEqual([]);
}

test("seeds Codex on first use from a matching PATH package", async ({}, testInfo) => {
  await withCodexComponent("codex-seed", testInfo, async (harness) => {
    const page = await harness.launch({ phase: "first-window" });
    await harness.waitForApplicationReady();
    await invokeIpc(page, "app-components:set-enabled", { id: "desktop-tools", enabled: false });
    await expect
      .poll(async () => (await readCodexComponent(page))?.installation.status)
      .toBe("on-demand");

    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    const started = await choosePendingCodex(page, testInfo);
    await expect
      .poll(async () => (await readCodexComponent(page))?.installation.status)
      .toBe("installed");
    const installMs = Math.round(performance.now() - started);
    await expect(invokeIpc(page, "codex:account:read")).resolves.toMatchObject({ status: "ready" });
    const logs = await readBoundedElectronRuntimeLogs(harness.profile);
    expect(logs).toContain("Component installed from matching local files");
    expectNoCodexDownload(logs);
    await codexTimers(testInfo, { installMs });
  });
});

test("uses a configured Codex executable after restart without installing the Component", async ({}, testInfo) => {
  await withCodexComponent("codex-own-executable", testInfo, async (harness, binary) => {
    const page = await harness.launch({ phase: "first-window" });
    await harness.waitForApplicationReady();
    await openWorkbenchSettings(page);
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "Codex", exact: true, expanded: false }).click();
    const field = page.getByRole("textbox", { name: "Codex executable", exact: true });
    await expect(field).toBeEnabled();
    const started = performance.now();
    await field.fill(binary);
    await field.press("Enter");
    await expect(
      page.getByText(`Codex ${release.appServerRuntimeVersion}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Applies after restarting Nodex")).toBeVisible();
    const probeMs = Math.round(performance.now() - started);
    expect((await readCodexComponent(page))?.installation.status).toBe("on-demand");

    const restartStarted = performance.now();
    const restarted = await harness.restart();
    await expect(invokeIpc(restarted, "codex:account:read")).resolves.toMatchObject({
      status: "ready",
    });
    await expect
      .poll(
        async () =>
          (await invokeIpc(restarted, "agent-runtime:providers:read", { refresh: true })).find(
            (provider) => provider.instanceId === "codex",
          )?.installed,
      )
      .toBe(true);
    const readyMs = Math.round(performance.now() - restartStarted);
    expect((await readCodexComponent(restarted))?.installation.status).toBe("on-demand");
    const logs = await readBoundedElectronRuntimeLogs(harness.profile);
    expect(logs).toContain("Using a configured Codex executable");
    expect(logs).toMatch(/"source"\s*:\s*"external"/u);
    expectNoCodexDownload(logs);

    await harness.application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800),
    );
    await restarted.emulateMedia({ colorScheme: "light" });
    await expect(restarted.locator("html")).toHaveAttribute("data-theme", "light");
    await openWorkbenchSettings(restarted);
    await restarted.getByRole("link", { name: "General", exact: true }).click();
    const components = restarted.getByRole("region", { name: "Components", exact: true });
    await expect(
      components
        .locator("[data-app-component-row]")
        .filter({ hasText: "Runs Codex with your ChatGPT account, an API key or Nodex credits." })
        .getByRole("status"),
    ).toContainText("Installs on first use");
    await restarted.getByRole("link", { name: "Agents", exact: true }).click();
    const toggle = restarted.getByRole("button", { name: "Codex", exact: true });
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    const row = restarted.locator("#codex-executable");
    await expect(row).toBeVisible();
    await expect(row).toContainText(`Codex ${release.appServerRuntimeVersion}`);
    await expect(row).toContainText(
      "Desktop Tools stay off in Codex chats while you use your own Codex.",
    );
    await row.scrollIntoViewIfNeeded();
    const directory = process.env.NODEX_COMPONENTS_REVIEW_DIR ?? testInfo.outputPath();
    await mkdir(directory, { recursive: true });
    await restarted.screenshot({
      path: path.join(directory, "12-codex-own-executable-row.png"),
      scale: "css",
    });
    await row.screenshot({
      path: path.join(directory, "12-codex-own-executable-row-detail.png"),
      scale: "css",
    });
    await codexTimers(testInfo, { probeMs, readyMs });
  });
});
