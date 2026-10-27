import { expect, test, type Page } from "@playwright/test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import { createAgentSmokeDraft, sendAgentPrompt } from "./support/agent-smoke-harness";

const prompt = "Review the protected files";
const paragraphs = (prefix: string, count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `${prefix} ${index + 1}. The review records each command and its output so a reader can inspect the work before continuing.`,
  ).join("\n\n");

test("a collapsed Turn's denied-action count opens and centers its first refusal", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const harness = await ElectronScenarioHarness.create({
    label: "denied-action-navigation",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_COMMAND_PATH: ".fake-codex/commands.jsonl",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_BASE_FIXTURE: path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_CONTROLLED_PROMPT: prompt,
      NODEX_FAKE_CODEX_APP_SERVER_VERSION: "0.162.0-alpha.17.2",
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
  const command = (
    value:
      | { type: "start" | "complete" }
      | { type: "delta"; delta: string }
      | { type: "item"; item: ThreadItem }
      | { type: "denied"; reviewId: string; command: string; targetItemId?: string; cwd: string },
  ) => appendFile(path.join(directory, "commands.jsonl"), `${JSON.stringify(value)}\n`);
  const execution = (
    id: string,
    text: string,
    status: "completed" | "declined" = "completed",
  ): Extract<ThreadItem, { type: "commandExecution" }> => ({
    type: "commandExecution",
    id,
    command: text,
    cwd: harness.profile.initialProjectsDirectory,
    pluginId: null,
    scriptPath: null,
    processId: null,
    source: "agent",
    status,
    commandActions: [{ type: "unknown", command: text }],
    aggregatedOutput: paragraphs(`${id} output`, 3),
    exitCode: status === "declined" ? null : 0,
    durationMs: 20,
  });
  const appendWork = async (start: number, count: number) => {
    for (let index = start; index < start + count; index++) {
      await command({
        type: "item",
        item: execution(`review-command-${index}`, `printf 'review-${index}'`),
      });
      await command({
        type: "item",
        item: {
          type: "agentMessage",
          id: `review-progress-${index}`,
          phase: "commentary",
          text: `Review step ${index + 1} is complete.`,
          delivery: null,
          memoryCitation: null,
          questions: null,
        },
      });
    }
  };
  let page: Page | undefined;
  try {
    page = await harness.launch();
    await page.setViewportSize({ width: 1100, height: 800 });
    const draft = await createAgentSmokeDraft(
      page,
      harness.profile.initialProjectsDirectory,
      "Denied action review",
    );
    await sendAgentPrompt(page, draft.projectSessionId, prompt);
    await appendWork(0, 12);
    const declined = execution("first-denied-command", "touch protected-first.txt", "declined");
    await command({ type: "item", item: declined });
    await command({
      type: "denied",
      reviewId: "first-denial",
      targetItemId: declined.id,
      command: declined.command,
      cwd: harness.profile.initialProjectsDirectory,
    });
    await appendWork(12, 12);
    await command({
      type: "denied",
      reviewId: "second-denial",
      command: "touch protected-second.txt",
      cwd: harness.profile.initialProjectsDirectory,
    });
    await command({ type: "start" });
    await command({ type: "delta", delta: `${paragraphs("Completed review", 12)}\n\n` });
    await command({ type: "complete" });
    await expect(page.getByText("Completed review 12.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    const viewport = page.locator(
      `[data-workbench-scene-owner="session:${draft.projectSessionId}"] [data-local-conversation-thread-body="true"]`,
    );
    const count = viewport.getByRole("button", { name: "View 2 denied actions", exact: true });
    await expect(count).toHaveText("2 denied actions");
    const toggle = viewport.locator('[data-agent-body-toggle="true"]');
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(viewport.locator("[data-auto-review-denied]")).toHaveCount(0);
    await count.focus();
    await count.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const firstDenied = viewport.locator("[data-auto-review-denied]").first();
    await expect(viewport.locator("[data-auto-review-denied]")).toHaveCount(2);
    await expect(firstDenied).toContainText("touch protected-first.txt");
    const geometry = () =>
      viewport.evaluate((element) => {
        const target = element.querySelector<HTMLElement>("[data-auto-review-denied]");
        if (!target) throw new Error("The denied action did not mount");
        const viewportBoundsTop = element.getBoundingClientRect().top + element.clientTop;
        const style = getComputedStyle(element);
        const scrollPaddingTop = Number.parseFloat(style.scrollPaddingTop) || 0;
        const scrollPaddingBottom = Number.parseFloat(style.scrollPaddingBottom) || 0;
        const viewportTop = viewportBoundsTop + scrollPaddingTop;
        const viewportBottom = viewportBoundsTop + element.clientHeight - scrollPaddingBottom;
        const bounds = target.getBoundingClientRect();
        const targetCenter = (bounds.top + bounds.bottom) / 2;
        const viewportCenter = (viewportTop + viewportBottom) / 2;
        const maxScrollTop = element.scrollHeight - element.clientHeight;
        const expectedScrollTop = Math.max(
          0,
          Math.min(maxScrollTop, element.scrollTop + targetCenter - viewportCenter),
        );
        return {
          actualScrollTop: element.scrollTop,
          expectedScrollTop,
          targetTop: bounds.top,
          targetBottom: bounds.bottom,
          viewportTop,
          viewportBottom,
          scrollPaddingTop,
          scrollPaddingBottom,
          maxScrollTop,
        };
      });
    await expect
      .poll(async () => {
        const value = await geometry();
        return Math.abs(value.actualScrollTop - value.expectedScrollTop);
      })
      .toBeLessThanOrEqual(3);
    const settled = await geometry();
    expect(settled.targetTop).toBeGreaterThanOrEqual(settled.viewportTop - 1);
    expect(settled.targetBottom).toBeLessThanOrEqual(settled.viewportBottom + 1);
    await testInfo.attach("denied-action-placement", {
      body: JSON.stringify(settled, null, 2),
      contentType: "application/json",
    });
  } catch (error) {
    await testInfo.attach("runtime-logs", {
      body: await readBoundedElectronRuntimeLogs(harness.profile, 300_000),
      contentType: "text/plain",
    });
    if (page && !page.isClosed())
      await testInfo.attach("conversation", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    throw error;
  } finally {
    await harness.close();
  }
});
