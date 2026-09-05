import { createUuidV7FromTimestamp } from "../../src/shared/uuid-v7";
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { decodeCodexAsyncQuestionReplies } from "../../src/shared/codex-async-user-input";

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
  await page.getByRole("button", { name: "New chat" }).first().click();
  // Wait for the durable draft Task before typing into its Composer.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const projects = (await window.api?.invoke("projects:list")) as
          | { items: Array<{ id: string }> }
          | undefined;
        const projectId = projects?.items[0]?.id;
        if (!projectId) return 0;
        const tasks = (await window.api?.invoke("workspace:tasks:list", projectId, {
          first: 50,
        })) as { items: Array<{ thread?: unknown }> } | undefined;
        return tasks?.items.filter((task) => task.thread == null).length ?? 0;
      }),
    )
    .toBe(1);
  const composer = page.locator('[data-codex-composer="true"][aria-label="Do anything"]');
  // Draft Task hydration can replace the initial Composer after persistence completes.
  await expect(async () => {
    await composer.fill("Ask optional questions and continue checking the files");
    await expect(page.getByRole("button", { name: "Send prompt" })).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await page.getByRole("button", { name: "Send prompt" }).click();
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
    await expect(page.getByRole("button", { name: "Answer question", exact: true })).toHaveCount(0);
    await expect(page.getByText("Which scope should I use?", { exact: true })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("question-completed.png") });
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

for (const failure of ["inactive", "mismatch"] as const) {
  test(`preserves an asynchronous answer after ${failure} without starting work`, async ({}, testInfo) => {
    const harness = await createQuestionHarness({ NODEX_FAKE_CODEX_ASYNC_STEER_FAILURE: failure });
    try {
      const page = await startQuestionScenario(harness);
      const panel = page.getByRole("group", { name: "Agent question" });
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await panel.getByRole("radio", { name: "Project", exact: true }).click();
      await panel.getByLabel("Reply…").fill("Keep this answer on its question");
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      if (failure === "inactive")
        await expect(page.getByRole("alert")).toContainText("Couldn’t send response");
      await expect
        .poll(
          () =>
            fs
              .readFileSync(
                path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl"),
                "utf8",
              )
              .trim()
              .split("\n")
              .filter((line) => JSON.parse(line).method === "turn/steer").length,
        )
        .toBe(failure === "mismatch" ? 2 : 1);
      await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await expect(panel.getByLabel("Reply…")).toHaveText("Keep this answer on its question");
      const entries = fs
        .readFileSync(path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string });
      expect(entries.filter((entry) => entry.method === "turn/steer")).toHaveLength(
        failure === "mismatch" ? 2 : 1,
      );
      expect(entries.filter((entry) => entry.method === "turn/start")).toHaveLength(1);
      await panel.screenshot({ path: testInfo.outputPath(`question-${failure}.png`) });
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
