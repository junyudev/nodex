import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  collectRecords,
  createAgentSmokeDraft,
  invokeIpc,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForCompletedAgentTurn,
  waitForFinalMarker,
} from "./support/agent-smoke-harness";
import { workbenchScriptedTitle } from "./support/workbench-scripted-title";

const finalResponse = (id: string, text: string) =>
  responses.stream([
    responses.created(id),
    responses.assistantMessage(`${id}_answer`, text, "final_answer"),
    responses.completed(id, true),
  ]);

test("long file paths retain exact submission context before and after pinning", async () => {
  test.setTimeout(180_000);
  let filePath = "";
  await withScriptedModelServer(
    {
      exchanges: [
        workbenchScriptedTitle,
        {
          name: "show a file reference",
          expectedCalls: 1,
          match: (request) => request.hasUserInputText("FILE_LINK_PROBE"),
          respond: () => finalResponse("file_link", `[Submission fixture](${filePath})`),
        },
        ...["PREVIEW", "PINNED"].map((phase) => ({
          name: `inspect ${phase.toLowerCase()} context`,
          expectedCalls: 2,
          maximumCalls: 2,
          match: (
            request: import("../../scripts/scenarios/runtime/scripted-model-server").ScriptedModelRequest,
          ) => request.hasUserInputText(`FILE_${phase}_PROBE`),
          respond: (
            request: import("../../scripts/scenarios/runtime/scripted-model-server").ScriptedModelRequest,
            index: number,
          ) => {
            if (index === 0) {
              const tool = request.toolInvocation("functions", "exec");
              expect(tool).not.toBeNull();
              return responses.stream([
                responses.created(`file_${phase}`),
                responses.customToolCall(
                  `file_${phase}_call`,
                  tool!.name,
                  'const unwrap = r => { const v = typeof r === "string" ? JSON.parse(r) : r; return v.structuredContent ?? (v.content ? JSON.parse(v.content[0].text) : v); }; const context = unwrap(await tools.mcp__nodex_app__get_session_context({})); text({context}); text({tabs:unwrap(await tools.mcp__nodex_app__list_session_tabs({observationId:context.presentation.observationId}))});',
                  tool!.namespace,
                ),
                responses.completed(`file_${phase}`),
              ]);
            }
            const records = collectRecords(request.toolCallOutput(`file_${phase}_call`)).flatMap(
              (record) => {
                if (record.type !== "input_text" || typeof record.text !== "string") return [];
                try {
                  return collectRecords(JSON.parse(record.text));
                } catch {
                  return [];
                }
              },
            );
            expect(records.find((record) => record.context)?.context).toMatchObject({
              presentation: { status: "available", origin: "submission" },
            });
            expect(records.find((record) => record.tabs)?.tabs).toMatchObject({
              items: expect.arrayContaining([
                expect.objectContaining({
                  kind: "files",
                  path: filePath,
                  preview: phase === "PREVIEW",
                  status: "authorized",
                }),
              ]),
            });
            return finalResponse(`file_${phase}_done`, `FILE_${phase}_OK`);
          },
        })),
      ],
    },
    async (model) => {
      const harness = await ElectronScenarioHarness.create({
        label: "file-submission",
        cwd: process.cwd(),
        prepareAgentRuntime: false,
        environment: {
          ...model.loopbackEnvironment(),
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
        },
      });
      filePath = join(
        harness.profile.initialProjectsDirectory,
        `${"long-file-".repeat(18)}路径.txt`,
      );
      writeFileSync(filePath, "Exact file context remains usable after pinning.\n");
      writeFileSync(
        join(harness.profile.codexHome, "config.toml"),
        `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${model.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\n`,
        { mode: 0o600 },
      );
      try {
        const page = await harness.launch();
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.6-sol" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.initialProjectsDirectory,
          "File submission",
        );
        await invokeIpc(page, "codex:permission:mode:set", draft.projectId, "full-access");
        const threadId = await sendAgentPrompt(page, draft.projectSessionId, "FILE_LINK_PROBE");
        const link = page
          .locator('button[data-file-reference="true"]')
          .filter({ hasText: "Submission fixture" });
        await expect(link).toBeVisible();
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        await link.click();
        const tab = page.getByRole("tab", { name: "Submission fixture", exact: true });
        const chrome = tab.locator("xpath=ancestor::*[@data-panel-tab-id][1]");
        const surfaceId = await chrome.getAttribute("data-panel-tab-id");
        expect(surfaceId).toBe(`file:local:${filePath}`);
        await expect(chrome).toHaveAttribute("data-app-shell-tab-preview", "true");
        const followUp = page.locator(
          '[data-codex-composer="true"][aria-label="Ask for follow-up changes"]',
        );
        await followUp.fill("FILE_PREVIEW_PROBE");
        await page.getByRole("button", { name: "Send prompt", exact: true }).click();
        await waitForFinalMarker(page, "FILE_PREVIEW_OK");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        await tab.dblclick();
        await expect(chrome).not.toHaveAttribute("data-app-shell-tab-preview", "true");
        await expect(chrome).toHaveAttribute("data-panel-tab-id", surfaceId!);
        await page.reload();
        await page.evaluate(() => window.api?.awaitInitialization?.());
        await expect(chrome).toHaveAttribute("data-panel-tab-id", surfaceId!);
        await expect(chrome).not.toHaveAttribute("data-app-shell-tab-preview", "true");
        await followUp.fill("FILE_PINNED_PROBE");
        await page.getByRole("button", { name: "Send prompt", exact: true }).click();
        await waitForFinalMarker(page, "FILE_PINNED_OK");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
      } finally {
        await harness.close();
      }
    },
  );
});
