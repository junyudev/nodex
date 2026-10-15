import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import type { CodexQueuedMessageState } from "../../src/shared/codex-queued-message";
import type { IpcApi } from "../../src/shared/ipc-api";
import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2";

const repositoryRoot = process.cwd();
const interruptedReason = "Queue paused because you interrupted";

const queuedRow = (page: Page, prompt: string) =>
  page.locator("[data-queued-follow-up-row]").filter({ hasText: prompt });

const createQueueHarness = async (
  label: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<ElectronScenarioHarness> => {
  const harness = await ElectronScenarioHarness.create({
    label,
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      ...environment,
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.join(repositoryRoot, "tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  return harness;
};

const queueAndInterrupt = async (
  harness: ElectronScenarioHarness,
  prompts: readonly string[],
  beforeQueue?: (page: Page) => Promise<void>,
): Promise<Page> => {
  const page = await harness.launch();
  await page.getByRole("button", { name: "New chat" }).first().click();
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const projects = (await window.api?.invoke("projects:list")) as
            | { items?: Array<{ id?: unknown }> }
            | undefined;
          const projectId = projects?.items?.[0]?.id;
          if (typeof projectId !== "string") return 0;
          const tasks = (await window.api?.invoke("workspace:tasks:list", projectId, {
            first: 50,
          })) as { items?: Array<{ thread?: unknown }> } | undefined;
          return tasks?.items?.filter((item) => item.thread == null).length ?? 0;
        }),
    )
    .toBe(1);
  const newThreadComposer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
  await expect(newThreadComposer).toBeVisible();
  await newThreadComposer.fill("Hold the active turn for queue parity");
  await expect(newThreadComposer).toHaveText("Hold the active turn for queue parity");
  const sendButton = page.getByRole("button", { name: "Send prompt" });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stopButton).toBeVisible({ timeout: 30_000 });
  const composer = page.locator(
    '[data-codex-composer="true"][aria-label="Ask for follow-up changes"]',
  );
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await beforeQueue?.(page);

  for (const prompt of prompts) {
    await composer.fill(prompt);
    await composer.press("Meta+Enter");
    await expect(queuedRow(page, prompt)).toBeVisible({ timeout: 30_000 });
    await expect(composer).toHaveAttribute("contenteditable", "true");
    await expect(composer).toHaveText("", { timeout: 30_000 });
  }

  await stopButton.click();
  await expect(page.getByText(interruptedReason, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  return page;
};

const resumeQueue = async (page: Page): Promise<void> => {
  await page
    .locator("#above-composer-queue-portal")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
};

const readAcceptedPrompts = (logPath: string): string[] => {
  const entries = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: { input?: unknown[] } });
  return entries
    .filter((entry) => entry.method === "turn/start" || entry.method === "turn/steer")
    .map((entry) => {
      const text = entry.params?.input?.find(
        (item): item is { type: "text"; text: string } =>
          typeof item === "object" &&
          item !== null &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string",
      );
      return text?.text ?? "";
    });
};

test("persists an interrupted queue across restart and continues FIFO after an explicit send", async () => {
  test.setTimeout(120_000);
  const harness = await createQueueHarness("codex-queued-follow-up-restart", {
    NODEX_FAKE_CODEX_RESUME_CLOSING_ATTEMPTS: "1",
  });

  try {
    const scenarioLogPath = path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl");
    let page = await queueAndInterrupt(harness, [
      "First queued follow-up",
      "Second queued follow-up",
    ]);

    page = await harness.restart();
    await expect(page.getByText(interruptedReason, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(queuedRow(page, "First queued follow-up")).toBeVisible();
    await expect(queuedRow(page, "Second queued follow-up")).toBeVisible();

    const resumeAttempts = fs
      .readFileSync(scenarioLogPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { method: string; params: { requestId: string; closing: boolean } },
      )
      .filter((entry) => entry.method === "resume-attempt");
    expect(resumeAttempts.map(({ params }) => params.closing)).toEqual([true, false]);
    expect(new Set(resumeAttempts.map(({ params }) => params.requestId)).size).toBe(2);

    await resumeQueue(page);
    await expect(page.getByText(interruptedReason, { exact: true })).toHaveCount(0);
    await expect(queuedRow(page, "First queued follow-up")).toBeVisible();
    await expect(queuedRow(page, "Second queued follow-up")).toBeVisible();
    expect(readAcceptedPrompts(scenarioLogPath)).toEqual(["Hold the active turn for queue parity"]);
    await queuedRow(page, "First queued follow-up")
      .getByRole("button", { name: "Submit without interrupting the model" })
      .click();
    await expect(queuedRow(page, "First queued follow-up")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(page.getByText("The task completed successfully.").first()).toBeVisible();
    await expect(queuedRow(page, "Second queued follow-up")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect
      .poll(() => readAcceptedPrompts(scenarioLogPath))
      .toEqual([
        "Hold the active turn for queue parity",
        "First queued follow-up",
        "Second queued follow-up",
      ]);
  } finally {
    await harness.close();
  }
});

test("keeps a failed head in place while a later row is sent and retried manually", async () => {
  test.setTimeout(120_000);
  const failedPrompt = "First queued follow-up";
  const laterPrompt = "Second queued follow-up";
  const harness = await createQueueHarness("codex-queued-follow-up-failure", {
    NODEX_FAKE_CODEX_FAIL_ONCE_PROMPT: failedPrompt,
  });

  try {
    const scenarioLogPath = path.join(harness.profile.runRoot, ".fake-codex", "requests.jsonl");
    const page = await queueAndInterrupt(harness, [failedPrompt, laterPrompt]);
    await resumeQueue(page);

    const failedRow = queuedRow(page, failedPrompt);
    const laterRow = queuedRow(page, laterPrompt);
    await failedRow.getByRole("button", { name: "Submit without interrupting the model" }).click();
    await expect(
      failedRow.getByRole("button", { name: "Try sending this queued message again" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(laterRow).toBeVisible();

    await laterRow.getByRole("button", { name: "Submit without interrupting the model" }).click();
    await expect(laterRow).toHaveCount(0, { timeout: 30_000 });
    await expect(failedRow).toBeVisible();
    await expect
      .poll(() => readAcceptedPrompts(scenarioLogPath))
      .toEqual(["Hold the active turn for queue parity", laterPrompt]);

    await failedRow.getByRole("button", { name: "Try sending this queued message again" }).click();
    await expect(failedRow).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(() => readAcceptedPrompts(scenarioLogPath))
      .toEqual(["Hold the active turn for queue parity", laterPrompt, failedPrompt]);
  } finally {
    await harness.close();
  }
});
