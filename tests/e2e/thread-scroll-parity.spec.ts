import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import {
  createAgentSmokeDraft,
  sendAgentFollowUp,
  sendAgentPrompt,
} from "./support/agent-smoke-harness";
import { openNewChatDraft } from "./support/new-chat-draft";

const controlledPrompt = "Continue the scroll review";
const paragraphs = (prefix: string, count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `${prefix} ${index + 1}. The review keeps the conversation readable while work progresses. ` +
      "A reader can stop following the latest response and inspect earlier details.",
  ).join("\n\n");

async function createScrollHarness(questions = false) {
  const harness = await ElectronScenarioHarness.create({
    label: questions ? "answered-question-order" : "thread-scroll-parity",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_COMMAND_PATH: ".fake-codex/commands.jsonl",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_FINAL_REPLY_PATH: ".fake-codex/final.md",
      NODEX_FAKE_CODEX_BASE_FIXTURE: path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "120",
      NODEX_FAKE_CODEX_RESUMED_COMPLETION_DELAY_MS: "120",
      NODEX_FAKE_CODEX_CONTROLLED_PROMPT: controlledPrompt,
      NODEX_FAKE_CODEX_APP_SERVER_VERSION: "0.162.0-alpha.17.2",
      ...(questions ? { NODEX_FAKE_CODEX_ASYNC_QUESTIONS: "1" } : {}),
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-transcript-performance-app-server.mjs"),
    "0.162.0-alpha.17.2",
  );
  const directory = path.join(harness.profile.runRoot, ".fake-codex");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "state.json"),
    JSON.stringify({
      thread: null,
      turns: [],
      turnSequence: 0,
      queueSequence: 0,
      queuedSubmissions: [],
    }),
  );
  await writeFile(path.join(directory, "final.md"), paragraphs("Earlier review", 20));
  return {
    harness,
    final: (text: string) => writeFile(path.join(directory, "final.md"), text),
    command: (
      command:
        | { type: "start" | "complete" }
        | { type: "delta"; delta: string }
        | { type: "item"; item: ThreadItem },
    ) => appendFile(path.join(directory, "commands.jsonl"), `${JSON.stringify(command)}\n`),
  };
}

const viewportFor = (page: Page, sessionId: string) =>
  page.locator(
    `[data-workbench-scene-owner="session:${sessionId}"] [data-local-conversation-thread-body="true"]`,
  );
const distanceFromBottom = (viewport: Locator) =>
  viewport.evaluate((element) =>
    Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop),
  );

async function settleFrames(page: Page, count = 12) {
  await page.evaluate(async (count) => {
    for (let index = 0; index < count; index++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}

/** Wheel input belongs to the transcript, clear of the Composer and nested tool output. */
async function wheelThread(page: Page, viewport: Locator, deltaY: number) {
  const bounds = await viewport.boundingBox();
  if (!bounds) throw new Error("The conversation viewport is not visible");
  await page.mouse.move(bounds.x + 20, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, deltaY);
  await settleFrames(page);
}

async function catchUp(page: Page, viewport: Locator) {
  const button = page.getByRole("button", { name: "Scroll to latest message", exact: true });
  if (await button.isVisible()) await button.click();
  else await wheelThread(page, viewport, 100_000);
  await expect.poll(() => distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
}

async function returnToThread(page: Page, threadId: string, sessionId: string) {
  await openNewChatDraft(page);
  await page
    .locator(
      `[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id="${threadId}"]`,
    )
    .click();
  await expect(viewportFor(page, sessionId)).toBeVisible();
  await settleFrames(page);
}

async function attachFailure(
  harness: ElectronScenarioHarness,
  page: Page | undefined,
  testInfo: TestInfo,
) {
  await testInfo.attach("runtime-logs", {
    body: await readBoundedElectronRuntimeLogs(harness.profile, 300_000),
    contentType: "text/plain",
  });
  if (page && !page.isClosed())
    await testInfo.attach("conversation", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
}

test("small upward wheels retain the reading position through tool resize, completion and Scene restore", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const fixture = await createScrollHarness();
  const { harness } = fixture;
  let page: Page | undefined;
  try {
    page = await harness.launch();
    await page.setViewportSize({ width: 1100, height: 800 });
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      "Conversation scrolling",
    );
    const threadId = await sendAgentPrompt(
      page,
      draft.projectSessionId,
      "Prepare earlier review history",
    );
    await expect(page.getByText("Earlier review 20.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await fixture.final("The second review is complete.");
    await sendAgentFollowUp(page, "Prepare a short second review");
    await expect(page.getByText("The second review is complete.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await sendAgentFollowUp(page, controlledPrompt);
    for (let index = 0; index < 12; index++) {
      const command = `printf 'scroll-review-${index}'`;
      await fixture.command({
        type: "item",
        item: {
          type: "commandExecution",
          id: `scroll-command-${index}`,
          command,
          cwd: harness.profile.initialProjectsDirectory,
          pluginId: null,
          scriptPath: null,
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [{ type: "unknown", command }],
          aggregatedOutput: paragraphs(`Command ${index} output`, 3),
          exitCode: 0,
          durationMs: 20,
        },
      });
    }
    await fixture.command({ type: "start" });
    await fixture.command({ type: "delta", delta: "The current review is ready.\n\n" });
    await expect(page.getByText("The current review is ready.", { exact: true })).toBeVisible();
    const viewport = viewportFor(page, draft.projectSessionId);
    await catchUp(page, viewport);
    const beforeWheelTop = await viewport.evaluate((element) => element.scrollTop);
    await wheelThread(page, viewport, -8);
    const firstHold = await distanceFromBottom(viewport);
    const afterWheelTop = await viewport.evaluate((element) => element.scrollTop);
    // Placement space decays with the wheel, so its physical bottom distance can stay at 1px.
    expect(afterWheelTop).toBeLessThan(beforeWheelTop - 1);
    expect(firstHold).toBeLessThan(24);
    const user = page
      .locator('[data-user-message-bubble="true"]')
      .filter({ hasText: controlledPrompt });
    const beforeExpansion = await user.evaluate((element) => element.getBoundingClientRect().top);
    const samples = user.evaluate(async (element) => {
      const values: number[] = [];
      for (let index = 0; index < 30; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        values.push(element.getBoundingClientRect().top);
      }
      return values;
    });
    const work = page.getByRole("button", { name: "Ran commands", exact: true });
    await work.click();
    await expect(work).toHaveAttribute("aria-expanded", "true");
    const expansionSamples = await samples;
    expect(
      Math.max(...expansionSamples.map((top) => Math.abs(top - beforeExpansion))),
    ).toBeLessThanOrEqual(1);
    await fixture.command({ type: "delta", delta: `\n\n${paragraphs("Later review", 10)}\n\n` });
    await expect(page.getByText("Later review 10.", { exact: false })).toHaveCount(1);
    await settleFrames(page);
    expect(
      Math.abs(
        (await user.evaluate((element) => element.getBoundingClientRect().top)) - beforeExpansion,
      ),
    ).toBeLessThanOrEqual(1);
    await fixture.command({ type: "complete" });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await settleFrames(page);
    expect(
      Math.abs(
        (await user.evaluate((element) => element.getBoundingClientRect().top)) - beforeExpansion,
      ),
    ).toBeLessThanOrEqual(1);
    await catchUp(page, viewport);
    const distances: number[] = [];
    for (let index = 0; index < 4; index++) {
      const before = await distanceFromBottom(viewport);
      await wheelThread(page, viewport, -8);
      const after = await distanceFromBottom(viewport);
      expect(after).toBeGreaterThan(before + 1);
      distances.push(after);
    }
    const savedDistance = await distanceFromBottom(viewport);
    await returnToThread(page, threadId, draft.projectSessionId);
    await expect.poll(() => distanceFromBottom(viewport)).toBeCloseTo(savedDistance, 0);
    const restoredDistance = await distanceFromBottom(viewport);
    await wheelThread(page, viewport, -8);
    const afterRestoreWheelDistance = await distanceFromBottom(viewport);
    expect(afterRestoreWheelDistance).toBeGreaterThan(savedDistance + 1);
    const geometry = {
      status: "passed",
      fixture: "three-turn conversation with native command output and streamed Markdown",
      firstHold,
      beforeWheelTop,
      afterWheelTop,
      distances,
      savedDistance,
      restoredDistance,
      afterRestoreWheelDistance,
      expansionSamples,
    };
    const artifacts = process.env.NODEX_THREAD_SCROLL_ARTIFACT_DIR;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        path.join(artifacts, "scroll-geometry.json"),
        `${JSON.stringify(geometry, null, 2)}\n`,
      );
    }
    await testInfo.attach("scroll-geometry", {
      body: JSON.stringify(geometry, null, 2),
      contentType: "application/json",
    });
  } catch (error) {
    await attachFailure(harness, page, testInfo);
    throw error;
  } finally {
    await harness.close();
  }
});

test("answered questions remain before their replies and later Markdown after Scene restore", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await createScrollHarness(true);
  const { harness } = fixture;
  const artifacts = process.env.NODEX_THREAD_SCROLL_ARTIFACT_DIR;
  const claims: Array<{ name: string; expected: unknown; actual: unknown }> = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  let status = "failed";
  let failure: string | undefined;
  let recording = false;
  let page: Page | undefined;
  try {
    page = await harness.launch();
    await page.setViewportSize({ width: 1280, height: 800 });
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      "Question history",
    );
    const threadId = await sendAgentPrompt(page, draft.projectSessionId, controlledPrompt);
    const panel = page.getByRole("group", { name: "Agent question" });
    await expect(panel).toBeVisible();
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1280, height: 800 },
        annotate: { position: "bottom", fontSize: 14 },
      });
      recording = true;
    }
    await panel.getByRole("radio", { name: "Project", exact: true }).click();
    await panel.getByLabel("Reply…").fill("Review name retained in history");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Answer question", exact: true })).toHaveCount(0);
    await fixture.command({ type: "start" });
    await fixture.command({
      type: "delta",
      delta: "\n\n## After the answers\n\nThe review continues after both replies.\n\n",
    });
    await fixture.command({ type: "complete" });
    const heading = page.getByRole("heading", { name: "After the answers", exact: true });
    await expect(heading).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    const assertQuestionOrder = async (stage: string) => {
      const source = page!
        .locator("[data-message-copy-root]")
        .filter({ hasText: "What should I call it?" })
        .filter({ hasNot: page!.locator('[data-user-message-bubble="true"]') });
      const reply = page!
        .locator('[data-user-message-bubble="true"]')
        .filter({ hasText: "Review name retained in history" });
      await expect(source).toHaveCount(1);
      await expect(reply).toHaveCount(1);
      const sourceHandle = await source.elementHandle();
      const replyHandle = await reply.elementHandle();
      if (!sourceHandle || !replyHandle)
        throw new Error("The question and its reply did not mount");
      claim(
        `${stage}: the original question precedes its answer`,
        true,
        await reply.evaluate(
          (element, source) =>
            Boolean(source.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
          sourceHandle,
        ),
      );
      claim(
        `${stage}: later Markdown follows the answer`,
        true,
        await heading.evaluate(
          (element, reply) =>
            Boolean(reply.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
          replyHandle,
        ),
      );
      claim(
        `${stage}: the Composer has no answered question`,
        0,
        await page!
          .locator("[data-thread-scroll-footer]")
          .getByText("What should I call it?", { exact: true })
          .count(),
      );
      await sourceHandle.dispose();
      await replyHandle.dispose();
    };
    await assertQuestionOrder("completed response");
    if (artifacts) {
      await settleFrames(page, 20);
      await page.screenshot({ path: path.join(artifacts, "final.png") });
    }
    if (recording) {
      await page.screencast.stop();
      recording = false;
    }
    await returnToThread(page, threadId, draft.projectSessionId);
    await assertQuestionOrder("Scene restore");
    await page.reload();
    await page.evaluate(() => window.api?.awaitInitialization?.());
    await expect(heading).toBeVisible();
    await assertQuestionOrder("application reload");
    status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await attachFailure(harness, page, testInfo);
    throw error;
  } finally {
    if (recording && page && !page.isClosed()) await page.screencast.stop();
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        path.join(artifacts, "result.json"),
        `${JSON.stringify({ status, fixture: "fresh Electron Profile; controlled Codex notifications through Agent Runtime", claims, failure }, null, 2)}\n`,
      );
      await writeFile(
        path.join(artifacts, "README.md"),
        `# Conversation question order\n\nStatus: **${status}**.\n\nThe native recording begins after the synthetic conversation has asked two optional questions. It shows both answers and the later Markdown response. Executable DOM-order assertions verify that the original question precedes its answer, the answer precedes later Markdown, and no answered question remains beside the Composer. Scene restoration and application reload repeat those assertions after the recording.\n\n- [review.webm](review.webm): native interaction recording.\n- [final.png](final.png): completed response.\n- [result.json](result.json): expected and actual values for each assertion.\n\nThe fixture uses a fresh disposable Profile and deterministic native notifications through the normal Electron/Main/Agent Runtime workflow. No production Profile or user content is included.\n${failure ? `\nFailure: ${failure}\n` : ""}`,
      );
    }
    await harness.close();
  }
});
