import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  createAgentSmokeDraft,
  invokeIpc,
  readRuntimeConversation,
  waitForRuntimeCompletedAgentTurn,
  type AgentRuntimeTarget,
} from "./support/agent-smoke-harness";
import { chooseComposerModel } from "./support/composer-model-picker";
import type { ProjectSession } from "../../src/shared/types";

const prompt = "Verify Claude turn work collapse";
const narrationText = "I will inspect the collapse fixture before replying.";
const replyTexts = [
  "The Claude collapse fixture is ready.",
  "Both final reply blocks remain visible.",
] as const;

test("keeps every final Claude reply block visible while completed work is collapsed", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "claude-turn-work-collapse",
    environment: {
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: path.resolve("."),
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
    },
  });
  const nativeHome = path.join(harness.profile.runRoot, "claude-config");
  const observationsPath = path.join(nativeHome, "observations.jsonl");
  const binaryPath = path.join(harness.profile.runRoot, "claude");
  const fixtureUrl = pathToFileURL(
    path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"),
  ).href;
  const rendererErrors: string[] = [];
  let target: AgentRuntimeTarget | undefined;

  try {
    writeFileSync(binaryPath, `#!${process.execPath}\nimport(${JSON.stringify(fixtureUrl)});\n`, {
      mode: 0o755,
    });
    const page = await harness.launch();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await invokeIpc(page, "settings:claude-agents:update", {
      instances: [
        {
          id: "claude-default",
          displayName: "Claude Code",
          binaryPath,
          configDirectory: nativeHome,
          enabled: true,
          environment: [],
        },
      ],
    });
    const { projectSessionId } = await createAgentSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      "Claude reply collapse",
    );
    await chooseComposerModel(page, "Claude Opus 5", "Claude Opus 5");
    await page.keyboard.press("Escape");
    const composer = page.getByLabel("Do anything", { exact: true });
    await expect(async () => {
      await composer.fill(prompt);
      await expect(composer).toHaveText(prompt, { timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();

    let session: ProjectSession | null = null;
    await expect
      .poll(
        async () => {
          session = (await invokeIpc(
            page,
            "project-sessions:get",
            projectSessionId,
          )) as ProjectSession;
          return session.executionRef?.threadId;
        },
        { timeout: 45_000 },
      )
      .toBeTruthy();
    const launched = session as ProjectSession | null;
    if (!launched?.executionRef) throw new Error("Claude chat did not bind its Runtime Thread");
    target = { sessionId: projectSessionId, threadId: launched.executionRef.threadId };
    await waitForRuntimeCompletedAgentTurn(page, target, 30_000);

    const workedFor = page.getByRole("button", { name: /^Worked for /u });
    const narration = page.getByText(narrationText, { exact: true });
    const toolRow = page.getByRole("button", { name: /Ran echo claude-work-collapse-probe/u });

    await expect(
      page.getByTestId("session-thread-page").getByText(prompt, { exact: true }),
    ).toBeVisible();
    await expect(workedFor).toHaveAttribute("aria-expanded", "false");
    for (const text of replyTexts)
      await expect(page.getByText(text, { exact: true })).toBeVisible();
    await expect(narration).toBeHidden();
    await expect(toolRow).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath("claude-turn-work-collapsed.png"),
      animations: "disabled",
    });

    await workedFor.click();
    await expect(workedFor).toHaveAttribute("aria-expanded", "true");
    await expect(narration).toBeVisible();
    await expect(toolRow).toBeVisible();
    for (const text of replyTexts)
      await expect(page.getByText(text, { exact: true })).toBeVisible();
    await toolRow.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("claude-turn-work-expanded.png"),
      animations: "disabled",
    });

    await workedFor.click();
    await expect(workedFor).toHaveAttribute("aria-expanded", "false");
    await expect(narration).toBeHidden();
    await expect(toolRow).toBeHidden();
    for (const text of replyTexts)
      await expect(page.getByText(text, { exact: true })).toBeVisible();
  } catch (error) {
    await harness.page.screenshot({
      path: testInfo.outputPath("claude-turn-work-collapse-failure.png"),
    });
    if (target) {
      await testInfo.attach("claude-conversation", {
        body: JSON.stringify(await readRuntimeConversation(harness.page, target)),
        contentType: "application/json",
      });
    }
    await testInfo.attach("claude-peer", {
      body: existsSync(observationsPath)
        ? readFileSync(observationsPath, "utf8")
        : "No native user messages were received",
      contentType: "text/plain",
    });
    await testInfo.attach("claude-runtime", {
      body: await readBoundedElectronRuntimeLogs(harness.profile),
      contentType: "text/plain",
    });
    await testInfo.attach("claude-renderer", {
      body: `${rendererErrors.join("\n")}\n${await harness.page.locator("body").innerText()}`,
      contentType: "text/plain",
    });
    throw error;
  } finally {
    await harness.close();
  }
});
