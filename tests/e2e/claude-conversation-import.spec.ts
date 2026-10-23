import { expect, test } from "@playwright/test";
import { openWorkbenchSettings } from "./support/workbench-settings";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import { AGENT_CLI_SCENARIO_ID } from "../../scripts/scenarios/scenarios/agent-cli-workflow";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import type {
  NativeConversationImportPreviewResult,
  NativeConversationImportInput,
  NativeConversationImportResult,
  NativeSessionCatalogPage,
} from "../../src/shared/native-session-catalog";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import {
  invokeIpc,
  readRuntimeConversation,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";

interface NativeObservation {
  readonly type: string;
  readonly persistent?: boolean;
  readonly resumed?: boolean;
  readonly sessionId: string;
  readonly cwd: string;
  readonly content?: unknown;
}

test("imports Claude history as an independent executable copy with a replacement directory", async ({}, testInfo) => {
  test.setTimeout(150_000);
  await withElectronScenario(
    {
      label: "claude-conversation-import",
      scenarioId: AGENT_CLI_SCENARIO_ID,
      environment: {
        NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: path.resolve("."),
        NODEX_LOG_FILE: "1",
      },
      onFailure: async ({ readRuntimeLogs }) => {
        await testInfo.attach("claude-import-runtime.log", {
          body: await readRuntimeLogs(),
          contentType: "text/plain",
        });
      },
    },
    async ({ harness, page }) => {
      const nativeSessionId = createUuidV7();
      const userId = createUuidV7();
      const replacementCwd = realpathSync(harness.profile.initialProjectsDirectory);
      const originalCwd = path.join(harness.profile.runRoot, "removed-workspace");
      const nativeHome = path.join(harness.profile.runRoot, "native-claude");
      const projectDirectory = path.join(
        nativeHome,
        "projects",
        originalCwd.replace(/[^a-zA-Z0-9]/gu, "-"),
      );
      mkdirSync(projectDirectory, { recursive: true });
      const transcriptPath = path.join(projectDirectory, `${nativeSessionId}.jsonl`);
      const image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const title = "Independent Claude history";
      const sourcePrompt = "Remember the imported Claude constraint";
      const sourceReply =
        "Claude source context retained\n\n![Missing original image](missing-image.png)";
      const history =
        [
          {
            type: "user",
            uuid: userId,
            parentUuid: null,
            sessionId: nativeSessionId,
            cwd: originalCwd,
            timestamp: new Date().toISOString(),
            message: {
              role: "user",
              content: [
                { type: "text", text: sourcePrompt },
                { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
              ],
            },
          },
          {
            type: "assistant",
            uuid: createUuidV7(),
            parentUuid: userId,
            sessionId: nativeSessionId,
            cwd: originalCwd,
            timestamp: new Date().toISOString(),
            message: {
              role: "assistant",
              model: "claude-opus-5",
              content: [{ type: "text", text: sourceReply }],
            },
          },
          { type: "custom-title", customTitle: title, sessionId: nativeSessionId },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n";
      writeFileSync(transcriptPath, history);
      const executable = path.join(harness.profile.runRoot, "claude");
      const peer = pathToFileURL(
        path.resolve("scripts/scenarios/runtime/scripted-claude-agent.mjs"),
      ).href;
      writeFileSync(executable, `#!${process.execPath}\nimport(${JSON.stringify(peer)});\n`, {
        mode: 0o755,
      });
      await invokeIpc(page, "settings:claude-agents:update", {
        instances: [
          {
            id: "native-work",
            displayName: "Work",
            binaryPath: executable,
            configDirectory: nativeHome,
            enabled: true,
            environment: [],
          },
        ],
      });
      const observationsPath = path.join(nativeHome, "observations.jsonl");
      const observations = (): NativeObservation[] =>
        existsSync(observationsPath)
          ? readFileSync(observationsPath, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
      const launches = () =>
        observations().filter((entry) => entry.type === "launch" && entry.persistent);

      await openWorkbenchSettings(page);
      await page.getByRole("link", { name: "Agent", exact: true }).click();
      const setupSource = page.getByRole("button", { name: "Other Codex home", exact: true });
      await setupSource.scrollIntoViewIfNeeded();
      await expect(page.getByText("Copy setup from", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("codex-setup-import-location.png") });
      await page.getByRole("link", { name: "Conversations", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Conversation link or ID", exact: true })
        .fill(nativeSessionId);
      const form = page.getByRole("group", { name: title, exact: true });
      const selection = page.getByRole("group", { name: "Import selection", exact: true });
      await expect(form).toBeVisible();
      await expect(
        selection.getByRole("button", { name: "Import and open", exact: true }),
      ).toBeDisabled();
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
      await page.screenshot({
        path: testInfo.outputPath("claude-import-replacement-directory.png"),
      });
      expect(launches()).toEqual([]);
      await selection.getByRole("button", { name: "Import and open", exact: true }).click();
      await expect(
        page.getByText("Claude source context retained", { exact: true }).last(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-codex-composer="true"]').first()).toBeEditable();
      const source = { backendKind: "claude" as const, instanceConfigId: "native-work" };
      const catalog = (await invokeIpc(
        page,
        "native-sessions:list",
        source,
      )) as NativeSessionCatalogPage;
      const entry = catalog.entries.find(
        (candidate) => candidate.nativeSessionId === nativeSessionId,
      );
      if (!entry?.importedSessionId || !entry.importedThreadId)
        throw new Error("Imported Claude copy missing from catalog");
      const imported: NativeConversationImportResult = {
        sessionId: entry.importedSessionId,
        threadId: entry.importedThreadId,
        projectId: null,
      };
      const execution = { sessionId: imported.sessionId, threadId: imported.threadId };
      const copied = await readRuntimeConversation(page, execution);
      expect(copied.snapshot.projection.runs).toEqual([]);
      expect(copied.snapshot.projection.thread.modelSelection.instanceId).toBe(
        agentRuntimeProviderId({ kind: "claude", instanceConfigId: "native-work" }),
      );
      const items = copied.snapshot.projection.visibleTurnItems.map((row) => row.item);
      const user = items.find((item) => item.type === "user_message");
      expect(user?.type).toBe("user_message");
      if (user?.type !== "user_message") throw new Error("Imported prompt is missing");
      expect(user.text).toBe(sourcePrompt);
      expect(user.attachments).toHaveLength(1);
      const assistant = items.find((item) => item.type === "assistant_message");
      expect(assistant?.unavailableImages).toEqual([
        { name: "missing-image.png", sourcePath: "missing-image.png", reason: "source_missing" },
      ]);
      expect(launches()).toEqual([]);
      expect(readFileSync(transcriptPath, "utf8")).toBe(history);

      const preview = (await invokeIpc(page, "native-sessions:preview-import", {
        reference: nativeSessionId,
      })) as NativeConversationImportPreviewResult;
      expect(preview.matches).toHaveLength(1);
      expect(preview.matches[0]).toMatchObject({
        ...source,
        importedSessionId: imported.sessionId,
        importedThreadId: imported.threadId,
        cwdAvailable: false,
      });
      const retry: NativeConversationImportInput = {
        ...source,
        requestId: imported.sessionId,
        acceptedAt: Date.now(),
        nativeSessionId,
        expectedHome: catalog.nativeHome,
        cwd: replacementCwd,
        projectId: null,
      };
      expect(await invokeIpc(page, "native-sessions:import", retry)).toEqual({
        kind: "imported",
        ...imported,
      });

      const composer = page
        .locator('[data-codex-composer="true"][contenteditable="true"]:visible')
        .first();
      await composer.fill("Verify imported copy continuation");
      await page.getByRole("button", { name: "Send prompt", exact: true }).click();
      await waitForRuntimeCompletedAgentTurn(page, execution, 30_000);
      await expect(
        page.getByText("Independent Claude copy continued", { exact: true }).last(),
      ).toBeVisible();
      expect(launches().length).toBeGreaterThan(0);
      expect(
        launches().every(
          (launch) => launch.sessionId !== nativeSessionId && launch.cwd === replacementCwd,
        ),
      ).toBe(true);
      expect(launches()[0]?.resumed).toBe(false);
      const prompt = observations().find((entry) => entry.type === "prompt");
      expect(JSON.stringify(prompt?.content)).toContain(sourcePrompt);
      expect(JSON.stringify(prompt?.content)).toContain("Claude source context retained");
      expect(readFileSync(transcriptPath, "utf8")).toBe(history);

      rmSync(transcriptPath);
      const reopened = await harness.restart();
      expect(await invokeIpc(reopened, "native-sessions:import", retry)).toEqual({
        kind: "imported",
        ...imported,
      });
      const restored = await readRuntimeConversation(reopened, execution);
      expect(
        restored.snapshot.projection.visibleTurnItems.some(
          (row) => row.item.type === "user_message" && row.item.text === sourcePrompt,
        ),
      ).toBe(true);
      const resumedComposer = reopened
        .locator('[data-codex-composer="true"][contenteditable="true"]:visible')
        .first();
      await expect(resumedComposer).toBeEditable();
      await resumedComposer.fill("Verify imported copy continuation after source removal");
      await reopened.getByRole("button", { name: "Send prompt", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await readRuntimeConversation(reopened, execution)).snapshot.projection.runs.length,
        )
        .toBe(2);
      await waitForRuntimeCompletedAgentTurn(reopened, execution, 30_000);
      expect(launches().every((launch) => launch.sessionId !== nativeSessionId)).toBe(true);
      expect(existsSync(transcriptPath)).toBe(false);
      await reopened.screenshot({
        path: testInfo.outputPath("claude-import-continued-after-restart.png"),
      });
    },
  );
});
