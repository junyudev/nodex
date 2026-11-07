import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  createAgentSmokeDraft,
  sendAgentFollowUp,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForFinalMarker,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";

const CHAT_TITLE = "Archive toast";

const toastWith = (page: Page, title: string): Locator =>
  page.locator('[data-slot="toast-item"]').filter({ hasText: title });

async function archive(page: Page, row: Locator): Promise<Locator> {
  await row.hover();
  await row.getByRole("button", { name: "Archive chat" }).click();
  await expect(row).toHaveCount(0);
  const toast = toastWith(page, "Archived chat");
  await expect(toast).toBeVisible();
  return toast;
}

test("a chat archived from the sidebar comes back through Undo and Data controls and keeps working", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const token = randomUUID();
  const turn = (name: string) => ({
    prompt: `ARCHIVE_TOAST_${name}_${token}`,
    final: `ARCHIVE_TOAST_${name}_DONE_${token}`,
  });
  const turns = { first: turn("FIRST"), undone: turn("UNDONE"), restored: turn("RESTORED") };
  await withScriptedModelServer(
    {
      exchanges: Object.entries(turns).map(([name, { prompt, final }]) => ({
        name: `answer the ${name} turn`,
        expectedCalls: 1,
        match: (request) => request.hasUserInputText(prompt),
        respond: () =>
          responses.stream([
            responses.created(`response_${name}_${token}`),
            responses.assistantMessage(`message_${name}_${token}`, final, "final_answer"),
            responses.completed(`response_${name}_${token}`, true),
          ]),
      })),
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "archive-chat-toast",
        cwd: process.cwd(),
        prepareAgentRuntime: false,
        environment: {
          ...modelServer.loopbackEnvironment(),
          NODEX_LOG_CONSOLE: "0",
          NODEX_LOG_FILE: "1",
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
        },
      });
      fs.writeFileSync(
        path.join(harness.profile.codexHome, "config.toml"),
        `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${modelServer.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\n`,
        { mode: 0o600 },
      );
      const workspace = path.join(harness.profile.initialProjectsDirectory, "archive-toast");
      fs.mkdirSync(workspace, { recursive: true });
      try {
        const page = await harness.launch();
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const draft = await createAgentSmokeDraft(page, workspace, CHAT_TITLE);
        const sessionId = draft.projectSessionId;
        const threadId = await sendAgentPrompt(page, sessionId, turns.first.prompt);
        const target = { sessionId, threadId };
        await waitForFinalMarker(page, turns.first.final);
        await waitForRuntimeCompletedAgentTurn(page, target);
        const row = page.locator(`[data-app-action-sidebar-thread-id="${threadId}"]`);
        await expect(row).toBeVisible();

        // Undo restores the open chat and it keeps answering.
        const undoToast = await archive(page, row);
        await expect
          .poll(async () => {
            const box = await undoToast.getByRole("alert").boundingBox();
            return box && { top: box.y, height: box.height };
          })
          .toEqual({ top: 48, height: 42 });
        await undoToast.getByRole("button", { name: "Undo" }).click();
        await expect(toastWith(page, "Chat restored")).toBeVisible();
        await expect(undoToast).toHaveCount(0);
        await expect(row).toBeVisible();
        await sendAgentFollowUp(page, turns.undone.prompt);
        await waitForFinalMarker(page, turns.undone.final);
        await waitForRuntimeCompletedAgentTurn(page, target);

        // View opens the list holding the chat, and restoring from there keeps it working too.
        const viewToast = await archive(page, row);
        await viewToast.getByRole("button", { name: "View" }).click();
        await expect(viewToast).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Data controls" })).toBeVisible();
        const archivedChat = page.getByRole("button", { name: "Unarchive" });
        await expect(archivedChat).toHaveCount(1);
        await archivedChat.click();
        const unarchivedToast = toastWith(page, "Unarchived chat");
        await expect(unarchivedToast).toBeVisible();
        await expect(toastWith(page, "Failed to unarchive chat")).toHaveCount(0);
        await expect(archivedChat).toHaveCount(0);
        await unarchivedToast.getByRole("button", { name: "View" }).click();
        await expect(row).toBeVisible();
        await sendAgentFollowUp(page, turns.restored.prompt);
        await waitForFinalMarker(page, turns.restored.final);
        await waitForRuntimeCompletedAgentTurn(page, target);

        // Dismissing the toast leaves the chat archived.
        const dismissToast = await archive(page, row);
        await dismissToast.getByRole("button", { name: "Dismiss notification" }).click();
        await expect(dismissToast).toHaveCount(0);
        await expect(row).toHaveCount(0);
      } catch (error) {
        await testInfo.attach("runtime.log", {
          body: await readBoundedElectronRuntimeLogs(harness.profile, 256_000),
          contentType: "text/plain",
        });
        await testInfo.attach("dom.txt", {
          body: await harness.page.locator("body").innerText(),
          contentType: "text/plain",
        });
        await testInfo.attach("failure.png", {
          body: await harness.page.screenshot(),
          contentType: "image/png",
        });
        throw error;
      } finally {
        await harness.close();
      }
    },
  );
});
