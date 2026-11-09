import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import {
  readRuntimeConversation,
  sendAgentPrompt,
  sendAgentFollowUp,
} from "./support/agent-smoke-harness";
import { invokeIpc } from "./support/editor-scenario";
import { openNewChatDraft } from "./support/new-chat-draft";

const controlledPrompt = "Review the Readback workflow";
const version = "0.162.0-alpha.17.2";
const records = (
  file: string,
): Array<{ method?: string; type?: string; params?: unknown; command?: unknown }> =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

const assistantMessage = (
  id: string,
  text: string,
  phase: "commentary" | "final_answer" | null,
): ThreadItem => ({
  type: "agentMessage",
  id,
  text,
  phase,
  delivery: null,
  memoryCitation: null,
  questions: null,
});

// All native output is gated by the test, while Main and Runtime use their real transports.
// The existing transcript peer emits typed items and holds the controlled Turn indefinitely.
test("Readbacks reach unseen chats, steer and stop their Run, open the chat and suppress seen chats", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const wireLog = testInfo.outputPath("runtime-wire.jsonl");
  const nodeLauncher = testInfo.outputPath("node-runtime");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.mkdirSync(path.dirname(nodeLauncher), { recursive: true });
  fs.writeFileSync(
    nodeLauncher,
    `#!/bin/sh\nexec ${quote(process.execPath)} --require ${quote(path.resolve("tests/e2e/fixtures/agent-runtime-wire-observer.cjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  const harness = await ElectronScenarioHarness.create({
    label: "readback-e2e",
    // Seen suppression and retaining the card after Stop require genuine window focus.
    windows: "foreground",
    prepareAgentRuntime: false,
    environment: {
      NODEX_LOG_FILE: "1",
      NODEX_LOG_FILE_LEVEL: "debug",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: nodeLauncher,
      NODEX_TEST_AGENT_RUNTIME_WIRE_LOG: wireLog,
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_COMMAND_PATH: ".fake-codex/commands.jsonl",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_FAKE_CODEX_BASE_FIXTURE: path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
      NODEX_FAKE_CODEX_CONTROLLED_PROMPT: controlledPrompt,
      NODEX_FAKE_CODEX_APP_SERVER_VERSION: version,
    },
  });
  const directory = path.join(harness.profile.runRoot, ".fake-codex");
  const nativeLog = path.join(directory, "requests.jsonl");
  const statePath = path.join(directory, "state.json");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      thread: null,
      turns: [],
      turnSequence: 0,
      queueSequence: 0,
      queuedSubmissions: [],
    }),
  );
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-transcript-performance-app-server.mjs"),
    version,
  );
  const command = (item: ThreadItem, completed = true) =>
    fs.appendFileSync(
      path.join(directory, "commands.jsonl"),
      `${JSON.stringify({ type: "item", item, completed })}\n`,
    );
  const emitOpening = (id: string, text: string, phase: "commentary" | null = "commentary") => {
    command(assistantMessage(`opening-${id}`, text, phase));
    command(
      {
        type: "commandExecution",
        id: `command-${id}`,
        command: "git status --short",
        cwd: harness.profile.projectsDirectory,
        pluginId: null,
        scriptPath: null,
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [{ type: "unknown", command: "git status --short" }],
        aggregatedOutput: "",
        exitCode: null,
        durationMs: null,
      },
      false,
    );
  };
  const complete = () => {
    command(assistantMessage("stream-target", "The workflow review is complete.", "final_answer"));
    fs.appendFileSync(
      path.join(directory, "commands.jsonl"),
      `${JSON.stringify({ type: "complete" })}\n`,
    );
  };
  let page: Page | undefined;
  try {
    page = await harness.launch();
    await page.setViewportSize({ width: 1280, height: 800 });
    await invokeIpc(page, "agent-runtime:providers:read", { refresh: true });
    const scene = await openNewChatDraft(page);
    const owner = await scene.getAttribute("data-workbench-scene-owner");
    const sessionId = owner?.slice("session:".length);
    if (!sessionId) throw new Error("Readback chat has no Session identity");
    const threadId = await sendAgentPrompt(page, sessionId, `${controlledPrompt}: reply`);
    const target = { sessionId, threadId };
    const conversation = () => readRuntimeConversation(page!, target);
    const activeRun = async () => (await conversation()).snapshot.projection.runs.at(-1);
    const nativeTurn = () =>
      JSON.parse(fs.readFileSync(statePath, "utf8")).controlledTurnId as string;
    const row = page.locator(
      `[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id="${threadId}"]`,
    );
    const stack = page.locator('section[aria-label="Readbacks"]');
    const title = (await invokeIpc(page, "project-sessions:get", sessionId))?.displayTitle;
    if (!title) throw new Error("Readback chat has no title");
    const card = stack.getByRole("article", { name: `${title}: readback`, exact: true });
    const hoverReadback = page.locator("[data-app-action-sidebar-thread-hover-card-readback]");
    const awaitWorking = async (turnCount: number) => {
      await expect
        .poll(() => records(nativeLog).filter((entry) => entry.method === "turn/start").length)
        .toBe(turnCount);
      await expect.poll(async () => (await activeRun())?.status).toBe("running");
      await expect.poll(() => nativeTurn()).toBe(`turn-queue-parity-${turnCount}`);
    };
    const awaitFocused = () =>
      expect.poll(() => invokeIpc(page!, "electron-window:focus:get")).toBe(true);

    await test.step("an unseen chat's opening appears in its Readback and sidebar hover card", async () => {
      await awaitWorking(1);
      const elsewhere = await openNewChatDraft(page!);
      await expect(scene).not.toBeVisible();
      await awaitFocused();
      emitOpening("reply", "I will review the notification workflow before changing anything.");
      await expect(card).toBeVisible();
      await card.hover();
      await expect(
        card.getByText("I will review the notification workflow before changing anything.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(card.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await row.hover();
      await expect(hoverReadback).toHaveText(
        "I will review the notification workflow before changing anything.",
      );
      await expect(hoverReadback).toBeVisible();
      await expect(elsewhere).toBeVisible();
    });

    await test.step("Reply steers the same working Run with auto intent and confirms Sent", async () => {
      const runId = (await activeRun())!.id;
      const turnId = nativeTurn();
      await card.hover();
      await card.getByRole("button", { name: "Reply", exact: true }).click();
      const reply = card.getByRole("textbox", { name: "Reply", exact: true });
      await expect(reply).toBeFocused();
      await reply.fill("Only review notification delivery; leave the editor alone.");
      await reply.press("Enter");
      await expect(card.getByText("Sent", { exact: true })).toBeVisible();
      await expect
        .poll(() => records(nativeLog).filter((entry) => entry.method === "turn/steer"))
        .toEqual([
          expect.objectContaining({
            params: expect.objectContaining({
              threadId: expect.any(String),
              expectedTurnId: turnId,
              input: expect.arrayContaining([
                expect.objectContaining({
                  type: "text",
                  text: expect.stringContaining(
                    "Only review notification delivery; leave the editor alone.",
                  ),
                }),
              ]),
            }),
          }),
        ]);
      expect(records(wireLog).filter((entry) => entry.type === "message.dispatch")).toContainEqual(
        expect.objectContaining({
          command: expect.objectContaining({
            threadId,
            text: "Only review notification delivery; leave the editor alone.",
            deliveryIntent: "auto",
          }),
        }),
      );
      expect((await activeRun())?.id).toBe(runId);
      expect((await activeRun())?.status).toBe("running");
      expect(records(nativeLog).filter((entry) => entry.method === "turn/start")).toHaveLength(1);
      expect(records(nativeLog).filter((entry) => entry.method === "turn/interrupt")).toHaveLength(
        0,
      );
      await expect(card).toHaveCount(0);
      await expect(scene).not.toBeVisible();
      complete();
      await expect.poll(async () => (await activeRun())?.status).toBe("completed");
    });

    await test.step("Stop interrupts the card's exact Run; its title opens the chat and withdraws it", async () => {
      await row.click();
      await expect(scene).toBeVisible();
      await sendAgentFollowUp(page!, `${controlledPrompt}: stop`);
      await awaitWorking(2);
      const runId = (await activeRun())!.id;
      const turnId = nativeTurn();
      await openNewChatDraft(page!);
      await expect(scene).not.toBeVisible();
      await awaitFocused();
      // Without a provider phase, the following action establishes that this is commentary.
      emitOpening("stop", "I will check the chat delivery controls next.", null);
      await expect(card).toBeVisible();
      await card.hover();
      await expect(
        card.getByText("I will check the chat delivery controls next.", { exact: true }),
      ).toBeVisible();
      await card.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(card.getByRole("textbox", { name: "Reply", exact: true })).toBeVisible();
      await expect
        .poll(async () => ({ id: (await activeRun())?.id, status: (await activeRun())?.status }))
        .toEqual({ id: runId, status: "interrupted" });
      const nativeThreadId = (
        records(nativeLog).find((entry) => entry.method === "turn/start")?.params as {
          threadId: string;
        }
      ).threadId;
      expect(records(nativeLog).filter((entry) => entry.method === "turn/interrupt")).toEqual([
        expect.objectContaining({ params: { threadId: nativeThreadId, turnId } }),
      ]);
      await expect(card.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await expect(scene).not.toBeVisible();
      await card.getByRole("button", { name: title, exact: true }).click();
      await expect(scene).toBeVisible();
      await expect(scene.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await expect(card).toHaveCount(0);
    });

    await test.step("watching the chat suppresses the card while retaining its sidebar readback", async () => {
      await sendAgentFollowUp(page!, `${controlledPrompt}: stay`);
      await awaitWorking(3);
      await expect(scene).toBeVisible();
      await awaitFocused();
      emitOpening("seen", "I will verify the foreground chat stays quiet.");
      await expect
        .poll(
          async () =>
            (await invokeIpc(page!, "agent-runtime:activity:read")).items.find(
              (activity) => activity.sessionId === sessionId,
            )?.readback?.text,
        )
        .toBe("I will verify the foreground chat stays quiet.");
      await row.hover();
      await expect(hoverReadback).toHaveText("I will verify the foreground chat stays quiet.");
      await expect(hoverReadback).toBeVisible();
      await expect(stack).toHaveCount(0);
      // Navigate only after the opening has arrived; it must not become a delayed card.
      await openNewChatDraft(page!);
      await expect(scene).not.toBeVisible();
      complete();
      await expect.poll(async () => (await activeRun())?.status).toBe("completed");
      await expect(stack).toHaveCount(0);
      expect(records(nativeLog).filter((entry) => entry.method === "turn/start")).toHaveLength(3);
      expect(records(nativeLog).filter((entry) => entry.method === "turn/interrupt")).toHaveLength(
        1,
      );
    });
  } catch (error) {
    if (page && !page.isClosed())
      await testInfo.attach("readback-window", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    throw error;
  } finally {
    await testInfo.attach("runtime-logs", {
      body: await readBoundedElectronRuntimeLogs(harness.profile, 250_000),
      contentType: "text/plain",
    });
    for (const [name, file] of [
      ["native-requests", nativeLog],
      ["runtime-wire", wireLog],
      ["native-state", statePath],
    ]) {
      if (file && fs.existsSync(file))
        await testInfo.attach(name!, { body: fs.readFileSync(file), contentType: "text/plain" });
    }
    await harness.close();
  }
});
