import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  chooseComposerModel,
  openComposerModelPicker,
  openComposerOptionControl,
} from "./support/composer-model-picker";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import { AGENT_CLI_SCENARIO_ID } from "../../scripts/scenarios/scenarios/agent-cli-workflow";
import type { AgentRuntimeConversation } from "../../src/shared/agent-runtime-api";
import type {
  ProjectSession,
  WorktreeEnvironmentSaveResult,
  WorktreeEnvironmentSettingsSnapshot,
} from "../../src/shared/types";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";

const invoke = async <Result>(page: Page, channel: string, ...args: unknown[]): Promise<Result> =>
  await page.evaluate(
    async ({ channel, args }) => {
      const api = window.api as unknown as {
        invoke(channel: string, ...args: unknown[]): Promise<Result>;
      };
      return await api.invoke(channel, ...args);
    },
    { channel, args },
  );

const runGit = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

const chevronGeometry = async (trigger: Locator) =>
  await trigger
    .locator("svg")
    .last()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        cssWidth: style.width,
        cssHeight: style.height,
      };
    });

test("runs a Claude Code chat in a new worktree environment and continues it with its options after restart", async () => {
  // Two isolated cold startups have their own 60s readiness deadline, in addition to the workflow.
  test.setTimeout(180_000);
  const harness = await ElectronScenarioHarness.create({
    label: "claude-backend-lifecycle",
    environment: {
      // This locates tool resources; writable Profile and Git sources stay in the harness.
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: path.resolve("."),
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
    },
  });
  const sourceRoot = realpathSync(harness.profile.initialProjectsDirectory);
  const managedRoot = path.join(harness.profile.runRoot, "managed worktrees");
  const binaryPath = path.join(harness.profile.runRoot, "claude");
  const fixtureUrl = pathToFileURL(
    path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"),
  ).href;
  writeFileSync(binaryPath, `#!${process.execPath}\nimport(${JSON.stringify(fixtureUrl)});\n`, {
    mode: 0o755,
  });
  const rendererErrors: string[] = [];
  let linkedTarget: { sessionId: string; threadId: string } | undefined;
  const observations = () => {
    const observationPath = path.join(
      harness.profile.runRoot,
      "claude-config",
      "observations.jsonl",
    );
    if (!existsSync(observationPath)) return [];
    return readFileSync(observationPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  try {
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(path.join(sourceRoot, "README.md"), "Isolated Claude workspace\n");
    runGit(sourceRoot, ["init", "--initial-branch=main"]);
    runGit(sourceRoot, ["config", "user.name", "Nodex Claude E2E"]);
    runGit(sourceRoot, ["config", "user.email", "claude-e2e@nodex.invalid"]);
    runGit(sourceRoot, ["add", "."]);
    runGit(sourceRoot, ["commit", "-m", "Prepare isolated Claude workspace"]);
    let page = await harness.launch();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const manifest = await materializeScenario(
      AGENT_CLI_SCENARIO_ID,
      new RendererIpcSeedAdapter(page),
      sourceRoot,
    );
    await invoke(page, "worktrees:settings:update", {
      worktreeRoot: managedRoot,
      autoDeleteEnabled: false,
    });
    const environment = await invoke<WorktreeEnvironmentSettingsSnapshot>(
      page,
      "worktrees:environments:config:read",
      manifest.projectId,
    );
    const environmentSaved = await invoke<WorktreeEnvironmentSaveResult>(
      page,
      "worktrees:environments:config:save",
      {
        projectId: manifest.projectId,
        configPath: environment.configPath,
        expectedRevision: environment.revision,
        environment: {
          version: 1,
          name: "Claude lifecycle",
          setup: {
            script:
              "export NODEX_E2E_WORKTREE_ENV=prepared\nprintf 'prepared\\n' > .claude-worktree-ready",
            platformScripts: {},
          },
          cleanup: { script: null, platformScripts: {} },
          actions: [],
        },
      },
    );
    expect(environmentSaved).toEqual({ type: "success" });
    runGit(sourceRoot, ["add", ".codex"]);
    runGit(sourceRoot, ["commit", "-m", "Configure isolated worktree environment"]);
    await invoke(page, "settings:claude-agents:update", {
      instances: [
        {
          id: "claude-default",
          displayName: "Claude Code",
          binaryPath,
          configDirectory: path.join(harness.profile.runRoot, "claude-config"),
          enabled: true,
          environment: [],
        },
      ],
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Agent", exact: true }).click();
    const claudeSettings = page.getByRole("region", { name: "Claude Code", exact: true });
    await claudeSettings.getByRole("button", { name: "Add variable", exact: true }).click();
    await claudeSettings.getByLabel("Variable name 1").evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        "text/plain",
        'export ANTHROPIC_BASE_URL="https://router.example/"\nexport ANTHROPIC_AUTH_TOKEN="e2e-environment-token"\nANTHROPIC_API_KEY=""',
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    });
    await expect(claudeSettings.getByLabel("Variable value 1")).toHaveValue(
      "https://router.example/",
    );
    await expect(claudeSettings.getByLabel("Variable value 2")).toHaveAttribute("type", "password");
    await claudeSettings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(claudeSettings.getByLabel("Variable value 2")).toHaveValue("");
    await expect(claudeSettings.getByLabel("Variable value 2")).toHaveAttribute(
      "placeholder",
      "Saved secret — enter to replace",
    );
    await page.screenshot({ path: test.info().outputPath("claude-environment-settings.png") });
    const savedSettings = await invoke<import("../../src/shared/types").ClaudeAgentSettings>(
      page,
      "settings:claude-agents:get",
    );
    expect(savedSettings.instances[0]?.environment[1]).toEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      sensitive: true,
      value: null,
    });
    expect(readFileSync(harness.profile.settingsPath, "utf8")).not.toContain(
      "e2e-environment-token",
    );
    await page.getByRole("button", { name: "Back to app" }).click();
    const sessionId = createUuidV7();
    const created = await invoke<{ ok: boolean }>(page, "project-sessions:create", {
      operationId: createBoundedOperationId("e2e.claude.create"),
      payload: {
        sessionId,
        input: {
          projectId: manifest.projectId,
          noThreadFallbackTitle: "Native Claude lifecycle",
          initialPageIds: [],
        },
      },
    });
    expect(created.ok).toBe(true);
    const projectRow = page.locator(`[data-app-action-sidebar-project-id="${manifest.projectId}"]`);
    const chatRow = page.getByText("Native Claude lifecycle", { exact: true }).first();
    // The expand control shows on hover; a re-render can take it away mid-click.
    await expect(async () => {
      await projectRow.hover();
      const expandProject = projectRow.getByRole("button", {
        name: "Expand project",
        exact: true,
      });
      if (await expandProject.count()) await expandProject.click({ timeout: 1_000 });
      await expect(chatRow).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await chatRow.click();
    const composer = page
      .locator('[data-codex-composer="true"][contenteditable="true"]:visible')
      .first();
    await composer.fill("Native Claude lifecycle");
    const startIn = page.getByRole("button", { name: "Start in", exact: true });
    await expect(startIn).toHaveText("Work locally");
    const codexChevron = await chevronGeometry(startIn);
    await chooseComposerModel(page, "Claude Opus 5", "Claude Opus 5");
    await page.keyboard.press("Escape");
    await expect(startIn).toBeEnabled();
    await expect(startIn).toHaveText("Work locally");
    const claudeChevron = await chevronGeometry(startIn);
    expect(claudeChevron).toEqual(codexChevron);
    expect(claudeChevron.width).toBeGreaterThan(0);
    expect(claudeChevron.height).toBeGreaterThan(0);
    const geometryEvidence = JSON.stringify({ codex: codexChevron, claude: claudeChevron });
    writeFileSync(
      test.info().outputPath("shared-location-chevron-geometry.json"),
      geometryEvidence,
    );
    await test.info().attach("shared-location-chevron-geometry", {
      body: geometryEvidence,
      contentType: "application/json",
    });
    await expect(composer).toHaveText("Native Claude lifecycle");
    await openComposerModelPicker(page);
    const sonnet = page.getByRole("option", { name: "Claude Sonnet 5.5", exact: true });
    await expect(sonnet).toBeVisible();
    await expect(page.getByRole("option", { name: "Default", exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("claude-model-picker.png") });
    await page.keyboard.press("Escape");
    await openComposerOptionControl(page, "Effort");
    await expect(page.getByRole("menuitem", { name: "Max", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Default", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Max", exact: true }).click();
    await expect(page.getByRole("button", { name: "Effort Max", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await openComposerOptionControl(page, "Speed");
    await expect(page.getByRole("menuitem", { name: "Standard", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Fast", exact: true }).click();
    await expect(page.getByRole("button", { name: "Speed Fast", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Speed Fast", exact: true })).toHaveCount(0);
    await expect(startIn).toHaveText("Work locally");
    await expect(startIn).toBeEnabled();
    await startIn.click();
    const newWorktree = page.locator('[data-new-chat-start-in-option="newWorktree"]');
    await expect(newWorktree).toBeEnabled();
    await newWorktree.click();
    await expect(startIn).toHaveText("New worktree");
    await page.getByRole("button", { name: "Select worktree environment", exact: true }).click();
    await page.getByRole("menuitem", { name: "Claude lifecycle", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Select worktree environment", exact: true }),
    ).toContainText("Claude lifecycle");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await invoke<ProjectSession | null>(page, "project-sessions:get", sessionId))
            ?.executionRef,
      )
      .toBeTruthy();
    const launched = await invoke<ProjectSession>(page, "project-sessions:get", sessionId);
    const target = { sessionId, threadId: launched.executionRef!.threadId };
    linkedTarget = target;
    const control = () =>
      invoke<AgentRuntimeConversation>(page, "agent-runtime:session:control", target);

    // The question arrives once the new worktree is ready and its Environment has run.
    await expect(page.getByRole("radiogroup", { name: "Which target?" })).toBeVisible({
      timeout: 45_000,
    });
    const worktreePath = (await control()).snapshot.projection.thread.worktreePath;
    if (!worktreePath) throw new Error("Claude did not run in a worktree");
    expect(worktreePath.startsWith(`${realpathSync(managedRoot)}${path.sep}`)).toBe(true);
    expect(readFileSync(path.join(worktreePath, ".claude-worktree-ready"), "utf8")).toBe(
      "prepared\n",
    );
    expect(runGit(worktreePath, ["rev-parse", "--show-toplevel"])).toBe(worktreePath);
    await expect(page.getByText("That chat is not available", { exact: true })).toHaveCount(0);
    await page.getByRole("radio", { name: "Desktop", exact: true }).click();
    await expect(page.getByText("Native Claude workflow complete", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("claude-conversation.png") });
    const launchedPrompt = observations().find(({ type }) => type === "prompt");
    expect(launchedPrompt).toMatchObject({
      cwd: worktreePath,
      model: "claude-opus-5",
      effort: "max",
      permissionMode: "bypassPermissions",
      fast: true,
      thinking: true,
      content: "Native Claude lifecycle",
      environment: {
        baseUrl: "https://router.example/",
        tokenMatches: true,
        apiKeyEmpty: true,
        worktreeEnv: "prepared",
      },
    });
    const nativeLaunch = observations().find(
      ({ type, persistent }) => type === "launch" && persistent,
    );
    expect(nativeLaunch).toMatchObject({
      cwd: worktreePath,
      resumed: false,
      worktreeEnv: "prepared",
    });
    expect(
      observations().find(
        ({ type, permissionMode }) => type === "launch" && permissionMode === "bypassPermissions",
      ),
    ).toMatchObject({ allowsBypass: true });

    await openComposerOptionControl(page, "Effort");
    await page.getByRole("menuitem", { name: "Medium", exact: true }).click();
    await expect(page.getByRole("button", { name: "Effort Medium", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await openComposerOptionControl(page, "Speed");
    await page.getByRole("menuitem", { name: "Standard", exact: true }).click();
    await expect(page.getByRole("button", { name: "Speed Standard", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await composer.fill("Verify thinking enabled");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect(page.getByText("Native thinking enabled", { exact: true })).toBeVisible();
    expect(
      observations()
        .filter(({ type }) => type === "prompt")
        .at(-1),
    ).toMatchObject({
      model: "claude-opus-5",
      effort: "medium",
      thinking: true,
      fast: false,
      permissionMode: "bypassPermissions",
    });
    await openComposerModelPicker(page);
    await sonnet.click();
    await expect(page.getByRole("button", { name: "Select model", exact: true })).toContainText(
      "Claude Sonnet 5.5",
    );
    await openComposerOptionControl(page, "Effort");
    await expect(page.getByRole("menuitem", { name: "Default", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Low", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await composer.fill("Wait for cancellation");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    await expect
      .poll(() =>
        observations()
          .filter(({ type }) => type === "prompt")
          .at(-1),
      )
      .toMatchObject({
        model: "claude-sonnet-5-5",
        effort: "low",
        content: "Wait for cancellation",
      });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    // Stop settles promptly; it never waits out the query close timeout.
    await expect
      .poll(async () => (await control()).snapshot.projection.runs.at(-1)?.status, {
        timeout: 3_000,
      })
      .toBe("interrupted");
    await composer.fill("Keep this draft");
    await expect(page.getByRole("button", { name: "Send prompt", exact: true })).toBeVisible();
    await expect(composer).toHaveText("Keep this draft");
    const selection = (await control()).snapshot.projection.thread.modelSelection;
    expect(selection).toMatchObject({ model: "claude-sonnet-5-5" });

    // The chat reopens with its history and options, and continues the same Claude session.
    page = await harness.restart();
    await expect(page.getByText("Native Claude workflow complete", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect((await control()).snapshot.projection.thread.modelSelection).toEqual(selection);
    expect((await control()).snapshot.projection.thread.worktreePath).toBe(worktreePath);
    const reopened = page
      .locator('[data-codex-composer="true"][contenteditable="true"]:visible')
      .first();
    await reopened.fill("Verify thinking enabled");
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect(page.getByText("Native thinking enabled", { exact: true })).toHaveCount(2, {
      timeout: 30_000,
    });
    expect(
      observations()
        .filter(({ type, persistent }) => type === "launch" && persistent)
        .at(-1),
    ).toMatchObject({
      sessionId: nativeLaunch.sessionId,
      resumed: true,
      cwd: worktreePath,
      worktreeEnv: "prepared",
    });
  } catch (error) {
    const observationPath = path.join(
      harness.profile.runRoot,
      "claude-config",
      "observations.jsonl",
    );
    await test.info().attach("claude-peer", {
      body: existsSync(observationPath)
        ? readFileSync(observationPath, "utf8")
        : "No native user messages were received",
      contentType: "text/plain",
    });
    if (linkedTarget) {
      const sessionError = await invoke(
        harness.page,
        "agent-runtime:session:read",
        linkedTarget,
      ).catch((cause: unknown) => String(cause));
      await test.info().attach("claude-session", {
        body: JSON.stringify(sessionError),
        contentType: "text/plain",
      });
    }
    await test.info().attach("claude-runtime", {
      body: await readBoundedElectronRuntimeLogs(harness.profile),
      contentType: "text/plain",
    });
    await test.info().attach("claude-renderer", {
      body: `${rendererErrors.join("\n")}\n${await harness.page.locator("body").innerText()}`,
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await harness.close();
  }
});
