import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
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
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForFinalMarker,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";

const REPORT = [
  "<!doctype html>",
  "<title>Release readiness</title>",
  "<h1>Release readiness</h1>",
  "<p>All checks passed.</p>",
].join("\n");

/** One turn that writes an ignored report and edits a tracked page source. */
const PATCH = [
  "*** Begin Patch",
  "*** Add File: notes.local/report/index.html",
  ...REPORT.split("\n").map((line) => `+${line}`),
  "*** Update File: src/index.html",
  "@@",
  "-<title>Lumen</title>",
  "+<title>Lumen · Sign in</title>",
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

function git(workspace: string, ...args: string[]): void {
  execFileSync("git", ["-C", workspace, ...args], { stdio: "ignore" });
}

/** A repository whose page source is tracked and whose notes are ignored. */
function createWorkspace(workspace: string): void {
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".gitignore"), "notes.local/\n");
  fs.writeFileSync(path.join(workspace, "src", "index.html"), "<title>Lumen</title>\n");
  git(workspace, "init", "--quiet", "--initial-branch=main");
  git(workspace, "add", ".");
  git(
    workspace,
    "-c",
    "user.name=Nodex",
    "-c",
    "user.email=nodex@example.com",
    "commit",
    "--quiet",
    "-m",
    "Initial",
  );
}

test("a turn's deliverable appears as a card and in the summary, while its source edit does not", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const token = randomUUID();
  const prompt = `TURN_OUTPUT_CARDS_${token}`;
  const final = `TURN_OUTPUT_CARDS_DONE_${token}`;
  const callId = `patch_${token.replaceAll("-", "")}`;
  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "write a report and edit the page source",
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
              responses.assistantMessage(
                `message_${token}`,
                `The report is ready and the sign-in title is updated.\n\n${final}`,
                "final_answer",
              ),
              responses.completed(`response_final_${token}`, true),
            ]),
        },
      ],
    },
    async (modelServer) => {
      const harness = await ElectronScenarioHarness.create({
        label: "turn-output-cards",
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
      const workspace = path.join(harness.profile.initialProjectsDirectory, "lumen-web");
      createWorkspace(workspace);
      try {
        const page = await harness.launch();
        // Wide enough for the pinned summary beside the transcript.
        await page.setViewportSize({ width: 1600, height: 1000 });
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
        const draft = await createAgentSmokeDraft(page, workspace, "Lumen");
        const threadId = await sendAgentPrompt(page, draft.projectSessionId, prompt);
        await waitForFinalMarker(page, final);
        await waitForRuntimeCompletedAgentTurn(page, {
          sessionId: draft.projectSessionId,
          threadId,
        });

        // The ignored report is the turn's output; the tracked page source is a change for Review.
        const card = page.getByRole("button", { name: "Open report/index.html", exact: true });
        await expect(card).toBeVisible({ timeout: 30_000 });
        const cardSurface = card.locator("xpath=..");
        await expect(cardSurface).toContainText("HTML");
        await expect(cardSurface).toContainText("notes.local");
        await expect(
          page.getByRole("button", { name: "Open report/index.html in", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: /^Open (src\/)?index\.html$/u })).toHaveCount(
          0,
        );

        // Outputs sits beside Environment: the summary lists the report and no source change.
        const summaryToggle = page
          .getByRole("button", { name: /^Toggle (pinned )?summary/u })
          .first();
        if ((await summaryToggle.getAttribute("aria-pressed")) !== "true")
          await summaryToggle.click();
        await expect(summaryToggle).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByText("Outputs", { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText("Changes", { exact: true })).toBeVisible();
        await expect(
          page.getByRole("button", { name: "report/index.html", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: /^index\.html$/u })).toHaveCount(0);
        await card.scrollIntoViewIfNeeded();
        const cardBytes = await cardSurface.screenshot({ animations: "disabled" });
        await testInfo.attach("turn-output-card.png", {
          body: cardBytes,
          contentType: "image/png",
        });
        if (process.env.NODEX_E2E_EVIDENCE_DIR)
          fs.writeFileSync(
            path.join(process.env.NODEX_E2E_EVIDENCE_DIR, "turn-output-card.png"),
            cardBytes,
          );
        await capture(page, testInfo, "turn-output-card-and-summary.png");

        // A local HTML deliverable renders in the in-app Browser as the page it is.
        await card.click();
        const address = page
          .getByRole("combobox", { name: "Search or enter a URL" })
          .or(page.getByRole("textbox", { name: "Search or enter a URL" }));
        await expect(address.first()).toHaveValue(/report\/index\.html/u, { timeout: 30_000 });
        await expect(page.getByRole("tab", { name: /Release readiness/u })).toBeVisible({
          timeout: 30_000,
        });
        await capture(page, testInfo, "turn-output-html-in-browser.png");
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
