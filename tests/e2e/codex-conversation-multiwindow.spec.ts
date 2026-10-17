import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { WindowSessionBootstrap } from "../../src/shared/window-session";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
  openNodexWindow,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import {
  createAgentSmokeDraft,
  invokeIpc,
  sendAgentPrompt,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";

const row = (page: Page, prompt: string) =>
  page.locator("[data-queued-follow-up-row]").filter({ hasText: prompt });
const bubble = (page: Page, prompt: string) =>
  page.locator("[data-user-message-bubble='true']").filter({ hasText: prompt });

test("two windows share an Agent chat's queue, Stop and Main commands, then continue after one closes", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "conversation-two-window-handoff",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "8000",
      NODEX_FAKE_CODEX_APP_SERVER_VERSION: "0.155.0-alpha.2.6",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  const readLog = () => {
    const logPath = path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl");
    if (!fs.existsSync(logPath)) return [];
    return fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params: {
              method?: string;
              params?: { threadId?: string };
              input?: Array<{ type: string; text?: string }>;
            };
          },
      );
  };
  const prompts = () =>
    readLog()
      .filter(
        (entry) =>
          entry.method === "turn/start" ||
          entry.method === "turn/steer" ||
          entry.method === "queue-turn/start",
      )
      .map((entry) => entry.params.input?.find((item) => item.type === "text")?.text ?? "");
  const steerCount = () => readLog().filter((entry) => entry.method === "turn/steer").length;
  const initialPrompt = "Keep this conversation active across both windows";
  const queuedPrompts = [
    "Send the shared queue head once",
    "Steer the shared queue once from both windows",
    "Continue the remaining server queue automatically",
  ];
  const mainPrompt = "Continue from the Main command ingress";
  const mainSteerPrompt = "Adjust the active Turn through the Main command";
  const handoffPrompt = "Continue from the surviving window";
  const rendererErrors: string[] = [];
  const pages: Page[] = [];
  let workflowFailure: unknown;
  const observe = (page: Page) => {
    pages.push(page);
    page.on("pageerror", (error) => rendererErrors.push(error.stack ?? error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        rendererErrors.push(message.text());
    });
  };
  try {
    const first = await harness.launch();
    observe(first);
    const draft = await createAgentSmokeDraft(
      first,
      harness.profile.initialProjectsDirectory,
      "Conversation peers",
    );
    const threadId = await sendAgentPrompt(first, draft.projectSessionId, initialPrompt);
    const target = { sessionId: draft.projectSessionId, threadId };
    // Main commands carry no renderer presentation or testing authority.
    const message = (page: Page, text: string, intent?: "steer") =>
      invokeIpc(page, "agent-runtime:session:message", {
        ...target,
        message: { messageId: createUuidV7(), text },
        ...(intent ? { intent } : {}),
      });
    await expect(first.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    const second = await openNodexWindow(harness.application, async () => {
      expect(
        await invokeIpc(first, "window:new", {
          activeProjectSessionId: draft.projectSessionId,
          activeProjectId: draft.projectId,
        }),
      ).toBe(true);
    });
    observe(second);
    const windows = await Promise.all(
      [first, second].map(
        async (page) =>
          ((await invokeIpc(page, "window-sessions:bootstrap")) as WindowSessionBootstrap).session,
      ),
    );
    expect(windows[0]!.id).not.toBe(windows[1]!.id);
    for (const window of windows)
      expect(window.layout.location).toMatchObject({
        kind: "session",
        sessionId: draft.projectSessionId,
      });
    await expect(bubble(second, initialPrompt)).toHaveCount(1);
    await expect(second.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

    await message(second, mainSteerPrompt, "steer");
    await expect.poll(prompts).toEqual([initialPrompt, mainSteerPrompt]);
    expect(steerCount()).toBe(1);
    for (const page of [first, second]) {
      await expect(bubble(page, mainSteerPrompt)).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    }

    const composer = second.locator(
      '[data-codex-composer="true"][aria-label="Ask for follow-up changes"]',
    );
    for (const prompt of queuedPrompts) {
      await expect(composer).toHaveAttribute("contenteditable", "true");
      await composer.fill(prompt);
      await composer.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
      await expect(row(first, prompt)).toBeVisible();
      await expect(row(second, prompt)).toBeVisible();
      await expect(composer).toHaveAttribute("contenteditable", "true");
      await expect(composer).toHaveText("");
    }
    await second.getByRole("button", { name: "Stop", exact: true }).click();
    for (const page of [first, second])
      await expect(
        page.getByText("Queue paused because you interrupted", { exact: true }),
      ).toBeVisible();
    await first
      .locator("#above-composer-queue-portal")
      .getByRole("button", { name: "Resume", exact: true })
      .click();
    for (const page of [first, second]) {
      await expect(row(page, queuedPrompts[0]!)).toHaveCount(0);
      await expect(bubble(page, queuedPrompts[0]!)).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expect(
        page.getByText("Queue paused because you interrupted", { exact: true }),
      ).toHaveCount(0);
    }

    // Both windows steer the same queued message into the running Turn; it is sent once.
    const steersBeforeConcurrentSend = steerCount();
    for (const page of [first, second])
      await expect(
        row(page, queuedPrompts[1]!).getByRole("button", {
          name: "Submit without interrupting the model",
        }),
      ).toBeEnabled();
    await Promise.all(
      [first, second].map((page) =>
        row(page, queuedPrompts[1]!)
          .getByRole("button", { name: "Submit without interrupting the model" })
          .evaluate((button) => {
            if (!button.isConnected)
              throw new Error("Concurrent queued submission lost its row before dispatch");
            (button as HTMLButtonElement).click();
          }),
      ),
    );
    await expect.poll(steerCount, { timeout: 30_000 }).toBe(steersBeforeConcurrentSend + 1);
    await expect
      .poll(prompts, { timeout: 30_000 })
      .toEqual([initialPrompt, mainSteerPrompt, ...queuedPrompts]);
    for (const page of [first, second]) {
      for (const prompt of queuedPrompts) {
        await expect(row(page, prompt)).toHaveCount(0);
        await expect(bubble(page, prompt)).toHaveCount(1);
      }
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, {
        timeout: 30_000,
      });
    }
    expect(steerCount()).toBe(steersBeforeConcurrentSend + 1);

    await message(second, mainPrompt);
    await waitForRuntimeCompletedAgentTurn(second, target, 30_000);
    for (const page of [first, second]) await expect(bubble(page, mainPrompt)).toHaveCount(1);
    expect(prompts()).toEqual([initialPrompt, mainSteerPrompt, ...queuedPrompts, mainPrompt]);

    await invokeIpc(second, "agent-runtime:session:compact", {
      ...target,
      requestId: createUuidV7(),
    });
    await expect
      .poll(() => readLog().filter((entry) => entry.method === "thread/compact/start").length)
      .toBe(1);
    for (const page of [first, second])
      await expect(page.getByText("Context automatically compacted", { exact: true })).toHaveCount(
        1,
      );

    const closed = first.waitForEvent("close");
    const ownerWindow = await harness.application.browserWindow(first);
    await ownerWindow.evaluate((window) => window.close());
    await closed;
    await composer.fill(handoffPrompt);
    await composer.press("Enter");
    await expect
      .poll(prompts, { timeout: 30_000 })
      .toEqual([initialPrompt, mainSteerPrompt, ...queuedPrompts, mainPrompt, handoffPrompt]);
    await waitForRuntimeCompletedAgentTurn(second, target, 30_000);
    await expect(bubble(second, handoffPrompt)).toHaveCount(1);
    await expect(second.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  } catch (error) {
    workflowFailure = error;
    await test.info().attach("workflow-failure.txt", {
      body: error instanceof Error ? (error.stack ?? error.message) : String(error),
      contentType: "text/plain",
    });
    await test.info().attach("native-requests.json", {
      body: JSON.stringify(readLog(), null, 2),
      contentType: "application/json",
    });
    await test.info().attach("runtime.log", {
      body: await readBoundedElectronRuntimeLogs(harness.profile),
      contentType: "text/plain",
    });
    const queues = await Promise.all(
      pages
        .filter((page) => !page.isClosed())
        .map(async (page) => ({
          url: page.url(),
          body: await page.locator("body").innerText(),
          main: await page
            .locator("[data-testid='session-thread-page']")
            .evaluateAll((nodes) => nodes.map((node) => node.outerHTML)),
          session: await invokeIpc(page, "window-sessions:bootstrap"),
          visible: await page.locator("[data-queued-follow-up-row]").allTextContents(),
        })),
    );
    await test.info().attach("renderer-errors.json", {
      body: JSON.stringify({ rendererErrors, queues }, null, 2),
      contentType: "application/json",
    });
    throw error;
  } finally {
    try {
      await harness.close();
    } catch (error) {
      if (!workflowFailure) throw error;
      throw new AggregateError(
        [workflowFailure, error],
        "Conversation workflow and cleanup failed",
        {
          cause: error,
        },
      );
    }
  }
});
