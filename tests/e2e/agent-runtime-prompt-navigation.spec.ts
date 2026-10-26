import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import { materializeScenario } from "../../scripts/scenarios/seed/scenario-seed";
import {
  AGENT_CLI_PROJECT_NAME,
  AGENT_CLI_SCENARIO_ID,
} from "../../scripts/scenarios/scenarios/agent-cli-workflow";
import type { IpcApi } from "../../src/shared/ipc-api";
import { chooseComposerModel } from "./support/composer-model-picker";

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

const PROMPT_COUNT = 6;
const prompt = (index: number) => `Verify prompt navigation ${index}`;

test("a reopened Claude chat navigates every prompt, including history it has not loaded", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const harness = await ElectronScenarioHarness.create({
    label: "agent-runtime-prompt-navigation",
    retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
  });
  const nativeHome = path.join(harness.profile.runRoot, "claude-native");
  const workspace = path.join(harness.profile.runRoot, "navigation-workspace");
  mkdirSync(workspace);
  const binaryPath = path.join(harness.profile.runRoot, "claude");
  const peer = pathToFileURL(path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"));
  writeFileSync(binaryPath, `#!${process.execPath}\nimport(${JSON.stringify(peer.href)});\n`, {
    mode: 0o755,
  });
  const rendererErrors: string[] = [];
  let failurePage: Page | undefined;
  try {
    const page = await harness.launch();
    failurePage = page;
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await harness.waitForApplicationReady();
    await harness.application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
    });
    await materializeScenario(AGENT_CLI_SCENARIO_ID, new RendererIpcSeedAdapter(page), workspace);
    await invoke(page, "settings:claude-agents:update", {
      instances: [
        {
          id: "claude-default",
          displayName: "Claude Code",
          binaryPath,
          configDirectory: nativeHome,
          enabled: true,
          customModels: [],
          environment: [],
        },
      ],
    });
    await page
      .getByRole("button", { name: `Start new chat in ${AGENT_CLI_PROJECT_NAME}`, exact: true })
      .click();
    await chooseComposerModel(page, "Claude Opus 5", "Claude Opus 5");

    const composer = page.locator('[data-codex-composer="true"]:visible').first();
    const bubble = (text: string) =>
      page
        .locator('[data-user-message-bubble="true"]', { hasText: text })
        .filter({ visible: true });
    const visibleSession = async () =>
      (
        await page
          .locator('[data-workbench-scene-owner^="session:"]:visible')
          .first()
          .getAttribute("data-workbench-scene-owner")
      )?.slice("session:".length) ?? null;
    // A new chat's Session binds its execution after the first submission is accepted.
    const runs = async (sessionId: string | null) =>
      sessionId
        ? ((await invoke(page, "agent-runtime:session:read", { sessionId }).catch(() => null))
            ?.snapshot.projection.runs ?? [])
        : [];
    let sessionId: string | null = null;
    for (let index = 1; index <= PROMPT_COUNT; index += 1) {
      await expect(composer).toBeEditable();
      await composer.fill(prompt(index));
      await composer.press("Enter");
      await expect
        .poll(
          async () => {
            sessionId ??= await visibleSession();
            // A bounded read carries only its window's Run records.
            const settled = await runs(sessionId);
            return settled.find((run) => run.ordinal === index)?.status === "completed";
          },
          { timeout: 60_000 },
        )
        .toBe(true);
    }
    if (!sessionId) throw new Error("The chat has no Session");

    // Reopening loads one bounded page, which holds fewer prompts than the rail requires.
    const reopened = await invoke(page, "agent-runtime:session:read", { sessionId });
    expect(reopened?.snapshot.hasMoreHistory).toBe(true);
    expect(
      reopened?.snapshot.projection.visibleTurnItems.filter(
        (row) => row.item.type === "user_message",
      ).length,
    ).toBeLessThan(4);

    await page.reload();
    await page.evaluate(() => window.api?.awaitInitialization?.());
    await expect(bubble(prompt(PROMPT_COUNT))).toHaveCount(1, { timeout: 30_000 });
    await expect(bubble(prompt(1))).toHaveCount(0);

    // The rail needs room beside the transcript, which a pinned summary takes at this width.
    const summary = page.getByRole("button", { name: "Toggle pinned summary", exact: true });
    if ((await summary.getAttribute("aria-pressed")) === "true") await summary.click();

    const rail = page.getByRole("navigation", { name: "User messages", exact: true });
    await expect(rail).toBeVisible({ timeout: 15_000 });
    const markers = rail.getByRole("button", { name: /^Jump to user message \d+$/u });
    await expect(markers).toHaveCount(PROMPT_COUNT);

    const first = rail.getByRole("button", { name: "Jump to user message 1", exact: true });
    // The index carries each prompt's preview, so hovering needs no history.
    await first.hover();
    await expect(page.getByRole("tooltip")).toContainText(prompt(1));
    await expect(page.getByRole("tooltip")).toContainText("Navigation reply 1");
    await first.click();
    await expect(bubble(prompt(1))).toBeInViewport({ timeout: 30_000 });
    await expect(markers).toHaveCount(PROMPT_COUNT);

    const screenshot = await page.screenshot({ animations: "disabled" });
    await testInfo.attach("prompt-navigation.png", { body: screenshot, contentType: "image/png" });
    if (process.env.NODEX_E2E_EVIDENCE_DIR) {
      mkdirSync(process.env.NODEX_E2E_EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        path.join(process.env.NODEX_E2E_EVIDENCE_DIR, "prompt-navigation.png"),
        screenshot,
      );
    }
    expect(rendererErrors).toEqual([]);
  } catch (error) {
    if (failurePage) {
      await failurePage.screenshot({ path: testInfo.outputPath("failure.png") });
      const sessionId = (
        await failurePage
          .locator('[data-workbench-scene-owner^="session:"]:visible')
          .first()
          .getAttribute("data-workbench-scene-owner")
          .catch(() => null)
      )?.slice("session:".length);
      if (sessionId)
        writeFileSync(
          testInfo.outputPath("conversation.json"),
          JSON.stringify(
            await invoke(failurePage, "agent-runtime:session:read", { sessionId }).catch(
              (cause: unknown) => String(cause),
            ),
            null,
            2,
          ),
        );
    }
    throw error;
  } finally {
    await harness.close();
  }
});
