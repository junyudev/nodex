import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
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
  readRuntimeConversation,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForFinalMarker,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";

const ORIGINAL_APP = [
  "export function greet(name: string) {",
  '  return "Hello " + name;',
  "}",
  "",
  "export const version = 1;",
  "",
].join("\n");

/** One patch that edits a file (+4 -2) and creates another (+4), as Codex applies it. */
const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/app.ts",
  "@@",
  " export function greet(name: string) {",
  '-  return "Hello " + name;',
  "+  const greeting = `Hello, ${name}!`;",
  "+  console.log(greeting);",
  "+  return greeting;",
  " }",
  "@@",
  "-export const version = 1;",
  "+export const version = 2;",
  "*** Add File: src/helper.ts",
  "+export const one = 1;",
  "+export const two = 2;",
  "+export const three = 3;",
  "+export const four = 4;",
  "*** End Patch",
].join("\n");

const patchResponse = (request: ScriptedModelRequest, callId: string) => {
  const created = responses.created(`response_${callId}`);
  const completed = responses.completed(`response_${callId}`);
  const tool = request.namedTool("apply_patch");
  if (tool?.type === "custom")
    return responses.stream([
      created,
      responses.customToolCall(callId, "apply_patch", PATCH),
      completed,
    ]);
  if (tool)
    return responses.stream([
      created,
      responses.functionCall(callId, "apply_patch", { input: PATCH }),
      completed,
    ]);
  const invocation = request.toolInvocation("functions", "exec");
  if (!invocation) throw new Error(`Missing patch tool: ${request.diagnosticSummary()}`);
  return responses.stream([
    created,
    responses.customToolCall(
      callId,
      invocation.name,
      `text(await tools.apply_patch(${JSON.stringify(PATCH)}));`,
      invocation.namespace,
    ),
    completed,
  ]);
};

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const bytes = await page.screenshot({ path: testInfo.outputPath(name), animations: "disabled" });
  await testInfo.attach(name, { body: bytes, contentType: "image/png" });
  if (process.env.NODEX_E2E_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.NODEX_E2E_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.NODEX_E2E_EVIDENCE_DIR, name), bytes);
  }
}

const fileChangeRows = (page: Page): Locator =>
  page.locator('[data-testid="file-change-row-header"]');

/** Opens the activity summaries that fold the Turn's patch rows. */
const revealFileChangeRows = async (page: Page): Promise<Locator> => {
  for (const name of [/^Worked for/u, /^Edited files/u]) {
    const summary = page.getByRole("button", { name });
    if ((await summary.count()) > 0 && (await summary.getAttribute("aria-expanded")) !== "true")
      await summary.click();
  }
  const rows = fileChangeRows(page);
  await expect(rows).toHaveCount(2);
  return rows;
};

const expectRowSummaries = async (rows: Locator): Promise<void> => {
  await expect(rows.nth(0)).toContainText("Edited");
  await expect(rows.nth(0)).toContainText("app.ts");
  await expect(rows.nth(0)).toContainText("+4");
  await expect(rows.nth(0)).toContainText("-2");
  await expect(rows.nth(1)).toContainText("Created");
  await expect(rows.nth(1)).toContainText("helper.ts");
  await expect(rows.nth(1)).toContainText("+4");
};

/** The expanded row's frame names the file with its real counts above the rendered diff. */
const expectExpandedEdit = async (page: Page): Promise<void> => {
  const row = fileChangeRows(page).nth(0);
  const toggle = row.locator(":scope > button[aria-expanded]");
  // The path link sits over the row's center, so open the row from the keyboard.
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.press("Enter");
  await expect(row).toContainText("Edited file");
  const body = page.locator("[data-file-change-row-body]").first();
  await expect(body).toContainText("app.ts");
  await expect(body).toContainText("+4");
  await expect(body).toContainText("-2");
  await expect(body).not.toContainText("+0");
  await expect
    .poll(() =>
      body
        .locator("diffs-container")
        .first()
        .evaluate((host) => host.shadowRoot?.textContent ?? ""),
    )
    .toContain("console.log(greeting)");
};

test("an Agent's multi-file patch shows each file's real line counts and diff, live and after restart", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const token = randomUUID();
  const prompt = `FILE_CHANGE_STATS_${token}`;
  const final = `FILE_CHANGE_STATS_DONE_${token}`;
  const callId = `patch_${token.replaceAll("-", "")}`;
  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "apply a patch that edits one file and creates another",
          expectedCalls: 1,
          match: (request) =>
            request.hasUserInputText(prompt) && !request.hasToolCallOutput(callId),
          respond: (request) => patchResponse(request, callId),
        },
        {
          name: "finish after the patch is applied",
          expectedCalls: 1,
          match: (request) => request.hasToolCallOutput(callId),
          respond: () =>
            responses.stream([
              responses.created(`response_final_${token}`),
              responses.assistantMessage(`message_${token}`, final, "final_answer"),
              responses.completed(`response_final_${token}`, true),
            ]),
        },
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "agent-file-change-stats",
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
      const workspace = path.join(harness.profile.initialProjectsDirectory, "file-change-stats");
      fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "src", "app.ts"), ORIGINAL_APP);
      try {
        const page = await harness.launch();
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const draft = await createAgentSmokeDraft(page, workspace, "File change stats");
        const threadId = await sendAgentPrompt(page, draft.projectSessionId, prompt);
        const target = { sessionId: draft.projectSessionId, threadId };
        await waitForFinalMarker(page, final);
        await waitForRuntimeCompletedAgentTurn(page, target);

        expect(fs.readFileSync(path.join(workspace, "src", "app.ts"), "utf8")).toContain(
          "console.log(greeting)",
        );
        const conversation = await readRuntimeConversation(page, target);
        const recorded = conversation.snapshot.projection.visibleTurnItems.flatMap(({ item }) =>
          item.type === "file_change"
            ? (item.changes ?? []).map((change) => ({
                operation: change.operation,
                file: path.basename(change.path),
                additions: change.additions,
                deletions: change.deletions,
                hasDiff: typeof change.diff === "string" && change.diff.length > 0,
              }))
            : [],
        );
        expect(recorded).toEqual([
          { operation: "modify", file: "app.ts", additions: 4, deletions: 2, hasDiff: true },
          { operation: "add", file: "helper.ts", additions: 4, deletions: 0, hasDiff: true },
        ]);

        await expectRowSummaries(await revealFileChangeRows(page));
        await capture(page, testInfo, "live-file-change-rows.png");
        await expectExpandedEdit(page);
        await capture(page, testInfo, "live-expanded-edit.png");

        const reopened = await harness.restart();
        await reopened.locator(`[data-app-action-sidebar-thread-id="${threadId}"]`).click();
        await waitForFinalMarker(reopened, final);
        await expectRowSummaries(await revealFileChangeRows(reopened));
        await expectExpandedEdit(reopened);
        await capture(reopened, testInfo, "restored-expanded-edit.png");
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
