import { createUuidV7FromTimestamp } from "../../src/shared/uuid-v7";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { decodeCodexAsyncQuestionReplies } from "../../src/shared/codex-async-user-input";
import { attachComposerFailureEvidence } from "./support/composer-failure-evidence";
import { openNewChatDraft } from "./support/new-chat-draft";

async function createQuestionHarness(environment: Record<string, string> = {}) {
  const harness = await ElectronScenarioHarness.create({
    label: "async-user-input",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_ASYNC_QUESTIONS: "1",
      // Old Thread identity must not expire a fresh notification operation.
      NODEX_FAKE_CODEX_THREAD_ID: createUuidV7FromTimestamp(Date.UTC(2020, 0, 1)),
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
      ...environment,
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.join(process.cwd(), "tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  return harness;
}

async function startQuestionScenario(harness: ElectronScenarioHarness) {
  const page = await harness.launch();
  page.on("pageerror", (error) => console.error("ASYNC QUESTION RENDER ERROR", error.message));
  const scene = await openNewChatDraft(page);
  const composer = scene.locator('[data-codex-composer="true"][aria-label="Do anything"]');
  try {
    await composer.fill("Ask optional questions and continue checking the files");
    await scene.getByRole("button", { name: "Send prompt" }).click();
  } catch (error) {
    await attachComposerFailureEvidence(page, test.info());
    throw error;
  }
  return page;
}

test("answers optional questions while the Agent continues and keeps the ordinary Composer usable", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await createQuestionHarness();
  try {
    const page = await startQuestionScenario(harness);
    const panel = page.getByRole("group", { name: "Agent question" });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Next question" })).toBeDisabled();
    const normalComposer = page.locator(
      '[data-codex-composer="true"][aria-label="Ask for follow-up changes"]',
    );
    await expect(normalComposer).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(
      page.getByText("I am checking the available files while you answer.", { exact: true }),
    ).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath("question-choice.png") });
    await panel.locator("[data-async-question-reply-row]").hover();
    await panel.screenshot({ path: testInfo.outputPath("question-inline-hover.png") });
    await panel.getByRole("radio", { name: "Project", exact: true }).hover();
    await panel.screenshot({ path: testInfo.outputPath("question-option-hover.png") });
    await normalComposer.fill("@");
    await expect(panel).not.toBeVisible();
    await normalComposer.fill("Keep this independent draft");
    await expect(panel).toBeVisible();
    await panel.getByRole("radio", { name: "Project", exact: true }).click();
    const reply = panel.getByLabel("Reply…");
    await expect(reply).toBeVisible();
    await expect(reply).toBeFocused();
    await panel.screenshot({ path: testInfo.outputPath("question-freeform.png") });
    await reply.fill("Release checklist");
    await panel.getByRole("button", { name: "Close question" }).click();
    await expect(panel).not.toBeVisible();
    await page.getByRole("button", { name: "Answer question", exact: true }).last().click();
    await expect(panel.getByLabel("Reply…")).toHaveText("Release checklist");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel).not.toBeVisible();
    await expect(normalComposer).toHaveText("Keep this independent draft");
    const logPath = path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl");
    const requests = () =>
      fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method: string;
              params: { expectedTurnId?: string; input?: { type: string; text?: string }[] };
            },
        );
    await expect
      .poll(() => requests().filter((entry) => entry.method === "turn/steer").length)
      .toBe(1);
    const steer = requests().find((entry) => entry.method === "turn/steer")!;
    expect(steer.params.expectedTurnId).toBeTruthy();
    expect(decodeCodexAsyncQuestionReplies(steer.params.input?.[0]?.text ?? "")).toMatchObject([
      { question: "What should I call it?", answer: "Release checklist" },
    ]);
    expect(requests().filter((entry) => entry.method === "turn/start")).toHaveLength(1);
    await expect(
      page.locator('[data-user-message-bubble="true"]').filter({ hasText: "Release checklist" }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("question-answered.png") });
    await normalComposer.fill("");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Answer question", exact: true })).toHaveCount(1);
    await expect(page.getByText("Which scope should I use?", { exact: true })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("question-completed.png") });
    await page.getByRole("button", { name: "Answer question", exact: true }).click();
    await panel.getByRole("radio", { name: "Project", exact: true }).click();
    await expect
      .poll(() => requests().filter((entry) => entry.method === "turn/start").length)
      .toBe(2);
    const nextTurn = requests().filter((entry) => entry.method === "turn/start")[1]!;
    expect(decodeCodexAsyncQuestionReplies(nextTurn.params.input?.[0]?.text ?? "")).toEqual([
      expect.objectContaining({ question: "Which scope should I use?", answer: "Project" }),
    ]);
    const answer = page
      .locator('[data-user-message-bubble="true"]')
      .filter({ hasText: "Which scope should I use?" });
    await expect(answer).toBeVisible();
    await expect(answer).toContainText("Project");
    await expect(answer).not.toContainText("<send_user_message_question_reply>");
    await page.reload();
    await expect(answer).toBeVisible();
    await expect(answer).not.toContainText("<send_user_message_question_reply>");
  } catch (error) {
    fs.writeFileSync(
      testInfo.outputPath("runtime-logs.txt"),
      await readBoundedElectronRuntimeLogs(harness.profile, 500_000),
    );
    for (const name of ["state.json", "requests.jsonl"]) {
      const source = path.join(harness.profile.runRoot, ".fake-codex", name);
      if (fs.existsSync(source)) fs.copyFileSync(source, testInfo.outputPath(name));
    }
    throw error;
  } finally {
    await harness.close();
  }
});

test("restores an optional answer draft after Stop and application restart", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await createQuestionHarness();
  try {
    let page = await startQuestionScenario(harness);
    let panel = page.getByRole("group", { name: "Agent question" });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).not.toBeVisible();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close question" }).click();
    await page.getByRole("button", { name: "Answer question", exact: true }).last().click();
    await panel.getByLabel("Reply…").fill("Release checklist retained after restart");
    page = await harness.restart();
    panel = page.getByRole("group", { name: "Agent question" });
    await expect
      .poll(
        async () =>
          (await panel.isVisible()) ||
          (await page
            .getByRole("button", { name: "Answer question", exact: true })
            .last()
            .isVisible()),
      )
      .toBe(true);
    if (!(await panel.isVisible()))
      await page.getByRole("button", { name: "Answer question", exact: true }).last().click();
    await expect(panel.getByLabel("Reply…")).toHaveText("Release checklist retained after restart");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    const answer = page
      .locator('[data-user-message-bubble="true"]')
      .filter({ hasText: "Release checklist retained after restart" });
    await expect(answer).toBeVisible();
    await expect(answer).not.toContainText("<send_user_message_question_reply>");
    await expect(page.getByRole("button", { name: "Answer question", exact: true })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("draft-restored-and-sibling-retained.png") });
  } catch (error) {
    fs.writeFileSync(
      testInfo.outputPath("runtime-logs.txt"),
      await readBoundedElectronRuntimeLogs(harness.profile, 300_000),
    );
    throw error;
  } finally {
    await harness.close();
  }
});

test("keeps unanswered questions visible after a final reply and panel dismissal", async () => {
  const harness = await createQuestionHarness({
    NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
    NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "2000",
  });
  try {
    const page = await startQuestionScenario(harness);
    const panel = page.getByRole("group", { name: "Agent question" });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).not.toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("The task completed successfully.", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close question" }).click();
    await expect(page.getByRole("button", { name: "Answer question", exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: "Answer question", exact: true }).last().click();
    await expect(panel.getByLabel("Reply…")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("preserves private questions and custom-answer restrictions through Agent execution", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const harness = await createQuestionHarness({
    NODEX_FAKE_CODEX_ASYNC_QUESTIONS: "0",
    NODEX_FAKE_CODEX_SYNC_QUESTIONS: "1",
  });
  let page: Page | undefined;
  try {
    page = await startQuestionScenario(harness);
    const secret = page.locator('input[type="password"]');
    await expect(secret).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Dictate", exact: true })).toBeDisabled();
    await secret.fill("synthetic-private-token");
    await secret.press("Enter");
    await expect(page.getByRole("radio", { name: "Project", exact: true })).toBeVisible();
    const question = page.locator("[data-request-question-key]");
    await expect(question.locator('input,textarea,[contenteditable="true"]')).toHaveCount(0);
    await page.getByRole("radio", { name: "Project", exact: true }).click();
    const requests = () =>
      fs
        .readFileSync(path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method: string;
              params: { result?: { answers?: Record<string, { answers: string[] }> } };
            },
        );
    await expect
      .poll(() => requests().filter((entry) => entry.method === "question-response").length)
      .toBe(1);
    expect(
      requests().find((entry) => entry.method === "question-response")?.params.result?.answers,
    ).toEqual({
      private: { answers: ["synthetic-private-token"] },
      scope: { answers: ["Project"] },
    });
    await expect(page.getByText("The task completed successfully.", { exact: true })).toBeVisible();
    const work = page.getByRole("button", { name: /^Worked for/u });
    if ((await work.count()) > 0 && (await work.getAttribute("aria-expanded")) === "false")
      await work.click();
    await page.getByRole("button", { name: "Asked 2 questions", exact: true }).click();
    await expect(page.getByText("Hidden response", { exact: true })).toBeVisible();
    await expect(page.getByText("synthetic-private-token", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("private-answer-history.png") });
  } catch (error) {
    if (page && !page.isClosed())
      await page.screenshot({ path: testInfo.outputPath("private-question-failure.png") });
    fs.writeFileSync(
      testInfo.outputPath("runtime-logs.txt"),
      await readBoundedElectronRuntimeLogs(harness.profile, 300_000),
    );
    throw error;
  } finally {
    await harness.close();
  }
});

for (const failure of ["inactive", "mismatch"] as const) {
  test(`keeps an answer the running Turn refused (${failure}) as the next message`, async ({}, testInfo) => {
    const harness = await createQuestionHarness({ NODEX_FAKE_CODEX_ASYNC_STEER_FAILURE: failure });
    try {
      const page = await startQuestionScenario(harness);
      const panel = page.getByRole("group", { name: "Agent question" });
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await panel.getByRole("radio", { name: "Project", exact: true }).click();
      await panel.getByLabel("Reply…").fill("Keep this answer on its question");
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      await expect(panel).not.toBeVisible();
      // Agent execution owns the answer once sent: it waits for the Turn instead of being lost.
      await expect(
        page
          .locator("[data-queued-follow-up-row]")
          .filter({ hasText: "Keep this answer on its question" }),
      ).toBeVisible({ timeout: 30_000 });
      const entries = () =>
        fs
          .readFileSync(path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method: string });
      // A mismatch is corrected and retried once; the refusal never starts new work mid-Turn.
      expect(entries().filter((entry) => entry.method === "turn/steer")).toHaveLength(
        failure === "mismatch" ? 2 : 1,
      );
      expect(entries().filter((entry) => entry.method === "turn/start")).toHaveLength(1);
      await page.screenshot({ path: testInfo.outputPath(`question-${failure}.png`) });
    } catch (error) {
      fs.writeFileSync(
        testInfo.outputPath("runtime-logs.txt"),
        await readBoundedElectronRuntimeLogs(harness.profile, 500_000),
      );
      throw error;
    } finally {
      await harness.close();
    }
  });
}

test("corrects the active Turn identity and accepts answers before their server echo", async () => {
  const harness = await createQuestionHarness({
    NODEX_FAKE_CODEX_ASYNC_STEER_FAILURE: "mismatch-once",
    NODEX_FAKE_CODEX_ASYNC_ECHO_DELAY_MS: "60000",
  });
  try {
    const page = await startQuestionScenario(harness);
    const panel = page.getByRole("group", { name: "Agent question" });
    await expect(panel).toBeVisible();
    await panel.getByRole("radio", { name: "Project", exact: true }).click();
    await panel.getByLabel("Reply…").fill("Accepted before echo");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel).not.toBeVisible();
    await expect(
      page.locator('[data-user-message-bubble="true"]').filter({ hasText: "Accepted before echo" }),
    ).toBeVisible();
    const entries = fs
      .readFileSync(path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params: { expectedTurnId?: string; input?: unknown };
          },
      );
    const steers = entries.filter((entry) => entry.method === "turn/steer");
    expect(steers).toHaveLength(2);
    expect(steers[1]?.params.expectedTurnId).toBe("replacement-turn");
    expect(steers[1]?.params.input).toEqual(steers[0]?.params.input);
    expect(entries.filter((entry) => entry.method === "turn/start")).toHaveLength(1);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).not.toBeVisible();
  } finally {
    await harness.close();
  }
});
