import type { BrowserSidebarRuntimeSnapshot } from "../../src/shared/browser-sidebar";
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ElectronScenarioHarness } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  createAgentSmokeDraft,
  invokeIpc,
  setAgentExecutionProfile,
  sendAgentPrompt,
  sendAgentFollowUp,
  waitForFinalMarker,
  waitForRuntimeCompletedAgentTurn,
} from "./support/agent-smoke-harness";
import {
  browserGuestId,
  browserPageHtml,
  clickAboveBrowserPage,
  clickInBrowserPage,
  openBrowserPage,
  startBrowserSite,
  visibleBrowserGuest,
} from "./support/browser-page";

test("saved Browser annotations reach an existing chat with evidence and survive capture failure @automatic", async ({}, testInfo) => {
  // oxlint-disable-next-line nodex/no-explicit-test-timeout -- Six real Agent Turns plus guest capture cross the Electron and provider processes.
  test.setTimeout(180_000);
  const site = await startBrowserSite({
    "/": browserPageHtml(
      "Annotation target",
      '<button id="target" style="margin:40px;width:200px;height:60px">Checkout target</button>',
    ),
  });
  let received = 0;
  try {
    await withScriptedModelServer(
      {
        exchanges: [
          {
            name: "establish existing thread",
            match: (request) => request.hasUserInputText("Start annotation delivery test"),
            respond: responses.stream([
              responses.created("initial"),
              responses.assistantMessage(
                "initial-message",
                "Ready for annotations",
                "final_answer",
              ),
              responses.completed("initial", true),
            ]),
          },
          {
            name: "annotation with screenshot",
            match: (request) => request.hasUserInputText("Review the first annotation"),
            respond: (request) => {
              const input = JSON.stringify(request.inputItems());
              expect(input).toContain("Make checkout clearer");
              expect(input).toContain(site.origin);
              expect(input).toContain("Checkout target");
              expect(input).toContain("input_image");
              received++;
              return responses.stream([
                responses.created("first"),
                responses.assistantMessage(
                  "first-message",
                  "First annotation received",
                  "final_answer",
                ),
                responses.completed("first", true),
              ]);
            },
          },
          {
            name: "annotation without screenshot",
            match: (request) => request.hasUserInputText("Review the failed screenshot annotation"),
            respond: (request) => {
              const input = JSON.stringify(request.inputItems());
              expect(input).toContain("Keep this note without a screenshot");
              expect(input).toContain(site.origin);
              expect(input).toContain("Checkout target");
              received++;
              return responses.stream([
                responses.created("second"),
                responses.assistantMessage(
                  "second-message",
                  "Second annotation received",
                  "final_answer",
                ),
                responses.completed("second", true),
              ]);
            },
          },
          {
            name: "direct annotation preserves the typed draft",
            match: (request) => request.hasUserInputText("Direct browser note"),
            respond: (request) => {
              const input = JSON.stringify(request.inputItems());
              expect(input).toContain("Direct browser note");
              expect(input).not.toContain("Keep this draft unsent");
              received++;
              return responses.stream([
                responses.created("direct"),
                responses.assistantMessage(
                  "direct-message",
                  "Direct annotation received",
                  "final_answer",
                ),
                responses.completed("direct", true),
              ]);
            },
          },
          {
            name: "send all annotations is one message",
            match: (request) => request.hasUserInputText("Together first note"),
            respond: (request) => {
              const input = JSON.stringify(request.inputItems());
              expect(input).toContain("Together first note");
              expect(input).toContain("Together second note");
              expect(input).not.toContain("Keep this draft unsent");
              received++;
              return responses.stream([
                responses.created("batch"),
                responses.assistantMessage(
                  "batch-message",
                  "Both annotations received",
                  "final_answer",
                ),
                responses.completed("batch", true),
              ]);
            },
          },
          {
            name: "quick annotation sends on Enter and exits",
            match: (request) => request.hasUserInputText("Quick browser note"),
            respond: (request) => {
              expect(JSON.stringify(request.inputItems())).not.toContain("Keep this draft unsent");
              received++;
              return responses.stream([
                responses.created("quick"),
                responses.assistantMessage(
                  "quick-message",
                  "Quick annotation received",
                  "final_answer",
                ),
                responses.completed("quick", true),
              ]);
            },
          },
        ],
      },
      async (server) => {
        const harness = await ElectronScenarioHarness.create({
          label: "browser-annotation-delivery",
          cwd: process.cwd(),
          prepareAgentRuntime: false,
          retention: "dispose",
          environment: {
            ...server.loopbackEnvironment(),
            OPENAI_API_KEY: "nodex-scripted-model-test-key",
            NODEX_LOG_CONSOLE: "0",
            NODEX_LOG_FILE: "1",
          },
        });
        fs.writeFileSync(
          path.join(harness.profile.codexHome, "config.toml"),
          `model_provider = "openai"
openai_base_url = ${JSON.stringify(`${server.baseUrl}/v1`)}
request_max_retries = 0
stream_max_retries = 0
[features]
respect_system_proxy = false
`,
          { mode: 0o600 },
        );
        try {
          const page = await harness.launch();
          await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.5" });
          const draft = await createAgentSmokeDraft(
            page,
            harness.profile.projectsDirectory,
            "Annotation delivery",
          );
          const threadId = await sendAgentPrompt(
            page,
            draft.projectSessionId,
            "Start annotation delivery test",
          );
          const target = { sessionId: draft.projectSessionId, threadId };
          await waitForRuntimeCompletedAgentTurn(page, target);
          await waitForFinalMarker(page, "Ready for annotations");
          await openBrowserPage(page, `${site.origin}/`);
          const guest = visibleBrowserGuest(page);
          await expect(guest).toBeVisible();
          const guestId = await browserGuestId(guest);
          const pins = () =>
            harness.application.evaluate(
              async ({ webContents }, id) =>
                await webContents
                  .fromId(id)!
                  .executeJavaScript(
                    'Array.from(document.querySelectorAll("[data-nodex-browser-annotation-marker]")).map(el => el.textContent)',
                  ),
              guestId,
            );
          await page.getByRole("button", { name: "Annotate", exact: true }).click();
          await clickInBrowserPage(harness, page, guest, "target");
          await page
            .getByRole("textbox", { name: "Annotation note" })
            .fill("Make checkout clearer");
          await page.screenshot({ path: testInfo.outputPath("annotation-editor.png") });
          await page.getByRole("textbox", { name: "Annotation note" }).press("Enter");
          const chip = page.getByRole("button", { name: /^1\. Make checkout clearer/ });
          await expect(chip).toBeVisible();
          await expect.poll(pins).toEqual(["1"]);
          // The note is saved before its screenshot; wait for the screenshot this send asserts.
          await expect
            .poll(async () => {
              const { state } = (await invokeIpc(
                page,
                "browser-sidebar-runtime-snapshot",
              )) as BrowserSidebarRuntimeSnapshot;
              return state.tabs.flatMap((tab) =>
                (tab.annotations ?? []).map((annotation) => annotation.evidenceState),
              );
            })
            .toEqual(["ready"]);
          await page.screenshot({ path: testInfo.outputPath("saved-annotation.png") });
          await harness.application.evaluate(async ({ webContents }, id) => {
            await webContents
              .fromId(id)!
              .executeJavaScript(
                'document.querySelector("[data-nodex-browser-annotation-marker]").click()',
              );
          }, guestId);
          await expect(page.getByRole("textbox", { name: "Annotation note" })).toHaveValue(
            "Make checkout clearer",
          );
          await page.getByRole("textbox", { name: "Annotation note" }).press("Escape");
          await expect(page.getByRole("textbox", { name: "Annotation note" })).toHaveCount(0);
          await expect(
            page.getByRole("button", { name: "Exit comment mode", exact: true }),
          ).toBeVisible();

          await sendAgentFollowUp(page, "Review the first annotation");
          await waitForRuntimeCompletedAgentTurn(page, target);
          await waitForFinalMarker(page, "First annotation received");
          await expect(chip).toHaveCount(0);
          await expect.poll(pins).toEqual([]);
          // Fail the physical screenshot boundary; saving and prompt delivery still work.
          await harness.application.evaluate(({ webContents }, id) => {
            const contents = webContents.fromId(id)! as NonNullable<
              ReturnType<typeof webContents.fromId>
            > & { originalAnnotationCapture?: import("electron").WebContents["capturePage"] };
            contents.originalAnnotationCapture = contents.capturePage.bind(contents);
            contents.capturePage = async () => {
              throw new Error("Forced annotation screenshot failure");
            };
          }, guestId);
          await clickInBrowserPage(harness, page, guest, "target");
          await page
            .getByRole("textbox", { name: "Annotation note" })
            .fill("Keep this note without a screenshot");
          await clickAboveBrowserPage(
            page,
            page.getByRole("button", { name: "Save", exact: true }),
          );
          const failedChip = page.getByRole("button", {
            name: /^2\. Keep this note without a screenshot.*No screenshot/,
          });
          await expect(failedChip).toBeVisible();
          await expect.poll(pins).toEqual(["2"]);
          await sendAgentFollowUp(page, "Review the failed screenshot annotation");
          await waitForRuntimeCompletedAgentTurn(page, target);
          await waitForFinalMarker(page, "Second annotation received");
          await expect(failedChip).toHaveCount(0);
          await expect.poll(pins).toEqual([]);
          await harness.application.evaluate(({ webContents }, id) => {
            const contents = webContents.fromId(id)! as NonNullable<
              ReturnType<typeof webContents.fromId>
            > & { originalAnnotationCapture?: import("electron").WebContents["capturePage"] };
            if (!contents.originalAnnotationCapture)
              throw new Error("Missing original capture boundary");
            contents.capturePage = contents.originalAnnotationCapture;
          }, guestId);
          const composer = page
            .locator('[data-codex-composer="true"][aria-label="Ask for follow-up changes"]')
            .first();
          await composer.fill("Keep this draft unsent");
          await clickInBrowserPage(harness, page, guest, "target");
          await page.getByRole("textbox", { name: "Annotation note" }).fill("Direct browser note");
          await page.screenshot({ path: testInfo.outputPath("annotation-send.png") });
          await page
            .getByRole("textbox", { name: "Annotation note" })
            .press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
          await waitForRuntimeCompletedAgentTurn(page, target);
          await waitForFinalMarker(page, "Direct annotation received");
          await expect(composer).toHaveText("Keep this draft unsent");
          await expect.poll(pins).toEqual([]);
          for (const note of ["Together first note", "Together second note"]) {
            await clickInBrowserPage(harness, page, guest, "target");
            await page.getByRole("textbox", { name: "Annotation note" }).fill(note);
            await page.getByRole("textbox", { name: "Annotation note" }).press("Enter");
          }
          await expect
            .poll(async () => {
              const { state } = (await invokeIpc(
                page,
                "browser-sidebar-runtime-snapshot",
              )) as BrowserSidebarRuntimeSnapshot;
              return state.tabs.flatMap((tab) =>
                (tab.annotations ?? []).map((annotation) => annotation.evidenceState),
              );
            })
            .toEqual(["ready", "ready"]);
          await page
            .getByRole("button", { name: "Send 2 annotations to chat", exact: true })
            .click();
          await waitForRuntimeCompletedAgentTurn(page, target);
          await waitForFinalMarker(page, "Both annotations received");
          await expect(composer).toHaveText("Keep this draft unsent");
          await expect.poll(pins).toEqual([]);
          await expect(page.getByRole("button", { name: /^\d+\. Together/ })).toHaveCount(0);
          const { state: browserState } = (await invokeIpc(
            page,
            "browser-sidebar-runtime-snapshot",
          )) as BrowserSidebarRuntimeSnapshot;
          const source = browserState.tabs.find((tab) => tab.webContentsId === guestId);
          if (!source?.annotationSessionId) throw new Error("Missing annotation editor identity");
          await invokeIpc(page, "browser-sidebar-command", {
            type: "quick-annotate",
            browserConversationId: source.browserConversationId,
            browserViewScopeId: source.browserViewScopeId,
            browserTabId: source.browserTabId,
            sessionId: source.annotationSessionId,
            point: { x: 60, y: 60 },
          });
          await page.getByRole("textbox", { name: "Annotation note" }).fill("Quick browser note");
          await page.getByRole("textbox", { name: "Annotation note" }).press("Enter");
          await waitForRuntimeCompletedAgentTurn(page, target);
          await waitForFinalMarker(page, "Quick annotation received");
          await expect(composer).toHaveText("Keep this draft unsent");
          await expect.poll(pins).toEqual([]);
          await expect(page.getByRole("button", { name: "Annotate", exact: true })).toBeVisible();
          expect(received).toBe(5);
        } finally {
          await harness.close();
        }
      },
    );
  } finally {
    await site.close();
  }
});
