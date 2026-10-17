import { expect, test, type Page } from "@playwright/test";
import { openNewChatDraft } from "./support/new-chat-draft";
import fs from "node:fs";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";

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
  const newThreadComposer = (await openNewChatDraft(page)).locator(
    '[data-codex-composer="true"][aria-label="Do anything"]',
  );
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

const readAcceptedInputs = (logPath: string): string[] => {
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

// A Turn that follows history Codex has not seen carries that history ahead of the user's words.
const readAcceptedPrompts = (logPath: string): string[] =>
  readAcceptedInputs(logPath).map((text) => text.split("\nUser message:\n").at(-1)!);

const sendNow = async (page: Page, prompt: string): Promise<void> => {
  await queuedRow(page, prompt)
    .getByRole("button", { name: "Submit without interrupting the model" })
    .click();
};

test("persists an interrupted queue across restart and sends the chosen message before the rest", async () => {
  test.setTimeout(120_000);
  const harness = await createQueueHarness("codex-queued-follow-up-restart");

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
    expect(readAcceptedPrompts(scenarioLogPath)).toEqual(["Hold the active turn for queue parity"]);

    // Sending a held message while idle sends exactly that one; the queue follows in order.
    await sendNow(page, "Second queued follow-up");
    await expect(queuedRow(page, "Second queued follow-up")).toHaveCount(0, { timeout: 30_000 });
    await expect(queuedRow(page, "First queued follow-up")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(interruptedReason, { exact: true })).toHaveCount(0);
    await expect
      .poll(() => readAcceptedPrompts(scenarioLogPath))
      .toEqual([
        "Hold the active turn for queue parity",
        "Second queued follow-up",
        "First queued follow-up",
      ]);
  } finally {
    await harness.close();
  }
});

test("holds the rest of the queue after a message fails until it is resumed", async () => {
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

    // The failed message stays in the conversation with its error; the next one waits.
    await expect(queuedRow(page, failedPrompt)).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.getByText("The provider could not start this turn.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("Queue paused because a message failed", { exact: true }),
    ).toBeVisible();
    await expect(queuedRow(page, laterPrompt)).toBeVisible();
    expect(readAcceptedPrompts(scenarioLogPath)).toEqual(["Hold the active turn for queue parity"]);

    await resumeQueue(page);
    await expect(queuedRow(page, laterPrompt)).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(() => readAcceptedPrompts(scenarioLogPath))
      .toEqual(["Hold the active turn for queue parity", laterPrompt]);
    // Codex learns that the failed message never ran.
    const handoff = readAcceptedInputs(scenarioLogPath).at(-1)!;
    expect(handoff).toContain(failedPrompt);
    expect(handoff).toContain("The provider could not start this turn.");
    await expect(page.getByText("The task completed successfully.").first()).toBeVisible();
  } finally {
    await harness.close();
  }
});
