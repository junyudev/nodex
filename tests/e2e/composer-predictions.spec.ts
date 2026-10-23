import { expect, test, type Page } from "@playwright/test";
import { openWorkbenchSettings } from "./support/workbench-settings";
import { AGENT_RUNTIME_CODEX_THREAD_SOURCE } from "@nodex/agent-runtime/contracts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  type ScriptedModelRequest,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  createAgentSmokeDraft,
  invokeIpc,
  readRuntimeConversation,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForFinalMarker,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";

const isPrediction = (request: ScriptedModelRequest): boolean =>
  request.isGenerationRequest() && request.isThreadSource("composer_predictions");

const openComposerSettings = async (page: Page) => {
  await openWorkbenchSettings(page);
  await page.getByRole("link", { name: "General", exact: true }).click();
  const control = page.getByRole("switch", { name: "Show predictions", exact: true });
  await expect(control).toBeVisible();
  return control;
};

const returnToChat = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to app", exact: true })).toHaveCount(0);
};

test("prepares predictions away from the Composer, accepts without sending, and honors the saved switch", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const token = randomUUID();
  const firstPrompt = `解释这个函数的输入边界 ${token}`;
  const firstReply = `输入边界已经说明 ${token}`;
  const suggestion = "请补上对应的单元测试";
  const editedSuggestion = `${suggestion}，包括空输入。`;
  const secondReply = `单元测试已经补齐 ${token}`;
  const nextSuggestion = "再检查一下错误处理";
  const disabledPrompt = `总结修改后的行为 ${token}`;
  const disabledReply = `修改后的行为已经总结 ${token}`;
  let releaseFirstResponse: () => void = () => undefined;
  const firstResponse = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });

  await withScriptedModelServer(
    {
      backgroundExchanges: [
        {
          name: "background prediction inherits the completed conversation",
          match: isPrediction,
          respond: (request) => {
            expect(request.body.model).toBe("gpt-5.5");
            expect(request.hasInputText(firstPrompt)).toBe(true);
            expect(request.hasInputText(firstReply)).toBe(true);
            return responses.stream([
              responses.created(`prediction-${token}`),
              responses.assistantMessage(
                `prediction-message-${token}`,
                JSON.stringify({ suggestion }),
                "final_answer",
              ),
              responses.completed(`prediction-${token}`, true),
            ]);
          },
        },
        {
          name: "a new completed Run replaces the earlier prediction",
          match: isPrediction,
          respond: (request) => {
            expect(request.hasInputText(editedSuggestion)).toBe(true);
            expect(request.hasInputText(secondReply)).toBe(true);
            return responses.stream([
              responses.created(`next-prediction-${token}`),
              responses.assistantMessage(
                `next-prediction-message-${token}`,
                JSON.stringify({ suggestion: nextSuggestion }),
                "final_answer",
              ),
              responses.completed(`next-prediction-${token}`, true),
            ]);
          },
        },
      ],
      exchanges: [
        {
          name: "initial conversation reply waits until its Composer is closed",
          match: (request) =>
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            request.hasUserInputText(firstPrompt),
          respond: async () => {
            await firstResponse;
            return responses.stream([
              responses.created(`initial-${token}`),
              responses.assistantMessage(`initial-message-${token}`, firstReply, "final_answer"),
              responses.completed(`initial-${token}`, true),
            ]);
          },
        },
        {
          name: "the accepted and edited prediction is an ordinary follow-up",
          match: (request) =>
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            request.hasUserInputText(editedSuggestion),
          respond: responses.stream([
            responses.created(`follow-up-${token}`),
            responses.assistantMessage(`follow-up-message-${token}`, secondReply, "final_answer"),
            responses.completed(`follow-up-${token}`, true),
          ]),
        },
        {
          name: "an ordinary turn still runs after predictions are disabled",
          match: (request) =>
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            request.hasUserInputText(disabledPrompt),
          respond: responses.stream([
            responses.created(`disabled-${token}`),
            responses.assistantMessage(`disabled-message-${token}`, disabledReply, "final_answer"),
            responses.completed(`disabled-${token}`, true),
          ]),
        },
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "composer-predictions",
        cwd: process.cwd(),
        prepareAgentRuntime: false,
        environment: {
          ...modelServer.loopbackEnvironment(),
          NODEX_LOG_CONSOLE: "1",
          NODEX_LOG_FILE: "1",
          NODEX_LOG_FILE_LEVEL: "debug",
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
        },
      });
      fs.writeFileSync(
        path.join(harness.profile.codexHome, "config.toml"),
        `model_provider = "openai"
openai_base_url = ${JSON.stringify(`${modelServer.baseUrl}/v1`)}
request_max_retries = 0
stream_max_retries = 0

[features]
respect_system_proxy = false
`,
        { encoding: "utf8", mode: 0o600 },
      );

      let inspectionPage: Page | null = null;
      try {
        const page = await harness.launch();
        inspectionPage = page;
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.initialProjectsDirectory,
          "Composer predictions",
        );
        const initialSwitch = await openComposerSettings(page);
        await expect(initialSwitch).toBeChecked();
        await initialSwitch.uncheck();
        await expect(initialSwitch).not.toBeChecked();
        await initialSwitch.check();
        await expect(initialSwitch).toBeChecked();
        await expect
          .poll(() => invokeIpc(page, "settings:composer-predictions:get"))
          .toEqual({ enabled: true });
        await returnToChat(page);

        const threadId = await sendAgentPrompt(page, draft.projectSessionId, firstPrompt);
        const target = { sessionId: draft.projectSessionId, threadId };
        await modelServer.waitForRequest(
          (request) =>
            request.isThreadSource(AGENT_RUNTIME_CODEX_THREAD_SOURCE) &&
            request.hasUserInputText(firstPrompt),
          30_000,
        );
        await openComposerSettings(page);
        await expect(page.locator("[data-codex-composer='true']")).toHaveCount(0);
        releaseFirstResponse();

        // No Composer is mounted when the completed Run launches this native prediction fork.
        await modelServer.waitForRequest(isPrediction, 30_000);
        await waitForRuntimeCompletedAgentTurn(page, target);
        await returnToChat(page);
        const composer = page.locator("[data-codex-composer='true']").first();
        const ghost = composer.locator("[data-composer-prediction]");
        await expect(ghost).toHaveText(suggestion, { timeout: 30_000 });
        await expect(ghost).toHaveAttribute("aria-hidden", "true");
        await expect(page.getByRole("button", { name: "Send prompt", exact: true })).toBeDisabled();
        const screenshotPath = testInfo.outputPath("composer-prediction.png");
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach("composer-prediction.png", {
          path: screenshotPath,
          contentType: "image/png",
        });

        await composer.press("Enter");
        await expect(ghost).toHaveCount(0);
        await expect(composer).toHaveText(suggestion);
        await expect(page.getByRole("button", { name: "Send prompt", exact: true })).toBeEnabled();
        const accepted = await readRuntimeConversation(page, target);
        expect(accepted.snapshot.projection.runs.at(-1)).toMatchObject({
          ordinal: 1,
          status: "completed",
        });
        await page.keyboard.insertText("，包括空输入。");
        await expect(composer).toHaveText(editedSuggestion);
        await composer.press("Enter");
        await waitForFinalMarker(page, secondReply);
        const followedUp = await waitForRuntimeCompletedAgentTurn(page, target);
        expect(followedUp.snapshot.projection.runs.at(-1)).toMatchObject({
          ordinal: 2,
          status: "completed",
        });
        await expect(ghost).toHaveText(nextSuggestion, { timeout: 30_000 });
        expect(modelServer.requests().filter(isPrediction)).toHaveLength(2);

        const enabledSwitch = await openComposerSettings(page);
        await enabledSwitch.uncheck();
        await expect(enabledSwitch).not.toBeChecked();
        await expect
          .poll(() => invokeIpc(page, "settings:composer-predictions:get"))
          .toEqual({ enabled: false });
        await returnToChat(page);
        await expect(ghost).toHaveCount(0);

        const restarted = await harness.restart();
        inspectionPage = restarted;
        await expect(await openComposerSettings(restarted)).not.toBeChecked();
        await returnToChat(restarted);
        const restartedComposer = restarted.locator("[data-codex-composer='true']").first();
        await restartedComposer.fill(disabledPrompt);
        await restartedComposer.press("Enter");
        await waitForFinalMarker(restarted, disabledReply);
        const disabled = await waitForRuntimeCompletedAgentTurn(restarted, target);
        expect(disabled.snapshot.projection.runs.at(-1)).toMatchObject({
          ordinal: 3,
          status: "completed",
        });
        await expect(
          modelServer.waitForRequest(
            (request) => isPrediction(request) && request.hasInputText(disabledPrompt),
            1_000,
          ),
        ).rejects.toThrow("Timed out");
        await expect(restartedComposer.locator("[data-composer-prediction]")).toHaveCount(0);
        expect(modelServer.requests().filter(isPrediction)).toHaveLength(2);
      } finally {
        releaseFirstResponse();
        try {
          if (inspectionPage && !inspectionPage.isClosed()) {
            const screenshotPath = testInfo.outputPath("composer-predictions-final.png");
            await inspectionPage.screenshot({ path: screenshotPath });
            await testInfo.attach("composer-predictions-final.png", {
              path: screenshotPath,
              contentType: "image/png",
            });
          }
          await testInfo.attach("composer-predictions-runtime.log", {
            body: await readBoundedElectronRuntimeLogs(harness.profile, 256_000),
            contentType: "text/plain",
          });
        } finally {
          await harness.close();
        }
      }
    },
  );
});
