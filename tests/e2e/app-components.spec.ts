import { expect, test, type Locator, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import browserRuntimeLock from "../../resources/browser-runtime/browser-runtime.lock.json";
import type { IpcApi } from "../../src/shared/ipc-api";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import { setAgentExecutionProfile, waitForFinalMarker } from "./support/agent-smoke-harness";
import { composerModelLabel, openComposerModelPicker } from "./support/composer-model-picker";
import { invokeIpc } from "./support/editor-scenario";
import { nativeAppToolCall } from "./support/native-app-tools";
import { closeWorkbenchSettings, openWorkbenchSettings } from "./support/workbench-settings";

const archive = browserRuntimeLock.assets["darwin-arm64"];
const inProgress = /^(Downloading|Waiting to download|Installing)/u;
const installedSize = /^\d+(?:\.\d+)?\s+MB$/u;
const downloadTimeout = 600_000;

async function openSettingsPage(page: Page, name: string) {
  await openWorkbenchSettings(page);
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
}

async function launchReviewWindow(harness: ElectronScenarioHarness, restart = false) {
  const page = await (restart ? harness.restart() : harness.launch());
  await harness.application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800),
  );
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  return page;
}

async function capture(page: Page, section: Locator, directory: string, name: string) {
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: path.join(directory, `${name}.png`), scale: "css" });
  await section.screenshot({ path: path.join(directory, `${name}-detail.png`), scale: "css" });
}

const componentsSection = (page: Page) =>
  page.getByRole("region", { name: "Add-ons", exact: true });
const componentSwitch = (page: Page, name: string, enabled: boolean) =>
  componentsSection(page).getByRole("switch", {
    name: `${enabled ? "Remove" : "Install"} ${name}`,
    exact: true,
  });
const componentRow = (page: Page, name: string) =>
  componentsSection(page)
    .locator("[data-app-component-row]")
    .filter({
      has: page.getByRole("switch", { name: new RegExp(`^(Remove|Install) ${name}$`, "u") }),
    });
const firstUse = /^Installs on first use · \d+(?:\.\d+)?\s+MB$/u;

async function expectOnDemand(page: Page, name: string) {
  const row = componentRow(page, name);
  await expect(componentSwitch(page, name, true)).toBeChecked();
  await expect(row.getByRole("status")).toHaveText(firstUse);
  await expect(row.getByRole("progressbar")).toHaveCount(0);
}

const readSettings = <
  Channel extends
    | "app-components:read"
    | "computer-use-settings-get"
    | "chrome-control-settings-get",
>(
  page: Page,
  channel: Channel,
) =>
  page.evaluate((target) => window.api!.invoke(target), channel) as Promise<
    IpcApi[Channel]["result"]
  >;

interface InstallEvidence {
  readonly ts: string;
  readonly downloadMs?: number;
  readonly annotations?: { readonly rootPath: string; readonly verificationMs: number };
}

function installEvidence(log: string, message: string): InstallEvidence | undefined {
  const line = log
    .split("\n")
    .find((candidate) => candidate.startsWith("{") && candidate.includes(JSON.stringify(message)));
  return line ? (JSON.parse(line) as InstallEvidence) : undefined;
}

test("downloads, activates, and removes the published Desktop Tools component", async ({}, testInfo) => {
  test.skip(
    process.platform !== "darwin" || process.arch !== "arm64",
    "The published Desktop Tools component targets Apple Silicon.",
  );
  // oxlint-disable-next-line nodex/no-explicit-test-timeout -- The public archive download, native signature verification and restart share one disposable Profile.
  test.setTimeout(960_000);
  const directory = process.env.NODEX_COMPONENTS_REVIEW_DIR ?? testInfo.outputPath();
  await mkdir(directory, { recursive: true });
  const harness = await ElectronScenarioHarness.create({
    label: "app-components",
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
  const store = path.join(harness.profile.nodexHome, "components");
  const componentDirectory = path.join(store, "desktop-tools");
  const root = path.join(componentDirectory, archive.archiveSha256);
  const browserRoot = path.join(root, "browser-runtime");
  const tombstone = path.join(componentDirectory, ".remove");
  const partial = path.join(store, "downloads", `${archive.archiveSha256}.part`);

  try {
    let page = await launchReviewWindow(harness);
    await openSettingsPage(page, "General");
    const components = componentsSection(page);
    const desktop = componentRow(page, "Desktop Tools");
    const status = desktop.getByRole("status");
    const remove = componentSwitch(page, "Desktop Tools", true);
    const install = componentSwitch(page, "Desktop Tools", false);
    const progress = desktop.getByRole("progressbar", { name: "Installing Desktop Tools" });
    await expect(components.getByText("Desktop Tools", { exact: true })).toBeVisible();
    await expect(remove).toBeChecked();
    await expect(status).toHaveText(inProgress);
    await expectOnDemand(page, "Claude Code");
    await expectOnDemand(page, "Document Tools");
    // oxlint-disable-next-line nodex/no-explicit-test-timeout -- A first connection to the public release CDN can be slow.
    await expect(progress).toHaveAttribute("aria-valuenow", /^[1-9]\d*$/u, {
      timeout: downloadTimeout,
    });
    await capture(page, components, directory, "01-downloading");

    await openSettingsPage(page, "Computer use");
    const computerUse = page.getByRole("region", { name: "Control", exact: true });
    await expect(computerUse.getByText("Any app", { exact: true })).toBeVisible();
    await expect(
      computerUse.getByText("Needs the Desktop Tools component.", { exact: true }),
    ).toBeVisible();
    await expect(computerUse.getByRole("status")).toHaveText(inProgress);
    await capture(page, computerUse, directory, "02-computer-use-requirement");

    await openSettingsPage(page, "General");
    await components.scrollIntoViewIfNeeded();
    await components.screenshot({
      path: path.join(directory, "02-components-detail.png"),
      scale: "css",
    });
    // oxlint-disable-next-line nodex/no-explicit-test-timeout -- A cold 271 MiB transfer and native signature verification share this deadline.
    await expect(status).toHaveText(installedSize, { timeout: 780_000 });
    expect(existsSync(path.join(browserRoot, "browser-runtime-manifest.json"))).toBe(true);
    await expectOnDemand(page, "Claude Code");
    await expectOnDemand(page, "Document Tools");
    await capture(page, components, directory, "03-installed");

    await openSettingsPage(page, "Computer use");
    await expect(computerUse.getByText("Any app", { exact: true })).toBeVisible();
    await expect(computerUse.getByRole("status")).toHaveCount(0);
    await expect(computerUse).not.toContainText(
      /needs the desktop tools component|not installed/iu,
    );
    await expect(computerUse.getByText(/^(Available|Unavailable)$/u)).toBeVisible();
    const computerUseReadiness = await readSettings(page, "computer-use-settings-get");
    await openSettingsPage(page, "Browser");
    const extensions = page.getByRole("region", { name: "Extensions", exact: true });
    await expect(extensions.getByText("Control existing browsers", { exact: true })).toBeVisible();
    await expect(extensions.getByText("Checking…", { exact: true })).toHaveCount(0);
    await expect(extensions.getByRole("status")).toHaveCount(0);
    await expect(extensions).not.toContainText(/needs the desktop tools component|not installed/iu);
    const chromeReadiness = await readSettings(page, "chrome-control-settings-get");
    expect(computerUseReadiness.browserRuntimeUnavailableReason).toBeUndefined();
    expect(chromeReadiness.browserRuntimeUnavailableReason).toBeUndefined();

    // This is Main's admission of the verified closure used by Agent tools.
    const readLogs = () => readBoundedElectronRuntimeLogs(harness.profile, 256_000);
    const activated = async () =>
      installEvidence(await readLogs(), "Desktop Tools runtime activated");
    await expect.poll(activated).toMatchObject({ annotations: { rootPath: browserRoot } });
    const activation = (await activated())!;
    const download = installEvidence(await readLogs(), "Component archive verified")!;
    expect(download).toMatchObject({ downloadMs: expect.any(Number) });
    expect(activation.annotations).toMatchObject({ verificationMs: expect.any(Number) });
    const timings = {
      downloadMs: download.downloadMs,
      unpackAndVerifyMs: Date.parse(activation.ts) - Date.parse(download.ts),
      activationVerificationMs: activation.annotations!.verificationMs,
    };
    const evidencePath = testInfo.outputPath("desktop-tools-evidence.json");
    await writeFile(
      evidencePath,
      JSON.stringify(
        { timings, computerUse: computerUseReadiness, chrome: chromeReadiness },
        null,
        2,
      ),
    );
    await testInfo.attach("desktop-tools-evidence", {
      path: evidencePath,
      contentType: "application/json",
    });

    await openSettingsPage(page, "General");
    const installedInode = (await stat(root)).ino;
    await remove.click();
    await expect(status).toHaveText("Removed when Nodex restarts");
    expect(existsSync(tombstone)).toBe(true);
    await capture(page, components, directory, "04-removal-pending");
    await install.click();
    await expect(status).toHaveText(installedSize);
    expect(existsSync(tombstone)).toBe(false);
    expect((await stat(root)).ino).toBe(installedInode);
    expect(existsSync(partial)).toBe(false);

    await remove.click();
    await expect(status).toHaveText("Removed when Nodex restarts");
    page = await launchReviewWindow(harness, true);
    await openSettingsPage(page, "General");
    const restarted = componentRow(page, "Desktop Tools");
    await expect(
      restarted.getByRole("switch", { name: "Install Desktop Tools" }),
    ).not.toBeChecked();
    await expect(restarted.getByRole("status")).toHaveText(/\bMB download$/u);
    await expect(restarted.getByRole("progressbar")).toHaveCount(0);
    await expectOnDemand(page, "Claude Code");
    await expectOnDemand(page, "Document Tools");
    expect((await readSettings(page, "app-components:read")).components).toMatchObject([
      { id: "desktop-tools", enabled: false, installation: { status: "not-installed" } },
      { id: "codex", enabled: true, installation: { status: "on-demand" } },
      { id: "claude-code", enabled: true, installation: { status: "on-demand" } },
      { id: "document-tools", enabled: true, installation: { status: "on-demand" } },
    ]);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(partial)).toBe(false);
    await capture(page, componentsSection(page), directory, "05-off-after-restart");
  } catch (error) {
    await testInfo.attach("runtime-logs", {
      body: await readBoundedElectronRuntimeLogs(harness.profile, 256_000),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await harness.close();
  }
});

test("turning off Desktop Tools removes the active download from the Profile", async () => {
  test.skip(
    process.platform !== "darwin" || process.arch !== "arm64",
    "The published Desktop Tools component targets Apple Silicon.",
  );
  const harness = await ElectronScenarioHarness.create({
    label: "cancel-desktop-tools-component",
    cwd: process.cwd(),
    prepareAgentRuntime: false,
    isolateHostDirectories: true,
    environment: { NODEX_TEST_APP_COMPONENTS: "1", OPENAI_API_KEY: undefined },
  });
  const store = path.join(harness.profile.nodexHome, "components");
  const partial = path.join(store, "downloads", `${archive.archiveSha256}.part`);
  try {
    await writeFile(
      path.join(harness.profile.nodexHome, "config.toml"),
      '[components]\ndisabled = ["desktop-tools"]\n',
    );
    const page = await harness.launch();
    await openSettingsPage(page, "General");
    const install = componentSwitch(page, "Desktop Tools", false);
    await install.click();
    await expect.poll(() => existsSync(partial)).toBe(true);
    await componentSwitch(page, "Desktop Tools", true).click();
    await expect(install).not.toBeChecked();
    const status = componentRow(page, "Desktop Tools").getByRole("status");
    await expect(status).toHaveText(/\bMB download$/u);
    await expect.poll(() => existsSync(partial)).toBe(false);
    expect(existsSync(path.join(store, "desktop-tools", archive.archiveSha256))).toBe(false);
  } finally {
    await harness.close();
  }
});

test("Claude Code gates API-key models until installed and links to Components when off", async ({}, testInfo) => {
  test.skip(
    process.platform !== "darwin" || process.arch !== "arm64",
    "Published components target Apple Silicon.",
  );
  // oxlint-disable-next-line nodex/no-explicit-test-timeout -- Verify three public archives and native activation in one disposable Profile.
  test.setTimeout(1_200_000);
  const directory = process.env.NODEX_COMPONENTS_REVIEW_DIR ?? testInfo.outputPath();
  await mkdir(directory, { recursive: true });
  const modelId = "claude-fixture-sonnet";
  const providerName = "Fixture Claude API";
  const modelServer = createServer((request, response) => {
    if (request.url !== "/v1/models" || request.headers["x-api-key"] !== "local-fixture-key") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ data: [{ id: modelId, display_name: "Fixture Sonnet" }] }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  try {
    await withScriptedModelServer(
      {
        exchanges: [
          {
            name: "load Document Tools",
            match: (request) => request.hasUserInputText("INSTALL_DOCUMENT_TOOLS"),
            expectedCalls: 2,
            maximumCalls: 2,
            respond: (request, index) => {
              const callId = "install_document_tools";
              if (index === 0) {
                const tool = request.toolInvocation("functions", "exec");
                if (!tool) throw new Error("Missing functions.exec");
                return responses.stream([
                  responses.created(callId),
                  nativeAppToolCall(
                    callId,
                    tool.name,
                    '// @exec: {"yield_time_ms": 120000}\ntext(await app.load_workspace_dependencies({}));',
                    tool.namespace,
                  ),
                  responses.completed(callId),
                ]);
              }
              expect(JSON.stringify(request.toolCallOutput(callId))).toContain("available");
              return responses.stream([
                responses.created("document_tools_ready"),
                responses.assistantMessage(
                  "document_tools_answer",
                  "DOCUMENT_TOOLS_READY",
                  "final_answer",
                ),
                responses.completed("document_tools_ready", true),
              ]);
            },
          },
        ],
      },
      async (model) => {
        const harness = await ElectronScenarioHarness.create({
          label: "claude-code-component",
          cwd: process.cwd(),
          prepareAgentRuntime: false,
          isolateHostDirectories: true,
          environment: {
            ...model.loopbackEnvironment(),
            NODEX_TEST_APP_COMPONENTS: "1",
            NODEX_LOG_FILE: "1",
            NODEX_LOG_FILE_LEVEL: "info",
            NODEX_LOG_DIR: undefined,
            OPENAI_API_KEY: "nodex-scripted-model-test-key",
          },
        });
        try {
          await writeFile(
            path.join(harness.profile.codexHome, "config.toml"),
            `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${model.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\n`,
          );
          const page = await launchReviewWindow(harness);
          // Only this disposable process knows the dummy key; skip the desktop keychain prompt.
          await harness.application.evaluate(({ safeStorage }) => {
            const values: string[] = [];
            safeStorage.isEncryptionAvailable = () => true;
            safeStorage.encryptString = (value) => {
              values.push(value);
              return Buffer.from(String(values.length - 1));
            };
            safeStorage.decryptString = (reference) => {
              const value = values[Number(reference.toString())];
              if (value === undefined) throw new Error("Unknown fixture secret");
              return value;
            };
          });
          await openSettingsPage(page, "General");
          await expectOnDemand(page, "Claude Code");
          await expectOnDemand(page, "Document Tools");
          await closeWorkbenchSettings(page);
          const newChat = page.getByRole("button", { name: "New chat", exact: true }).first();
          await newChat.click();
          const installing = page.getByRole("button", { name: /^Installing Claude Code…/u });
          const claudeOption = page.getByRole("option", { name: /Fixture Sonnet/u });
          const startedAt = performance.now();
          const address = modelServer.address();
          if (!address || typeof address === "string")
            throw new Error("Missing fake provider port");
          const result = await invokeIpc(page, "provider-keys:connect", {
            target: {
              preset: "custom",
              agent: "claudeAgent",
              baseUrl: `http://127.0.0.1:${address.port}`,
            },
            apiKey: "local-fixture-key",
            displayName: providerName,
          });
          expect(result, "The fixture API key connection should save").toMatchObject({ ok: true });
          const search = await openComposerModelPicker(page);
          // The search has to match both the Component action and the model.
          await search.fill("Claude");
          await expect(installing).toBeVisible();
          await expect(claudeOption).toBeDisabled();
          const picker = page.locator("[data-starting-style], [data-ending-style]").filter({
            has: page.getByRole("combobox", { name: "Search models" }),
          });
          const pickerContent = page
            .locator('[data-slot="popover-content"]')
            .filter({ has: search });
          await expect(picker).toHaveCount(0);
          await capture(page, pickerContent, directory, "06-claude-installing-picker");
          // oxlint-disable-next-line nodex/no-explicit-test-timeout -- Claude Code downloads from npm and verifies the executable.
          await expect(claudeOption).toBeEnabled({ timeout: downloadTimeout });
          await expect(installing).toHaveCount(0);
          const timingPath = testInfo.outputPath("claude-code-timing.json");
          await writeFile(
            timingPath,
            JSON.stringify({ connectToReadyMs: Math.round(performance.now() - startedAt) }),
          );
          await testInfo.attach("claude-code-timing", {
            path: timingPath,
            contentType: "application/json",
          });
          await claudeOption.click();
          await expect(composerModelLabel(page)).toHaveText("Fixture Sonnet");

          await openSettingsPage(page, "General");
          const claude = componentRow(page, "Claude Code");
          await expect(claude.getByRole("status")).toHaveText(installedSize);
          await componentSwitch(page, "Claude Code", true).click();
          await expect(componentSwitch(page, "Claude Code", false)).not.toBeChecked();
          await closeWorkbenchSettings(page);
          const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
          await composer.fill("Draft while Claude Code is off");
          await expect(
            page.getByRole("button", { name: "Send prompt", exact: true }),
          ).toBeDisabled();
          await composer.fill("");
          await (await openComposerModelPicker(page)).fill("Claude");
          const turnedOff = page.getByRole("button", {
            name: /Claude Code is turned off.*Settings/u,
          });
          await expect(turnedOff).toBeVisible();
          await expect(claudeOption).toBeDisabled();
          await capture(page, pickerContent, directory, "07-claude-turned-off-picker");
          await turnedOff.click();
          await expect(
            page.getByRole("heading", { name: "General", exact: true, level: 1 }),
          ).toBeVisible();
          await expect(componentsSection(page)).toBeInViewport();
          await componentSwitch(page, "Claude Code", false).click();
          // oxlint-disable-next-line nodex/no-explicit-test-timeout -- Re-enabling can start a fresh verified download.
          await expect(claude.getByRole("status")).toHaveText(installedSize, {
            timeout: downloadTimeout,
          });
          await closeWorkbenchSettings(page);
          await newChat.click();
          await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.6-sol" });
          await composer.fill("INSTALL_DOCUMENT_TOOLS");
          await page.getByRole("button", { name: "Send prompt", exact: true }).click();
          await waitForFinalMarker(page, "DOCUMENT_TOOLS_READY");
          await openSettingsPage(page, "General");
          for (const name of ["Desktop Tools", "Claude Code", "Document Tools"]) {
            await expect(componentRow(page, name).getByRole("status")).toHaveText(installedSize);
          }
          await capture(page, componentsSection(page), directory, "08-all-installed");
        } catch (error) {
          await testInfo.attach("runtime-logs", {
            body: await readBoundedElectronRuntimeLogs(harness.profile, 256_000),
            contentType: "text/plain",
          });
          throw error;
        } finally {
          await harness.close();
        }
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
