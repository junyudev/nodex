import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import type { WorkbenchSceneReference } from "../../src/shared/nodex-app-tools/workbench";
import type { WindowSessionBootstrap } from "../../src/shared/window-session";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
import {
  responses,
  type ScriptedModelRequest,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  collectRecords,
  createAgentSmokeDraft,
  invokeIpc,
  requireRecord,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForCompletedAgentTurn,
  waitForFinalMarker,
} from "./support/agent-smoke-harness";

const BOOT_PROMPT = "WORKBENCH_MULTIWINDOW_BOOT";
const SETUP_PROMPT = "WORKBENCH_MULTIWINDOW_SETUP";
const ANCHOR_PROMPT = "WORKBENCH_MULTIWINDOW_ANCHOR";

const toolOutputRecords = (request: ScriptedModelRequest, callId: string) =>
  collectRecords(request.toolCallOutput(callId)).flatMap((record) => {
    if (record.type !== "input_text" || typeof record.text !== "string") return [];
    try {
      return collectRecords(JSON.parse(record.text));
    } catch {
      return [];
    }
  });

const namedOutput = (records: readonly Record<string, unknown>[], name: string) =>
  requireRecord(records.find((record) => Object.hasOwn(record, name))?.[name], name);

const nativeCall = (request: ScriptedModelRequest, callId: string, lines: readonly string[]) => {
  const tool = request.toolInvocation("functions", "exec");
  expect(tool).not.toBeNull();
  return responses.stream([
    responses.created(callId),
    responses.customToolCall(
      callId,
      tool!.name,
      [
        '// @exec: {"yield_time_ms": 60000, "max_output_tokens": 18000}',
        'const unwrap = r => { const v = typeof r === "string" ? JSON.parse(r) : r; return v.structuredContent ?? (v.content ? JSON.parse(v.content[0].text) : v); };',
        ...lines,
      ].join("\n"),
      tool!.namespace,
    ),
    responses.completed(callId),
  ]);
};

const finalResponse = (id: string, marker: string) =>
  responses.stream([
    responses.created(id),
    responses.assistantMessage(`${id}_answer`, marker, "final_answer"),
    responses.completed(id, true),
  ]);

test("native Workbench observations keep two windows independent and preserve the submitted target", async () => {
  test.setTimeout(180_000);
  const originalPageId = createUuidV7();
  const replacementPageId = createUuidV7();
  const otherWindowPageId = createUuidV7();
  let finishSwitch = () => {};
  const switched = new Promise<void>((resolve) => {
    finishSwitch = resolve;
  });
  let sessionId = "";
  let firstWindowId = "";
  let secondWindowId = "";
  let otherReference: WorkbenchSceneReference | null = null;

  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "create the shared Session",
          match: (request) =>
            request.hasUserInputText(BOOT_PROMPT) &&
            !request.hasUserInputText(SETUP_PROMPT) &&
            !request.hasUserInputText(ANCHOR_PROMPT),
          expectedCalls: 1,
          maximumCalls: 1,
          respond: finalResponse("multiwindow_boot", "WORKBENCH_MULTIWINDOW_BOOT_OK"),
        },
        {
          name: "discover both windows without a presentation anchor",
          match: (request) =>
            request.hasUserInputText(SETUP_PROMPT) && !request.hasUserInputText(ANCHOR_PROMPT),
          expectedCalls: 2,
          maximumCalls: 2,
          respond: (request, index) => {
            if (index === 0)
              return nativeCall(request, "multiwindow_setup", [
                "const discovery = unwrap(await tools.mcp__nodex_app__get_session_context({})); text({discovery});",
                `const firstTarget = discovery.presentation.candidates.find(target => target.windowSessionId === ${JSON.stringify(firstWindowId)}); const secondTarget = discovery.presentation.candidates.find(target => target.windowSessionId === ${JSON.stringify(secondWindowId)});`,
                'if (!firstTarget || !secondTarget) throw new Error("Both window candidates are required");',
                "const context = async target => unwrap(await tools.mcp__nodex_app__get_session_context({target}));",
                'const openPage = async (target, pageId) => { const observed = await context(target); const groups = unwrap(await tools.mcp__nodex_app__list_tab_groups({observationId:observed.presentation.observationId})); return unwrap(await tools.mcp__nodex_app__open_tab({observationId:observed.presentation.observationId,panelId:"right",groupId:groups.items.find(group => group.panelId === "right").groupId,target:{kind:"page",pageId}})); };',
                `text({openedOriginal:await openPage(firstTarget, ${JSON.stringify(originalPageId)})});`,
                `text({openedReplacement:await openPage(firstTarget, ${JSON.stringify(replacementPageId)})});`,
                `text({openedOther:await openPage(secondTarget, ${JSON.stringify(otherWindowPageId)})});`,
                "const firstBeforeSelect = await context(firstTarget); const firstTabs = unwrap(await tools.mcp__nodex_app__list_session_tabs({observationId:firstBeforeSelect.presentation.observationId})); text({firstTabs});",
                `text({activatedOriginal:unwrap(await tools.mcp__nodex_app__activate_tab({observationId:firstBeforeSelect.presentation.observationId,tabId:firstTabs.items.find(tab => tab.pageId === ${JSON.stringify(originalPageId)}).tabId}))});`,
                "text({first:await context(firstTarget)}); text({second:await context(secondTarget)});",
                "const secondObserved = await context(secondTarget); text({secondTabs:unwrap(await tools.mcp__nodex_app__list_session_tabs({observationId:secondObserved.presentation.observationId}))});",
              ]);
            const records = toolOutputRecords(request, "multiwindow_setup");
            const discovery = namedOutput(records, "discovery");
            expect(discovery).toMatchObject({
              sessionId,
              presentation: {
                status: "ambiguous_window",
                candidates: expect.arrayContaining([
                  expect.objectContaining({
                    windowSessionId: firstWindowId,
                    sceneOwner: { kind: "session", sessionId },
                  }),
                  expect.objectContaining({
                    windowSessionId: secondWindowId,
                    sceneOwner: { kind: "session", sessionId },
                  }),
                ]),
              },
            });
            expect(
              requireRecord(discovery.presentation, "discovery presentation"),
            ).not.toHaveProperty("observationId");
            for (const name of [
              "openedOriginal",
              "openedReplacement",
              "openedOther",
              "activatedOriginal",
            ]) {
              expect(namedOutput(records, name)).toMatchObject({ applied: true, persisted: true });
            }
            expect(namedOutput(records, "first")).toMatchObject({
              sessionId,
              presentation: {
                origin: "explicit",
                reference: { windowSessionId: firstWindowId },
                selectedTabs: expect.arrayContaining([
                  expect.objectContaining({ pageId: originalPageId }),
                ]),
              },
            });
            const second = namedOutput(records, "second");
            expect(second).toMatchObject({
              sessionId,
              presentation: {
                origin: "explicit",
                reference: { windowSessionId: secondWindowId },
                selectedTabs: expect.arrayContaining([
                  expect.objectContaining({ pageId: otherWindowPageId }),
                ]),
              },
            });
            const firstTabs = namedOutput(records, "firstTabs").items;
            const secondTabs = namedOutput(records, "secondTabs").items;
            expect(firstTabs).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ pageId: originalPageId }),
                expect.objectContaining({ pageId: replacementPageId }),
              ]),
            );
            expect(firstTabs).not.toEqual(
              expect.arrayContaining([expect.objectContaining({ pageId: otherWindowPageId })]),
            );
            expect(secondTabs).toEqual(
              expect.arrayContaining([expect.objectContaining({ pageId: otherWindowPageId })]),
            );
            expect(secondTabs).not.toEqual(
              expect.arrayContaining([expect.objectContaining({ pageId: originalPageId })]),
            );
            otherReference = requireRecord(second.presentation, "second presentation")
              .reference as WorkbenchSceneReference;
            return finalResponse("multiwindow_setup_final", "WORKBENCH_MULTIWINDOW_SETUP_OK");
          },
        },
        {
          name: "retain the submission anchor across tab and window focus changes",
          match: (request) => request.hasUserInputText(ANCHOR_PROMPT),
          expectedCalls: 3,
          maximumCalls: 3,
          respond: async (request, index) => {
            if (index === 0)
              return nativeCall(request, "multiwindow_anchor_before", [
                "const initial = unwrap(await tools.mcp__nodex_app__get_session_context({})); text({initial});",
                "text({firstPage:unwrap(await tools.mcp__nodex_app__list_session_tabs({observationId:initial.presentation.observationId,limit:1}))});",
              ]);
            if (index === 1) {
              const records = toolOutputRecords(request, "multiwindow_anchor_before");
              const initial = namedOutput(records, "initial");
              expect(initial).toMatchObject({
                sessionId,
                presentation: {
                  status: "available",
                  origin: "submission",
                  reference: { windowSessionId: firstWindowId },
                  selectedTabsSource: "submission",
                  selectedTabs: expect.arrayContaining([
                    expect.objectContaining({ pageId: originalPageId }),
                  ]),
                },
              });
              const observationId = requireRecord(
                initial.presentation,
                "initial presentation",
              ).observationId;
              const cursor = namedOutput(records, "firstPage").nextCursor;
              expect(typeof cursor).toBe("string");
              await switched;
              return nativeCall(request, "multiwindow_anchor_after", [
                `text({staleCursor:unwrap(await tools.mcp__nodex_app__list_session_tabs({observationId:${JSON.stringify(observationId)},cursor:${JSON.stringify(cursor)},limit:1}))});`,
                "text({anchored:unwrap(await tools.mcp__nodex_app__get_session_context({}))});",
                'text({refreshed:unwrap(await tools.mcp__nodex_app__get_session_context({mode:"refresh"}))});',
                "text({anchoredAgain:unwrap(await tools.mcp__nodex_app__get_session_context({}))});",
                `text({other:unwrap(await tools.mcp__nodex_app__get_session_context({target:${JSON.stringify(otherReference)}}))});`,
              ]);
            }
            const records = toolOutputRecords(request, "multiwindow_anchor_after");
            expect(namedOutput(records, "staleCursor")).toMatchObject({
              error: { code: "stale_presentation" },
            });
            for (const name of ["anchored", "anchoredAgain"]) {
              const anchored = namedOutput(records, name);
              expect(anchored).toMatchObject({
                sessionId,
                presentation: {
                  origin: "submission",
                  reference: {
                    windowSessionId: firstWindowId,
                    sceneOwner: { kind: "session", sessionId },
                  },
                  changedSinceSubmission: true,
                  selectedTabsSource: "submission",
                  selectedTabs: expect.arrayContaining([
                    expect.objectContaining({ pageId: originalPageId }),
                  ]),
                },
              });
              for (const pageId of [replacementPageId, otherWindowPageId]) {
                expect(requireRecord(anchored.presentation, name).selectedTabs).not.toEqual(
                  expect.arrayContaining([expect.objectContaining({ pageId })]),
                );
              }
            }
            expect(namedOutput(records, "refreshed")).toMatchObject({
              sessionId,
              presentation: {
                origin: "refresh",
                reference: { windowSessionId: firstWindowId },
                selectedTabsSource: "observation",
                selectedTabs: expect.arrayContaining([
                  expect.objectContaining({ pageId: replacementPageId }),
                ]),
              },
            });
            expect(namedOutput(records, "other")).toMatchObject({
              sessionId,
              presentation: {
                origin: "explicit",
                reference: { windowSessionId: secondWindowId },
                selectedTabs: expect.arrayContaining([
                  expect.objectContaining({ pageId: otherWindowPageId }),
                ]),
              },
            });
            return finalResponse("multiwindow_anchor_final", "WORKBENCH_MULTIWINDOW_ANCHOR_OK");
          },
        },
      ],
    },
    async (model) => {
      const harness = await ElectronScenarioHarness.create({
        label: "native-workbench-multiwindow",
        cwd: process.cwd(),
        prepareAgentRuntime: false,
        environment: {
          ...model.loopbackEnvironment(),
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
          NODEX_LOG_FILE: "1",
          NODEX_LOG_CONSOLE: "0",
        },
      });
      writeFileSync(
        join(harness.profile.codexHome, "config.toml"),
        `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${model.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\n`,
        { mode: 0o600 },
      );
      let threadId: string | null = null;
      try {
        const first = await harness.launch();
        await setAgentExecutionProfile(first, { preferredModelId: "gpt-5.6-sol" });
        const draft = await createAgentSmokeDraft(
          first,
          harness.profile.initialProjectsDirectory,
          "Two windows",
        );
        sessionId = draft.projectSessionId;
        const seed = new RendererIpcSeedAdapter(first);
        for (const [pageId, title] of [
          [originalPageId, "Original Page"],
          [replacementPageId, "Replacement Page"],
          [otherWindowPageId, "Other Window Page"],
        ] as const) {
          await seed.createPage({
            key: pageId,
            pageId,
            operationId: createUuidV7(),
            projectId: draft.projectId,
            status: "plan",
            title,
            nfm: `Content owned by ${title}.`,
          });
        }
        await invokeIpc(first, "codex:permission:mode:set", draft.projectId, "full-access");
        threadId = await sendAgentPrompt(first, sessionId, BOOT_PROMPT);
        await waitForFinalMarker(first, "WORKBENCH_MULTIWINDOW_BOOT_OK");
        await waitForCompletedAgentTurn(first, threadId, 30_000);

        const opened = harness.application.waitForEvent("window");
        expect(
          await invokeIpc(first, "window:new", {
            activeProjectSessionId: sessionId,
            activeProjectId: draft.projectId,
          }),
        ).toBe(true);
        const second = await opened;
        await second.waitForURL((url) => url.protocol !== "about:");
        await second.waitForLoadState("domcontentloaded");
        await second.evaluate(() => window.api?.awaitInitialization?.());
        await expect(
          second.getByRole("button", { name: "Hide sidebar", exact: true }),
        ).toBeVisible();
        firstWindowId = (
          (await invokeIpc(first, "window-sessions:bootstrap")) as WindowSessionBootstrap
        ).session.id;
        secondWindowId = (
          (await invokeIpc(second, "window-sessions:bootstrap")) as WindowSessionBootstrap
        ).session.id;
        expect(firstWindowId).not.toBe(secondWindowId);

        // This public ingress intentionally has no presentation ticket, as with a non-UI follow-up.
        await invokeIpc(first, "codex:turn:start", threadId, SETUP_PROMPT);
        await waitForFinalMarker(first, "WORKBENCH_MULTIWINDOW_SETUP_OK");
        await waitForCompletedAgentTurn(first, threadId, 30_000);
        await expect(
          first.getByRole("tab", { name: "Original Page", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
          second.getByRole("tab", { name: "Other Window Page", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
          first.getByRole("tab", { name: "Other Window Page", exact: true }),
        ).toHaveCount(0);
        await expect(second.getByRole("tab", { name: "Original Page", exact: true })).toHaveCount(
          0,
        );

        await first.bringToFront();
        const followUpComposer = first.locator(
          '[data-codex-composer="true"][aria-label="Ask for follow-up changes"]',
        );
        await expect(followUpComposer).toBeVisible();
        await followUpComposer.fill(ANCHOR_PROMPT);
        await first.getByRole("button", { name: "Send prompt", exact: true }).click();
        await model.waitForRequest(
          (request) => request.hasToolCallOutput("multiwindow_anchor_before"),
          30_000,
        );
        await first.getByRole("tab", { name: "Replacement Page", exact: true }).click();
        await expect(
          first.getByRole("tab", { name: "Replacement Page", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        const otherNativeWindow = await harness.application.browserWindow(second);
        await otherNativeWindow.evaluate((window) => window.focus());
        await second.bringToFront();
        finishSwitch();

        await waitForFinalMarker(first, "WORKBENCH_MULTIWINDOW_ANCHOR_OK");
        await waitForFinalMarker(second, "WORKBENCH_MULTIWINDOW_ANCHOR_OK", 10_000);
        await waitForCompletedAgentTurn(first, threadId, 30_000);
        await expect(
          first.getByRole("tab", { name: "Replacement Page", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
          second.getByRole("tab", { name: "Other Window Page", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        expect(await readBoundedElectronRuntimeLogs(harness.profile)).not.toContain(
          '"msg":"Renderer delivery failed"',
        );
      } catch (error) {
        const windows = await Promise.all(
          harness.application.windows().map(async (page) => ({
            url: page.url(),
            text: await page
              .locator("body")
              .innerText()
              .then((text) => text.slice(0, 6000))
              .catch(() => "unavailable"),
            windowSession: await invokeIpc(page, "window-sessions:bootstrap")
              .then((result) => {
                const { session } = result as WindowSessionBootstrap;
                return {
                  id: session.id,
                  location: session.layout.location,
                  layoutRevision: session.layoutRevision,
                };
              })
              .catch(() => null),
          })),
        );
        const snapshot = threadId
          ? await invokeIpc(harness.page, "codex:thread:snapshot:request", threadId).catch(
              () => null,
            )
          : null;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nWINDOWS:${JSON.stringify(windows)}\n${JSON.stringify(snapshot).slice(-36_000)}\n${model.transcript()}\n${await readBoundedElectronRuntimeLogs(harness.profile)}`,
          { cause: error },
        );
      } finally {
        finishSwitch();
        await harness.close();
      }
    },
  );
});
