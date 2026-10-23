import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import {
  AGENT_CLI_PROJECT_NAME,
  AGENT_CLI_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/agent-cli-workflow";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import type { IpcApi } from "../../src/shared/ipc-api";
import { chooseComposerModel, openComposerModelPicker } from "./support/composer-model-picker";

const invoke = <Channel extends keyof IpcApi>(
  page: Page,
  channel: Channel,
  ...args: IpcApi[Channel]["args"]
): Promise<IpcApi[Channel]["result"]> =>
  page.evaluate(
    async ({ channel, args }) => {
      const bridge = window.api as unknown as {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      };
      return await bridge.invoke(channel, ...args);
    },
    { channel, args: args as unknown as unknown[] },
  ) as Promise<IpcApi[Channel]["result"]>;

interface NativeObservation {
  readonly type?: string;
  readonly kind?: string;
  readonly sessionId: string;
  readonly content?: string;
  readonly text?: string;
  readonly priorPromptTexts?: readonly string[];
}

const readObservations = (file: string): readonly NativeObservation[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as NativeObservation)
    : [];

const visibleSession = async (page: Page) =>
  (
    await page
      .locator('[data-workbench-scene-owner^="session:"]:visible')
      .first()
      .getAttribute("data-workbench-scene-owner")
  )?.slice("session:".length) ?? null;

async function waitForForkSession(page: Page, previous: string): Promise<string> {
  let selected: string | null = null;
  await expect
    .poll(
      async () => {
        selected = await visibleSession(page);
        return selected !== null && selected !== previous;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  if (!selected) throw new Error("The fork did not open its Session");
  return selected;
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const bytes = await page.screenshot({ path: testInfo.outputPath(name), animations: "disabled" });
  await testInfo.attach(name, { body: bytes, contentType: "image/png" });
  if (process.env.NODEX_E2E_EVIDENCE_DIR) {
    mkdirSync(process.env.NODEX_E2E_EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(process.env.NODEX_E2E_EVIDENCE_DIR, name), bytes);
  }
}

for (const kind of ["claude", "opencode"] as const) {
  test(`${kind} forks from chat menus and /fork, preserving native history without Git`, async ({}, testInfo) => {
    test.setTimeout(180_000);
    const harness = await ElectronScenarioHarness.create({
      label: `${kind}-fork-actions`,
      retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
      environment: {
        NODEX_LOG_FILE: "1",
        NODEX_LOG_FILE_LEVEL: "debug",
      },
    });
    const nativeHome = path.join(harness.profile.runRoot, `${kind}-native`);
    const workspace = path.join(harness.profile.runRoot, "fork-workspace");
    mkdirSync(workspace);
    const observationsPath =
      kind === "claude"
        ? path.join(nativeHome, "observations.jsonl")
        : path.join(nativeHome, "data", "opencode", "observations.jsonl");
    const binaryPath = path.join(harness.profile.runRoot, kind);
    const peer = pathToFileURL(
      path.resolve(`scripts/scenarios/runtime/scripted-${kind}-agent.mjs`),
    ).href;
    writeFileSync(binaryPath, `#!${process.execPath}\nimport(${JSON.stringify(peer)});\n`, {
      mode: 0o755,
    });
    const rendererErrors: string[] = [];
    try {
      // The fixture workspace deliberately has no Git repository or checkpoint.
      expect(existsSync(path.join(workspace, ".git"))).toBe(false);
      const page = await harness.launch();
      expect(page.url()).toMatch(/^app:\/\//u);
      page.on("pageerror", (error) => rendererErrors.push(error.message));
      await harness.waitForApplicationReady();
      await materializeScenario(AGENT_CLI_SCENARIO_ID, new RendererIpcSeedAdapter(page), workspace);
      const instanceConfigId = `${kind}-default`;
      if (kind === "claude") {
        await invoke(page, "settings:claude-agents:update", {
          instances: [
            {
              id: instanceConfigId,
              displayName: "Claude Code",
              binaryPath,
              configDirectory: nativeHome,
              enabled: true,
              customModels: [],
              environment: [],
            },
          ],
        });
      } else {
        await invoke(page, "settings:opencode-agents:update", {
          instances: [
            {
              id: instanceConfigId,
              displayName: "OpenCode",
              binaryPath,
              profileDirectory: nativeHome,
              serverUrl: null,
              enabled: true,
              environment: [],
            },
          ],
        });
      }
      await page
        .getByRole("button", { name: `Start new chat in ${AGENT_CLI_PROJECT_NAME}`, exact: true })
        .click();
      if (kind === "claude") {
        await chooseComposerModel(page, "Claude Opus 5", "Claude Opus 5");
      } else {
        // The initial catalog update may replace the open picker while Agent instances load.
        await expect(async () => {
          const search = await openComposerModelPicker(page);
          const showAll = page.getByRole("button", { name: "Show all models", exact: true });
          if (await showAll.isVisible()) await showAll.click({ timeout: 1_000 });
          await search.fill("Kimi K3", { timeout: 1_000 });
          await page.getByRole("option", { name: /Kimi K3.*OpenCode/u }).click({ timeout: 1_000 });
          await expect(search).toBeHidden({ timeout: 1_000 });
        }).toPass({ timeout: 30_000 });
      }
      const composer = () => page.locator('[data-codex-composer="true"]:visible').first();
      const prompts = () =>
        readObservations(observationsPath).filter(
          (entry) => entry.type === "prompt" || entry.kind === "prompt",
        );
      const send = async (phase: string) => {
        const sessionId = await visibleSession(page);
        if (!sessionId) throw new Error("The active chat has no Session");
        const prompt = `Verify handoff ${phase}`;
        const count = prompts().length;
        await composer().fill(prompt);
        await composer().press("Enter");
        await expect.poll(() => prompts().length, { timeout: 30_000 }).toBe(count + 1);
        await expect
          .poll(
            async () => {
              const conversation = await invoke(page, "agent-runtime:session:read", { sessionId });
              const run = conversation?.snapshot.projection.runs.at(-1);
              return run?.status;
            },
            { timeout: 30_000 },
          )
          .toBe("completed");
        await expect(
          page
            .locator('[data-user-message-bubble="true"]', { hasText: prompt })
            .filter({ visible: true }),
        ).toHaveCount(1);
        return prompt;
      };
      const sourcePrompt = await send("origin ORCHID");
      const sourceId = await visibleSession(page);
      if (!sourceId) throw new Error("Source Session missing");
      const source = await invoke(page, "project-sessions:get", sourceId);
      expect(source?.executionRef).toBeTruthy();
      expect(
        (await invoke(page, "agent-runtime:session:inspect", { sessionId: sourceId })).thread
          .modelSelection.instanceId,
      ).toBe(agentRuntimeProviderId({ kind, instanceConfigId }));

      await page.getByRole("button", { name: "Chat actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Fork", exact: true }).hover();
      const fork = page.getByRole("menuitem", { name: "Fork chat", exact: true });
      await expect(fork).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "Fork chat in new worktree", exact: true }),
      ).toHaveCount(0);
      await screenshot(page, testInfo, `${kind}-header-fork.png`);
      await fork.click();
      const firstForkId = await waitForForkSession(page, sourceId);
      const firstFork = await invoke(page, "project-sessions:get", firstForkId);
      expect(firstFork?.projectId).toBe(source?.projectId);
      expect(firstFork?.executionRef?.threadId).toBeTruthy();
      expect(firstFork?.executionRef?.threadId).not.toBe(source?.executionRef?.threadId);
      await expect(
        page
          .locator('[data-user-message-bubble="true"]', { hasText: sourcePrompt })
          .filter({ visible: true }),
      ).toHaveCount(1);
      const headerPrompt = await send("header fork");
      expect(prompts().at(-1)?.priorPromptTexts).toContain(sourcePrompt);
      expect(prompts().at(-1)?.sessionId).not.toBe(prompts()[0]?.sessionId);

      await composer().fill("/");
      for (const command of ["fork", "side", "compact", "merge", "status"]) {
        await expect(page.locator(`[data-slash-command-row="${command}"]`)).toHaveCount(1);
      }
      await screenshot(page, testInfo, `${kind}-slash-actions.png`);
      await composer().fill("/fork");
      const slash = page.locator('[data-slash-command-row="fork"]');
      await expect(slash).toBeVisible();
      await screenshot(page, testInfo, `${kind}-slash-fork.png`);
      await slash.click();
      await page
        .getByRole("button", {
          name: "Fork chat Continue this conversation in a new chat",
          exact: true,
        })
        .click();
      const secondForkId = await waitForForkSession(page, firstForkId);
      expect(secondForkId).not.toBe(sourceId);
      await send("slash fork");
      expect(prompts().at(-1)?.priorPromptTexts).toEqual(
        expect.arrayContaining([sourcePrompt, headerPrompt]),
      );
      expect(new Set(prompts().map((entry) => entry.sessionId)).size).toBe(3);
      const sourceConversation = await invoke(page, "agent-runtime:session:read", {
        sessionId: sourceId,
      });
      expect(sourceConversation?.snapshot.projection.runs).toHaveLength(1);
      await screenshot(page, testInfo, `${kind}-fork-continued.png`);

      // Chromium cannot click an OS-native menu. Right-click the real inactive sidebar row,
      // then select the real Electron MenuItem through its installed native click callback.
      const sourceRow = page.locator(`[data-app-action-sidebar-thread-id="${sourceId}"]`);
      await expect(sourceRow).toBeVisible();
      await expect(sourceRow).toHaveAttribute("data-app-action-sidebar-thread-active", "false");
      const selectedMenu = harness.application.evaluate(
        ({ Menu }) =>
          new Promise<{ label: string; children: string[]; enabled: boolean }>(
            (resolve, reject) => {
              const original = Menu.prototype.popup;
              const timeout = setTimeout(() => {
                Menu.prototype.popup = original;
                reject(new Error("The sidebar did not open its native context menu"));
              }, 15_000);
              Menu.prototype.popup = function (options) {
                Menu.prototype.popup = original;
                clearTimeout(timeout);
                try {
                  const parent = this.getMenuItemById("session.forkMenu");
                  const child = this.getMenuItemById("session.fork");
                  if (!parent || !child) throw new Error("Native sidebar Fork action missing");
                  const evidence = {
                    label: parent.label,
                    children: parent.submenu?.items.map((item) => item.label) ?? [],
                    enabled: child.enabled,
                  };
                  Reflect.apply(child.click, child, [child, options?.window, {}]);
                  options?.callback?.();
                  resolve(evidence);
                } catch (error) {
                  options?.callback?.();
                  reject(error);
                }
              };
            },
          ),
      );
      const [nativeMenu] = await Promise.all([
        selectedMenu,
        sourceRow.click({ button: "right", timeout: 10_000 }),
      ]);
      expect(nativeMenu).toEqual({ label: "Fork", children: ["Fork chat"], enabled: true });
      await testInfo.attach(`${kind}-sidebar-menu.json`, {
        body: Buffer.from(JSON.stringify(nativeMenu, null, 2)),
        contentType: "application/json",
      });
      if (process.env.NODEX_E2E_EVIDENCE_DIR) {
        writeFileSync(
          path.join(process.env.NODEX_E2E_EVIDENCE_DIR, `${kind}-sidebar-menu.json`),
          JSON.stringify(nativeMenu, null, 2),
        );
      }
      const sidebarForkId = await waitForForkSession(page, secondForkId);
      expect(sidebarForkId).not.toBe(sourceId);
      await send("sidebar fork");
      expect(prompts().at(-1)?.priorPromptTexts).toContain(sourcePrompt);
      expect(prompts().at(-1)?.priorPromptTexts).not.toContain(headerPrompt);
      expect(new Set(prompts().map((entry) => entry.sessionId)).size).toBe(4);
      expect(rendererErrors).toEqual([]);
      const evidence = JSON.stringify(
        {
          provider: kind,
          rendererUrl: page.url(),
          worktree: process.cwd(),
          disposableProfile: harness.profile.nodexHome,
          workspace,
          workspaceHasGit: existsSync(path.join(workspace, ".git")),
          sourceSessionId: sourceId,
          headerForkSessionId: firstForkId,
          slashForkSessionId: secondForkId,
          sidebarForkSessionId: sidebarForkId,
          sidebarMenu: nativeMenu,
          nativePrompts: prompts(),
        },
        null,
        2,
      );
      await testInfo.attach(`${kind}-verified.json`, {
        body: Buffer.from(evidence),
        contentType: "application/json",
      });
      if (process.env.NODEX_E2E_EVIDENCE_DIR) {
        writeFileSync(
          path.join(process.env.NODEX_E2E_EVIDENCE_DIR, `${kind}-verified.json`),
          evidence,
        );
      }
    } finally {
      const mainLog = await readBoundedElectronRuntimeLogs(harness.profile, 250_000);
      await testInfo.attach(`${kind}-main.log`, {
        body: Buffer.from(mainLog),
        contentType: "text/plain",
      });
      const nativeLog = existsSync(observationsPath)
        ? readFileSync(observationsPath)
        : Buffer.from("");
      await testInfo.attach(`${kind}-native.jsonl`, { body: nativeLog, contentType: "text/plain" });
      if (process.env.NODEX_E2E_EVIDENCE_DIR) {
        mkdirSync(process.env.NODEX_E2E_EVIDENCE_DIR, { recursive: true });
        writeFileSync(
          path.join(process.env.NODEX_E2E_EVIDENCE_DIR, `${kind}-native.jsonl`),
          nativeLog,
        );
        writeFileSync(path.join(process.env.NODEX_E2E_EVIDENCE_DIR, `${kind}-main.log`), mainLog);
      }
      await harness.close();
    }
  });
}
