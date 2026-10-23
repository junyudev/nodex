import { expect, test, type Page } from "@playwright/test";
import { openWorkbenchSettings } from "./support/workbench-settings";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";
import {
  responses,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import type { IpcApi } from "../../src/shared/ipc-api";
import type { NativeConversationImportResult } from "../../src/shared/native-session-catalog";
import { createCodexThreadImportFixtureClient } from "./support/codex-thread-import-fixture";
import { resolveNativeVisualizationFixtureRuntime } from "./support/native-visualization-history-fixture";
import {
  readRuntimeConversation,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";

const invoke = <Channel extends keyof IpcApi>(
  page: Page,
  channel: Channel,
  ...args: IpcApi[Channel]["args"]
): Promise<IpcApi[Channel]["result"]> =>
  page.evaluate(
    async ({ channel, args }) => {
      const bridge = window.api as unknown as {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      };
      return await bridge.invoke(channel, ...args);
    },
    { channel, args: args as unknown as unknown[] },
  ) as Promise<IpcApi[Channel]["result"]>;

const nativeRequests = (
  file: string,
): Array<{ method: string; params?: Record<string, unknown> }> =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

const importedHistory = async (
  page: Page,
  { sessionId, threadId }: NativeConversationImportResult,
) => {
  const target = { sessionId, threadId };
  const conversation = await readRuntimeConversation(page, target);
  const items = new Map<string, AgentTurnItem>();
  for (const row of conversation.snapshot.projection.visibleTurnItems)
    items.set(row.item.id, row.item);
  let cursor = conversation.snapshot.historyCursor ?? null;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (seen.has(cursor) || seen.size >= 10) throw new Error("Imported history did not converge");
    seen.add(cursor);
    const older = await invoke(page, "agent-runtime:session:history", { ...target, cursor });
    for (const row of older.items) items.set(row.item.id, row.item);
    cursor = older.nextCursor;
  }
  return [...items.values()].sort((left, right) => left.ordinal - right.ordinal);
};

const expectMissingImageRecords = async (page: Page, names: readonly string[]) => {
  for (const group of await page.getByTestId("agent-activity-group-body").all()) {
    if ((await group.getAttribute("aria-hidden")) === "true")
      await group.locator("..").getByRole("button").first().click();
  }
  const inspected = page.getByRole("button", {
    name: "Viewed an image · file missing",
    exact: true,
  });
  await inspected.scrollIntoViewIfNeeded();
  if ((await inspected.getAttribute("aria-expanded")) !== "true") await inspected.click();
  for (const name of names) {
    const record = page.getByRole("img", { name: `${name}, file missing`, exact: true });
    await record.scrollIntoViewIfNeeded();
    await expect(record).toBeVisible();
  }
};

test("imports a Codex link as independent history and continues after its source is deleted and Nodex restarts", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const token = randomUUID();
  const title = `Imported Codex ${token}`;
  const ancestorPrompt = `Remember ancestor ${token}`;
  const ancestorReply = `Ancestor retained ${token}`;
  const sourcePrompt = `Continue the native fork ${token}`;
  const sourceReply = `Fork history retained ${token}`;
  const nextPrompt = `Continue the imported chat ${token}`;
  const nextReply = `Independent imported chat continued ${token}`;
  const imageViewCallId = `source_image_${token}`;
  const userImageName = "user-image.png";
  const viewedImageName = "viewed-image.png";
  const assistantImageName = "assistant-image.png";
  let sourceImagePath = "";
  let assistantImagePath = "";
  const sourceAssistantText = () =>
    `${sourceReply}\n\n![Historical assistant image](${assistantImagePath})`;
  const details = Array.from({ length: 51 }, (_, index) => `Historical detail ${index}`);
  const runtime = await resolveNativeVisualizationFixtureRuntime(process.cwd());

  await withScriptedModelServer(
    {
      maximumTranscriptCharacters: 6000,
      exchanges: [
        {
          name: "native ancestor with a full history page",
          match: (request) => request.hasUserInputText(ancestorPrompt),
          respond: responses.stream([
            responses.created(`ancestor_${token}`),
            ...details.map((text, index) =>
              responses.assistantMessage(`detail_${index}_${token}`, text, "commentary"),
            ),
            responses.assistantMessage(`ancestor_answer_${token}`, ancestorReply, "final_answer"),
            responses.completed(`ancestor_${token}`, true),
          ]),
        },
        {
          name: "native fork inherits its ancestor",
          match: (request) =>
            request.hasUserInputText(sourcePrompt) && !request.hasToolCallOutput(imageViewCallId),
          respond: (request) => {
            expect(request.hasInputText(ancestorPrompt)).toBe(true);
            expect(request.hasInputText(ancestorReply)).toBe(true);
            const direct = request.namedTool("view_image");
            const invocation = request.toolInvocation("functions", "exec");
            if (!direct && !invocation)
              throw new Error(`Native fixture has no image viewer: ${request.diagnosticSummary()}`);
            return responses.stream([
              responses.created(`source_image_${token}`),
              direct
                ? responses.functionCall(imageViewCallId, "view_image", { path: sourceImagePath })
                : responses.customToolCall(
                    imageViewCallId,
                    invocation!.name,
                    `const result = await tools.view_image({ path: ${JSON.stringify(sourceImagePath)} }); image(result.image_url);`,
                    invocation!.namespace,
                  ),
              responses.completed(`source_image_${token}`),
            ]);
          },
        },
        {
          name: "native fork finishes after viewing the local image",
          match: (request) => request.hasToolCallOutput(imageViewCallId),
          respond: () => {
            return responses.stream([
              responses.created(`source_${token}`),
              responses.assistantMessage(
                `source_answer_${token}`,
                sourceAssistantText(),
                "final_answer",
              ),
              responses.completed(`source_${token}`, true),
            ]);
          },
        },
        {
          name: "new native conversation receives the imported history after restart",
          match: (request) => request.hasUserInputText(nextPrompt),
          respond: (request) => {
            for (const retained of [ancestorPrompt, ancestorReply, sourcePrompt, sourceReply])
              expect(request.hasInputText(retained), `Missing imported context: ${retained}`).toBe(
                true,
              );
            for (const name of [userImageName, viewedImageName, assistantImageName])
              expect(
                request.hasInputText(
                  `[Image unavailable: ${name}; original source file is missing.]`,
                ),
                `Missing unavailable-image context: ${name}`,
              ).toBe(true);
            return responses.stream([
              responses.created(`continued_${token}`),
              responses.assistantMessage(`continued_answer_${token}`, nextReply, "final_answer"),
              responses.completed(`continued_${token}`, true),
            ]);
          },
        },
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "codex-thread-import",
        prepareAgentRuntime: false,
        retention: process.env.NODEX_KEEP_SCENARIO_PROFILES === "1" ? "keep" : "dispose",
        environment: {
          ...modelServer.loopbackEnvironment(),
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
          NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
          NODEX_TEST_IMPORT_NATIVE_EXECUTABLE: runtime.executable,
          NODEX_TEST_IMPORT_NATIVE_LOG: ".native-import-requests.jsonl",
          NODEX_LOG_FILE: "1",
          NODEX_LOG_FILE_LEVEL: "debug",
        },
      });
      const originalCwd = path.join(harness.profile.runRoot, "original-workspace");
      const replacementCwd = fs.realpathSync(harness.profile.initialProjectsDirectory);
      const log = path.join(harness.profile.runRoot, ".native-import-requests.jsonl");
      // Both native consumers get one absolute observer ledger despite different execution cwd.
      const proxy = path.join(harness.profile.runRoot, "codex-native-observer.mjs");
      const body = fs
        .readFileSync(path.resolve("tests/e2e/fixtures/codex-import-native-observer.mjs"), "utf8")
        .replace(
          "const log = process.env.NODEX_TEST_IMPORT_NATIVE_LOG;",
          `const log = ${JSON.stringify(log)};`,
        );
      fs.writeFileSync(proxy, body, { mode: 0o755 });
      prepareScenarioCodexAppServerRuntimeSync(harness.profile.runRoot, proxy, runtime.version);
      fs.mkdirSync(originalCwd);
      sourceImagePath = path.join(originalCwd, viewedImageName);
      const userImagePath = path.join(originalCwd, userImageName);
      assistantImagePath = path.join(originalCwd, assistantImageName);
      const imageBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      for (const file of [sourceImagePath, userImagePath, assistantImagePath])
        fs.writeFileSync(file, imageBytes);
      fs.writeFileSync(
        path.join(harness.profile.codexHome, "config.toml"),
        `
model_provider = "openai"
openai_base_url = ${JSON.stringify(`${modelServer.baseUrl}/v1`)}
request_max_retries = 0
stream_max_retries = 0
[features]
respect_system_proxy = false
`,
        { mode: 0o600 },
      );
      const nativeInput = {
        executable: runtime.executable,
        codexHome: harness.profile.codexHome,
        cwd: replacementCwd,
        environment: {
          ...modelServer.loopbackEnvironment(),
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
        },
      };
      try {
        const source = await createCodexThreadImportFixtureClient(nativeInput);
        let sourceId: string;
        let ancestorId: string;
        let sourceRollout: string;
        try {
          const ancestor = (
            await source.call("thread/start", {
              cwd: originalCwd,
              model: "gpt-5.5",
              ephemeral: false,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
              historyMode: "paginated",
              threadSource: "external_import_fixture",
            })
          ).thread;
          ancestorId = ancestor.id;
          const ancestorTurn = (
            await source.call("turn/start", {
              threadId: ancestor.id,
              input: [{ type: "text", text: ancestorPrompt, text_elements: [] }],
            })
          ).turn;
          expect((await source.waitForTurn(ancestorTurn.id)).status).toBe("completed");
          const fork = (
            await source.call("thread/fork", {
              threadId: ancestor.id,
              cwd: originalCwd,
              model: "gpt-5.5",
              approvalPolicy: "never",
              sandbox: "danger-full-access",
              excludeTurns: true,
              threadSource: "external_import_fixture",
            })
          ).thread;
          sourceId = fork.id;
          expect(fork.forkedFromId).toBe(ancestor.id);
          expect(fork.parentThreadId).toBeNull();
          await source.call("thread/name/set", { threadId: sourceId, name: title });
          const forkTurn = (
            await source.call("turn/start", {
              threadId: sourceId,
              input: [
                { type: "text", text: sourcePrompt, text_elements: [] },
                { type: "localImage", path: userImagePath },
              ],
            })
          ).turn;
          expect((await source.waitForTurn(forkTurn.id)).status).toBe("completed");
          const nativePage = await source.call("thread/items/list", {
            threadId: sourceId,
            limit: 50,
            sortDirection: "asc",
          });
          expect(nativePage.data).toHaveLength(50);
          expect(nativePage.nextCursor).not.toBeNull();
          const mediaPage = await source.call("thread/items/list", {
            threadId: sourceId,
            turnId: forkTurn.id,
            limit: 100,
            sortDirection: "asc",
          });
          expect(
            mediaPage.data.flatMap((entry) =>
              entry.item.type === "userMessage" ? entry.item.content : [],
            ),
          ).toContainEqual(expect.objectContaining({ type: "localImage", path: userImagePath }));
          expect(
            mediaPage.data.find((entry) => entry.item.type === "imageView")?.item,
          ).toMatchObject({ type: "imageView", path: sourceImagePath });
          const metadata = (
            await source.call("thread/read", { threadId: sourceId, includeTurns: false })
          ).thread;
          if (!metadata.path) throw new Error("Native source has no durable rollout");
          sourceRollout = metadata.path;
        } finally {
          await source.close();
        }
        const originalHistory = fs.readFileSync(sourceRollout);
        fs.rmSync(originalCwd, { recursive: true });
        expect(fs.existsSync(sourceImagePath)).toBe(false);
        expect(fs.existsSync(userImagePath)).toBe(false);
        expect(fs.existsSync(assistantImagePath)).toBe(false);
        const requestsBeforeImport = modelServer.requests().length;
        let page = await harness.launch();
        await openWorkbenchSettings(page);
        await page.getByRole("link", { name: "Conversations", exact: true }).click();
        await page
          .getByRole("textbox", { name: "Conversation link or ID", exact: true })
          .fill(`codex://threads/${sourceId}`);
        const form = page.getByRole("group", { name: title, exact: true });
        const selection = page.getByRole("group", { name: "Import selection", exact: true });
        await expect(form).toBeVisible();
        await expect(form.getByText("Folder missing", { exact: true })).toBeVisible();
        await expect(
          selection.getByRole("button", { name: "Import and open", exact: true }),
        ).toBeDisabled();
        const dismissNotification = page.getByRole("button", { name: "Dismiss notification" });
        if (await dismissNotification.count()) await dismissNotification.first().click();
        await page.screenshot({ path: testInfo.outputPath("codex-import-missing-cwd.png") });
        await selection.getByRole("button", { name: "Import destination", exact: true }).click();
        await page.getByRole("option", { name: "Projectless", exact: true }).click();
        await harness.application.evaluate(({ dialog }, selectedPath) => {
          const original = dialog.showOpenDialog;
          dialog.showOpenDialog = async () => {
            dialog.showOpenDialog = original;
            return { canceled: false, filePaths: [selectedPath], bookmarks: [] };
          };
        }, replacementCwd);
        await form.getByRole("button", { name: "Choose folder", exact: true }).click();
        await expect(form.getByText(replacementCwd, { exact: true })).toBeVisible();
        await selection.getByRole("button", { name: "Import and open", exact: true }).click();
        await expect(page.getByText(sourceReply, { exact: true }).last()).toBeVisible({
          timeout: 30_000,
        });
        await expect(page.locator('[data-codex-composer="true"]').first()).toBeEditable();
        const tasks = await invoke(page, "workspace:tasks:list", null, { first: 50 });
        const admitted = tasks.items.find(
          (entry) => entry.displayTitle === title && entry.executionRef,
        );
        if (!admitted?.executionRef)
          throw new Error("Imported conversation has no Runtime binding");
        const imported = {
          sessionId: admitted.id,
          threadId: admitted.executionRef.threadId,
          projectId: null,
        };
        await expect(
          page.locator(`[data-app-action-sidebar-thread-id="${imported.threadId}"]`),
        ).toBeVisible();
        expect(imported.threadId).not.toBe(sourceId);
        const previews = await invoke(page, "native-sessions:preview-import", {
          reference: sourceId,
          backendKind: "codex",
        });
        const preview = previews.matches[0];
        if (!preview) throw new Error("Imported source is missing from preview");
        expect(preview.cwdAvailable).toBe(false);
        const retryInput = {
          backendKind: "codex" as const,
          requestId: imported.sessionId,
          acceptedAt: Date.now(),
          nativeSessionId: sourceId,
          expectedHome: preview.nativeHome,
          projectId: null,
          cwd: replacementCwd,
        };
        expect(await invoke(page, "native-sessions:import", retryInput)).toEqual({
          kind: "imported",
          ...imported,
        });
        const history = await importedHistory(page, imported);
        await testInfo.attach("codex-import-history.json", {
          body: JSON.stringify(history, null, 2),
          contentType: "application/json",
        });
        expect(
          history.filter((item) => item.type === "user_message").map((item) => item.text),
        ).toEqual([ancestorPrompt, sourcePrompt]);
        expect(
          history.filter((item) => item.type === "assistant_message").map((item) => item.text),
        ).toEqual([...details, ancestorReply, sourceAssistantText()]);
        const importedAssistant = history.find(
          (item) => item.type === "assistant_message" && item.text === sourceAssistantText(),
        );
        expect(importedAssistant?.unavailableImages).toEqual([
          { name: assistantImageName, sourcePath: assistantImagePath, reason: "source_missing" },
        ]);
        if (importedAssistant?.type !== "assistant_message")
          throw new Error("Imported image-bearing assistant message is missing");
        expect(importedAssistant.importedImageLinks).toEqual([
          { sourcePath: assistantImagePath, attachmentId: null },
        ]);
        const importedUser = history.find(
          (item) => item.type === "user_message" && item.text === sourcePrompt,
        );
        expect(importedUser?.unavailableImages).toEqual([
          { name: userImageName, sourcePath: userImagePath, reason: "source_missing" },
        ]);
        if (importedUser?.type !== "user_message")
          throw new Error("Imported image-bearing user message is missing");
        expect(importedUser.attachments).toEqual([]);
        const importedImageView = history.find(
          (item) => item.type === "dynamic_tool" && item.toolName === "imageView",
        );
        expect(importedImageView?.unavailableImages).toEqual([
          { name: viewedImageName, sourcePath: sourceImagePath, reason: "source_missing" },
        ]);
        if (importedImageView?.type !== "dynamic_tool")
          throw new Error("Imported native image view is missing");
        expect(importedImageView.attachments ?? []).toEqual([]);
        await expectMissingImageRecords(page, [userImageName, viewedImageName, assistantImageName]);
        if (await dismissNotification.count()) await dismissNotification.first().click();
        await page.screenshot({ path: testInfo.outputPath("codex-import-chat.png") });
        expect(
          (
            await readRuntimeConversation(page, {
              sessionId: imported.sessionId,
              threadId: imported.threadId,
            })
          ).snapshot.projection.runs,
        ).toEqual([]);
        expect(fs.readFileSync(sourceRollout)).toEqual(originalHistory);
        expect(modelServer.requests()).toHaveLength(requestsBeforeImport);
        expect(nativeRequests(log).filter((request) => request.method === "thread/fork")).toEqual(
          [],
        );

        const remover = await createCodexThreadImportFixtureClient(nativeInput);
        try {
          for (const threadId of [sourceId, ancestorId]) {
            await remover.call("thread/archive", { threadId });
            await remover.call("thread/delete", { threadId });
            await expect(
              remover.call("thread/read", { threadId, includeTurns: false }),
            ).rejects.toThrow();
          }
        } finally {
          await remover.close();
        }
        expect(fs.existsSync(sourceRollout)).toBe(false);
        const sourceReadsBeforeRetry = nativeRequests(log).filter(
          (request) => request.params?.threadId === sourceId,
        ).length;
        expect(await invoke(page, "native-sessions:import", retryInput)).toEqual({
          kind: "imported",
          ...imported,
        });
        page = await harness.restart();
        expect(await importedHistory(page, imported)).toEqual(history);
        await expect(page.getByText(sourceReply, { exact: true }).last()).toBeVisible({
          timeout: 30_000,
        });
        await expectMissingImageRecords(page, [userImageName, viewedImageName, assistantImageName]);
        const composer = page.locator('[data-codex-composer="true"]').first();
        await expect(composer).toBeEditable();
        await composer.fill(nextPrompt);
        await composer.press("Enter");
        await expect(page.getByText(nextReply, { exact: true }).last()).toBeVisible({
          timeout: 30_000,
        });
        const continued = await waitForRuntimeCompletedAgentTurn(page, {
          sessionId: imported.sessionId,
          threadId: imported.threadId,
        });
        expect(continued.snapshot.projection.runs).toHaveLength(1);
        const nativeRun = continued.snapshot.projection.providerThreads.find(
          (entry) => entry.nativeThreadRef !== null,
        );
        expect(nativeRun?.nativeThreadRef?.nativeId).toBeTruthy();
        expect([sourceId, ancestorId]).not.toContain(nativeRun?.nativeThreadRef?.nativeId);
        const requests = nativeRequests(log);
        expect(requests.filter((request) => request.params?.threadId === sourceId)).toHaveLength(
          sourceReadsBeforeRetry,
        );
        expect(
          requests.filter(
            (request) =>
              request.method === "thread/items/list" && request.params?.threadId === sourceId,
          ).length,
        ).toBeGreaterThanOrEqual(2);
        expect(
          requests.filter(
            (request) =>
              [sourceId, ancestorId].includes(String(request.params?.threadId)) &&
              ![
                "thread/read",
                "thread/turns/list",
                "thread/items/list",
                "thread/timeline/list",
              ].includes(request.method),
          ),
        ).toEqual([]);
        expect(
          requests.filter(
            (request) =>
              request.method === "turn/start" &&
              request.params?.threadId === nativeRun?.nativeThreadRef?.nativeId,
          ),
        ).toHaveLength(1);
        expect(continued.snapshot.projection.thread.worktreePath).toBe(replacementCwd);
        expect(
          (await invoke(page, "project-sessions:get", imported.sessionId))?.executionRef,
        ).toEqual(admitted.executionRef);
        expect(
          (await invoke(page, "workspace:tasks:list", null, { first: 50 })).items.filter(
            (entry) => entry.id === imported.sessionId,
          ),
        ).toHaveLength(1);
        await page.screenshot({ path: testInfo.outputPath("imported-chat-after-restart.png") });
      } finally {
        try {
          await harness.page.screenshot({ path: testInfo.outputPath("codex-import-current.png") });
        } catch {
          // Native fixture setup can fail before an Electron window exists.
        }
        await testInfo.attach("codex-import-native.jsonl", {
          body: fs.existsSync(log) ? fs.readFileSync(log) : Buffer.from(""),
          contentType: "application/jsonl",
        });
        await testInfo.attach("codex-import-runtime.log", {
          body: await readBoundedElectronRuntimeLogs(harness.profile, 256_000),
          contentType: "text/plain",
        });
        await harness.close();
      }
    },
  );
});
