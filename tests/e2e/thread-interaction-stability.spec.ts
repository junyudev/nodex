import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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

async function frames(page: Page, count = 12) {
  await page.evaluate(async (count) => {
    for (let index = 0; index < count; index++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}

async function wheel(page: Page, viewport: Locator, deltaY: number) {
  const box = await viewport.boundingBox();
  if (!box) throw new Error("The thread viewport is not visible");
  // The right margin stays clear of the long-thread prompt rail and nested content.
  await page.mouse.move(box.x + box.width - 24, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
  await frames(page);
}

const response = (index: number) =>
  Array.from(
    { length: 5 },
    (_, paragraph) =>
      `Review ${index}, paragraph ${paragraph + 1}. ` +
      "The conversation preserves earlier requests while the reader inspects the latest result. ".repeat(
        4,
      ),
  ).join("\n\n");

test("editing an earlier message preserves its node, focus, selection and draft across virtualized history", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const harness = await ElectronScenarioHarness.create({
    label: "thread-interaction-stability",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_FINAL_REPLY_PATH: ".fake-codex/final.md",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "60",
      NODEX_FAKE_CODEX_APP_SERVER_VERSION: "0.162.0-alpha.17.2",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
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
  await writeFile(path.join(directory, "final.md"), response(0));
  const artifacts = process.env.NODEX_THREAD_INTERACTION_ARTIFACT_DIR;
  const claims: Array<{ name: string; expected: unknown; actual: unknown }> = [];
  const claim = (name: string, expected: unknown, actual: unknown) => {
    claims.push({ name, expected, actual });
    expect(actual, name).toEqual(expected);
  };
  let page: Page | undefined;
  let recording = false;
  let status = "failed";
  let failure: string | undefined;
  try {
    page = await harness.launch();
    await page.setViewportSize({ width: 1280, height: 800 });
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      "Thread editing",
    );
    const firstPrompt = "Review the first request";
    await sendAgentPrompt(page, draft.projectSessionId, firstPrompt);
    await expect(page.getByText("Review 0, paragraph 5.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    for (let index = 1; index < 16; index++) {
      await writeFile(path.join(directory, "final.md"), response(index));
      await sendAgentFollowUp(page, `Review request ${index}`);
      await expect(page.getByText(`Review ${index}, paragraph 5.`, { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    }
    const viewport = page.locator(
      `[data-workbench-scene-owner="session:${draft.projectSessionId}"] [data-local-conversation-thread-body="true"]`,
    );
    const first = viewport
      .locator('[data-user-message-bubble="true"]')
      .filter({ hasText: firstPrompt });
    await wheel(page, viewport, -100_000);
    await expect(first).toBeInViewport();
    await first.hover();
    const row = first.locator("xpath=ancestor::*[@data-turn-key][1]");
    const firstKey = await row.getAttribute("data-turn-key");
    if (!firstKey) throw new Error("The first message has no virtual row identity");
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page.screencast.start({
        path: path.join(artifacts, "review.webm"),
        size: { width: 1280, height: 800 },
        annotate: { position: "bottom", fontSize: 14 },
      });
      recording = true;
    }
    await row.getByRole("button", { name: "Edit message", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Edit message", exact: true });
    await editor.fill("Edited first request with a preserved selection");
    await editor.evaluate((element: HTMLTextAreaElement) =>
      element.setSelectionRange(7, 20, "backward"),
    );
    const identity = await editor.elementHandle();
    if (!identity) throw new Error("The message editor did not mount");
    await wheel(page, viewport, 100_000);
    await expect(viewport.getByText("Review 15, paragraph 5.", { exact: false })).toBeInViewport();
    const state = await identity.evaluate((element: HTMLTextAreaElement) => ({
      connected: element.isConnected,
      focused: element.ownerDocument.activeElement === element,
      value: element.value,
      selection: [element.selectionStart, element.selectionEnd, element.selectionDirection],
      offscreen:
        element.getBoundingClientRect().bottom <
        element.closest('[data-local-conversation-thread-body="true"]')!.getBoundingClientRect()
          .top,
    }));
    claim(
      "the offscreen editor remains connected and focused",
      [true, true, true],
      [state.connected, state.focused, state.offscreen],
    );
    claim(
      "the draft survives scrolling",
      "Edited first request with a preserved selection",
      state.value,
    );
    claim("the backward selection survives scrolling", [7, 20, "backward"], state.selection);
    const mounted = await viewport.locator("[data-turn-key]").count();
    claim("the list stays bounded instead of mounting intervening history", true, mounted < 20);
    await wheel(page, viewport, -100_000);
    await expect(editor).toBeInViewport();
    claim(
      "returning keeps the exact editor node",
      true,
      await editor.evaluate((element, original) => element === original, identity),
    );
    claim(
      "returning keeps the selection",
      [7, 20, "backward"],
      await editor.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
        element.selectionDirection,
      ]),
    );
    if (artifacts) await page.screenshot({ path: path.join(artifacts, "final.png") });
    if (recording) {
      await page.screencast.stop();
      recording = false;
    }
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await wheel(page, viewport, 100_000);
    await expect.poll(() => identity.evaluate((element) => element.isConnected)).toBe(false);
    await expect
      .poll(() =>
        viewport
          .locator("[data-turn-key]")
          .evaluateAll(
            (elements, key) =>
              elements.some((element) => element.getAttribute("data-turn-key") === key),
            firstKey,
          ),
      )
      .toBe(false);
    await identity.dispose();
    status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await testInfo.attach("runtime-logs", {
      body: await readBoundedElectronRuntimeLogs(harness.profile, 100_000),
      contentType: "text/plain",
    });
    if (page && !page.isClosed())
      await testInfo.attach("thread", { body: await page.screenshot(), contentType: "image/png" });
    throw error;
  } finally {
    if (recording && page && !page.isClosed()) await page.screencast.stop();
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        path.join(artifacts, "result.json"),
        `${JSON.stringify({ status, fixture: "sixteen actual chat Turns in a fresh disposable Electron Profile", claims, failure }, null, 2)}\n`,
      );
      await writeFile(
        path.join(artifacts, "README.md"),
        `# Editing across virtualized history\n\nStatus: **${status}**. The native recording starts after sixteen synthetic chat Turns have completed. It opens the first message, changes its draft and backward selection, scrolls to the latest message and returns. Executable assertions check the same textarea, focus, draft and selection, plus a bounded mounted row count. After recording, cancel releases the retained row.\n\n- [review.webm](review.webm)\n- [final.png](final.png)\n- [result.json](result.json)\n\nNo production Profile or user content is included.\n`,
      );
    }
    await harness.close();
  }
});
