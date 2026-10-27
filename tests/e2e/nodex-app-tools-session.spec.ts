import { nativeAppToolCall, nativeCodeTool } from "./support/native-app-tools";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  type ScriptedModelExchange,
  withScriptedModelServer,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  createAgentSmokeDraft,
  collectRecords,
  requireRecord,
  invokeIpc,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForRuntimeCompletedAgentTurn,
  waitForFinalMarker,
} from "./support/agent-smoke-harness";

const toolOutputRecords = (output: unknown) =>
  collectRecords(output).flatMap((record) => {
    if (record.type !== "input_text" || typeof record.text !== "string") return [];
    try {
      return collectRecords(JSON.parse(record.text));
    } catch {
      return [];
    }
  });

const observedRunIds = (value: unknown): string[] => {
  const observation = requireRecord(value, "Session observation");
  const history = requireRecord(observation.history, "Session history");
  expect(history.availability).toBe("available");
  if (!Array.isArray(history.items)) throw new Error("Expected bounded Session history items");
  const runIds = history.items.map((item) => {
    const runId = requireRecord(item, "Session history item").runId;
    if (typeof runId !== "string") throw new Error("Expected Session Run identity");
    return runId;
  });
  return [...new Set(runIds)];
};

test("reads its Session through native MCP before and after restarting Nodex", async () => {
  test.setTimeout(200_000);
  let sessionId = "";
  let projectId = "";
  const forkContexts = new Map<string, Record<string, unknown>>();
  let retainedHandoff: { sessionId: string; operationId: string } | null = null;
  const threadlessSessionId = createUuidV7();
  await withScriptedModelServer(
    {
      exchanges: [
        ...["initial", "restored"].map<ScriptedModelExchange>((phase) => ({
          name: `native application context ${phase}`,
          match: (request) => {
            const callId = `app_context_${phase}`;
            return (
              (request.hasUserInputText(`APP_CONTEXT_${phase}`) &&
                (phase === "restored" || !request.hasUserInputText("APP_CONTEXT_restored"))) ||
              request.toolCallOutput(callId) !== null
            );
          },
          expectedCalls: 2,
          maximumCalls: 2,
          respond: (request, index) => {
            const callId = `app_context_${phase}`;
            if (index === 0) {
              const tool = nativeCodeTool(request);
              return responses.stream([
                responses.created(`${phase}_call`),
                nativeAppToolCall(
                  callId,
                  tool!.name,
                  [
                    // Print workflow assertions without repeated execution summaries or opaque continuation bytes.
                    '// @exec: {"yield_time_ms": 60000, "max_output_tokens": 30000}',
                    'const unwrap = r => { const v = typeof r === "string" ? JSON.parse(r) : r; return JSON.parse(JSON.stringify(v.structuredContent ?? (v.content ? JSON.parse(v.content[0].text) : v), (key, value) => key === "receipt" ? undefined : value)); };',
                    'const emit = value => text(JSON.parse(JSON.stringify(value, (key, value) => ["receipt","execution","nextCursor","tailCursor"].includes(key) ? undefined : value)));',
                    'emit(unwrap(await app.get_session_context({}))); emit(unwrap(await app.list_projects({}))); emit(unwrap(await app.get_app_capabilities({}))); emit(unwrap(await app.describe_content_schema({scope:{},relation:"pages"}))); emit(unwrap(await app.query_content({scope:{},sql:"SELECT count(*) AS page_count FROM pages"})));',
                    "emit(unwrap(await app.read_session({limit:1,maxCharsPerItem:100})));",
                    `const launchArgs = {prompt:"APP_CHILD_${phase}",title:"MCP child ${phase}",target:{type:"project",projectId:${JSON.stringify(projectId)},environment:{type:"local"}},model:"gpt-5.6-sol"};`,
                    'const rawChild = await app.create_session(launchArgs); const childOutput=typeof rawChild==="string"?JSON.parse(rawChild):rawChild; if(childOutput.isError) emit({childFailure:childOutput}); const child=unwrap(childOutput); emit({createdChild:child});',
                    "emit({replayedChild:unwrap(await app.create_session({...launchArgs,operationId:child.operationId}))});",
                    "emit({childWait:unwrap(await app.wait_sessions({targets:[{sessionId:child.sessionId,runId:child.runId}],timeoutMs:30000}))});",
                    "emit({childHistory:unwrap(await app.read_session({sessionId:child.sessionId}))});",
                    `const messageArgs = {sessionId:child.sessionId,prompt:"APP_FOLLOWUP_${phase}"};`,
                    "const sent = unwrap(await app.send_message_to_session(messageArgs)); emit({sentMessage:sent});",
                    "emit({replayedMessage:unwrap(await app.send_message_to_session({...messageArgs,operationId:sent.operationId}))});",
                    "emit({followupWait:unwrap(await app.wait_sessions({targets:[{sessionId:child.sessionId,runId:sent.runId}],timeoutMs:30000}))});",
                    "emit({followupHistory:unwrap(await app.read_session({sessionId:child.sessionId}))});",
                    "const forkArgs = {sessionId:child.sessionId}; const forked = unwrap(await app.fork_session(forkArgs)); emit({forkedChild:forked});",
                    "emit({replayedFork:unwrap(await app.fork_session({...forkArgs,operationId:forked.operationId}))});",
                    `emit({forkMessage:unwrap(await app.send_message_to_session({sessionId:forked.sessionId,prompt:"APP_FORK_${phase}"}))});`,
                    "emit({forkWait:unwrap(await app.wait_sessions({targets:[{sessionId:forked.sessionId}],timeoutMs:30000}))});",
                    "emit({forkHistory:unwrap(await app.read_session({sessionId:forked.sessionId,limit:2}))});",

                    ...(retainedHandoff
                      ? [
                          `emit({retainedHandoff:unwrap(await app.get_handoff_status(${JSON.stringify(retainedHandoff)}))});`,
                          `emit({retainedReplay:unwrap(await app.handoff_session(${JSON.stringify(retainedHandoff)}))});`,
                        ]
                      : []),
                    "const moved = unwrap(await app.handoff_session({sessionId:child.sessionId})); emit({startedHandoff:moved});",
                    "let progress = moved.operation; for (let attempt = 0; attempt < 20 && progress?.status === 'running'; attempt++) { const observed = unwrap(await app.get_handoff_status({sessionId:child.sessionId,operationId:moved.operationId,afterRevision:progress.revision,waitMs:30000})); progress = observed.operation; } emit({handoffOutcome:progress});",
                    "emit({replayedHandoff:unwrap(await app.handoff_session({sessionId:child.sessionId,operationId:moved.operationId}))});",

                    `const created = unwrap(await app.create_sidebar_section({name:${JSON.stringify(`MCP section ${phase}`)}})); emit(created);`,
                    `emit(unwrap(await app.move_session_to_sidebar_section({sessionId:${JSON.stringify(threadlessSessionId)},sectionId:created.section.sectionId})));`,
                    `emit(unwrap(await app.move_project_to_sidebar_section({projectId:${JSON.stringify(projectId)},sectionId:created.section.sectionId})));`,
                    "const placementWindow = unwrap(await app.list_sidebar_section_items({sectionId:created.section.sectionId})); emit({mixedBefore:placementWindow});",
                    "const orderArgs = {sectionId:created.section.sectionId,items:placementWindow.items.slice().reverse().map(item => ({placementId:item.placementId,expectedRevision:item.revision,expectedRankKey:item.rankKey}))}; const reordered = unwrap(await app.reorder_section(orderArgs)); emit({mixedReorder:reordered});",
                    "emit({mixedReplay:unwrap(await app.reorder_section({...orderArgs,operationId:reordered.operationId}))});",
                    "emit({mixedAfter:unwrap(await app.list_sidebar_section_items({sectionId:created.section.sectionId}))});",
                    `emit(unwrap(await app.set_session_title({sessionId:${JSON.stringify(threadlessSessionId)},title:"MCP draft ${phase}"})));`,
                    `emit(unwrap(await app.read_session({sessionId:${JSON.stringify(threadlessSessionId)}})));`,
                    `const observed = unwrap(await app.wait_sessions({targets:[{sessionId:${JSON.stringify(threadlessSessionId)}}],timeoutMs:0})); emit({draftWait:observed});`,
                    `emit({unchangedWait:unwrap(await app.wait_sessions({targets:[{sessionId:${JSON.stringify(threadlessSessionId)},afterCursor:observed.targets[0].cursor}],timeoutMs:1}))});`,
                    `const active = unwrap(await app.list_sessions({limit:50})); emit({activeDraft:active.sessions.find(s => s.sessionId === ${JSON.stringify(threadlessSessionId)})});`,
                    `emit(unwrap(await app.set_session_archived({sessionId:${JSON.stringify(threadlessSessionId)},archived:true})));`,
                    `const archived = unwrap(await app.list_archived_sessions({limit:50})); emit({archivedDraft:archived.sessions.find(s => s.sessionId === ${JSON.stringify(threadlessSessionId)})});`,
                    `emit(unwrap(await app.set_session_archived({sessionId:${JSON.stringify(threadlessSessionId)},archived:false})));`,
                    'const renamed = unwrap(await app.rename_sidebar_section({sectionId:created.section.sectionId,expectedRevision:created.section.revision,name:"MCP organized"})); emit(renamed);',
                    "emit(unwrap(await app.list_sidebar_sections({first:20})));",
                    "emit(unwrap(await app.delete_sidebar_section({sectionId:renamed.section.sectionId,expectedRevision:renamed.section.revision})));",
                  ].join("\n"),
                  tool!.namespace,
                ),
                responses.completed(`${phase}_call`),
              ]);
            }
            const response = request.toolCallOutput(callId);
            const records = toolOutputRecords(response);
            const output = JSON.stringify(response);
            expect(output).toContain(sessionId);
            expect(output).toContain(projectId);
            expect(output).toContain("isGitRepository");
            expect(output).toContain("native_mcp");
            expect(output).toContain("page_count");
            expect(output).toContain("MCP organized");
            expect(records).toContainEqual(expect.objectContaining({ deleted: true }));
            expect(records).toContainEqual(expect.objectContaining({ availability: "available" }));
            expect(records).toContainEqual(expect.objectContaining({ availability: "empty" }));
            expect(records).toContainEqual(
              expect.objectContaining({
                sessionId: threadlessSessionId,
                title: `MCP draft ${phase}`,
              }),
            );
            expect(records).toContainEqual(
              expect.objectContaining({
                activeDraft: expect.objectContaining({
                  sessionId: threadlessSessionId,
                  archived: false,
                  placement: expect.objectContaining({ kind: "section", source: "session" }),
                }),
              }),
            );
            expect(records).toContainEqual(
              expect.objectContaining({
                archivedDraft: expect.objectContaining({
                  sessionId: threadlessSessionId,
                  archived: true,
                }),
              }),
            );
            expect(records).toContainEqual(
              expect.objectContaining({
                draftWait: expect.objectContaining({
                  reason: "snapshot",
                  targets: expect.arrayContaining([
                    expect.objectContaining({
                      changed: true,
                      sessionId: threadlessSessionId,
                      disposition: "complete",
                    }),
                  ]),
                }),
              }),
            );
            expect(records).toContainEqual(
              expect.objectContaining({
                unchangedWait: expect.objectContaining({
                  reason: "timeout",
                  targets: expect.arrayContaining([expect.objectContaining({ changed: false })]),
                }),
              }),
            );
            const createdChild = requireRecord(
              records.find((record) => record.createdChild)?.createdChild,
              "Created child",
            );
            expect(
              createdChild,
              JSON.stringify(records.find((record) => record.childFailure) ?? null).slice(0, 8_000),
            ).toMatchObject({
              launchState: "attached",
              projectId,
              sessionId: expect.any(String),
              threadId: expect.any(String),
              operationId: expect.any(String),
            });
            expect(records.find((record) => record.replayedChild)?.replayedChild).toMatchObject({
              launchState: "attached",
              sessionId: createdChild.sessionId,
              threadId: createdChild.threadId,
              operationId: createdChild.operationId,
            });
            expect(
              records.find((record) => record.childWait)?.childWait,
              JSON.stringify(records.find((record) => record.childHistory)),
            ).toMatchObject({
              targets: expect.arrayContaining([
                expect.objectContaining({ disposition: "complete" }),
              ]),
            });
            const childHistory = records.find((record) => record.childHistory)?.childHistory;
            expect(childHistory).toMatchObject({
              title: `MCP child ${phase}`,
              sessionId: createdChild.sessionId,
              threadId: createdChild.threadId,
            });
            const childRunIds = observedRunIds(childHistory);
            expect(childRunIds).toHaveLength(1);
            const sentMessage = requireRecord(
              records.find((record) => record.sentMessage)?.sentMessage,
              "Accepted message",
            );
            expect(sentMessage).toMatchObject({
              deliveryState: "accepted",
              sessionId: createdChild.sessionId,
              threadId: createdChild.threadId,
              operationId: expect.any(String),
              messageId: expect.any(String),
              runId: expect.any(String),
            });
            expect(records.find((record) => record.replayedMessage)?.replayedMessage).toMatchObject(
              {
                deliveryState: "accepted",
                sessionId: createdChild.sessionId,
                threadId: createdChild.threadId,
                operationId: sentMessage.operationId,
                messageId: sentMessage.messageId,
                runId: sentMessage.runId,
              },
            );
            expect(records.find((record) => record.followupWait)?.followupWait).toMatchObject({
              targets: expect.arrayContaining([
                expect.objectContaining({
                  disposition: "complete",
                  selectedRunId: sentMessage.runId,
                  runId: sentMessage.runId,
                }),
              ]),
            });
            const followupHistory = records.find(
              (record) => record.followupHistory,
            )?.followupHistory;
            expect(followupHistory).toMatchObject({
              sessionId: createdChild.sessionId,
              threadId: createdChild.threadId,
            });
            expect(JSON.stringify(followupHistory)).toContain(`APP_FOLLOWUP_OK_${phase}`);
            const followupRunIds = observedRunIds(followupHistory);
            expect(followupRunIds).toHaveLength(2);
            expect(new Set(followupRunIds).size).toBe(2);
            expect(followupRunIds).toContain(childRunIds[0]);
            const forked = requireRecord(
              records.find((record) => record.forkedChild)?.forkedChild,
              "Forked child",
            );
            expect(forked).toMatchObject({
              forkState: "attached",
              sessionId: expect.any(String),
              threadId: expect.any(String),
              operationId: expect.any(String),
            });
            expect(forked.sessionId).not.toBe(createdChild.sessionId);
            expect(forked.threadId).not.toBe(createdChild.threadId);
            expect(records.find((record) => record.replayedFork)?.replayedFork).toMatchObject({
              forkState: "attached",
              sessionId: forked.sessionId,
              threadId: forked.threadId,
              operationId: forked.operationId,
            });
            expect(records.find((record) => record.forkWait)?.forkWait).toMatchObject({
              targets: expect.arrayContaining([
                expect.objectContaining({ disposition: "complete" }),
              ]),
            });
            const forkHistory = records.find((record) => record.forkHistory)?.forkHistory;
            expect(JSON.stringify(forkHistory)).toContain(`APP_FORK_OK_${phase}`);
            expect(forkHistory).toMatchObject({
              sessionId: forked.sessionId,
              threadId: forked.threadId,
            });
            const forkRunIds = observedRunIds(forkHistory);
            expect(forkRunIds).toHaveLength(1);
            expect(forkContexts.get(phase)).toMatchObject({
              sessionId: forked.sessionId,
              threadId: forked.threadId,
              runId: forkRunIds[0],
              projectId,
            });
            const before = records.find((record) => record.mixedBefore)?.mixedBefore as {
              items: { placementId: string; kind: string }[];
              hasMore: boolean;
            };
            const after = records.find((record) => record.mixedAfter)?.mixedAfter as {
              items: { placementId: string; kind: string }[];
              hasMore: boolean;
            };
            expect(before.hasMore).toBe(false);
            expect(before.items.map((item) => item.kind)).toEqual(["session", "project"]);
            expect(after.items.map((item) => item.placementId)).toEqual(
              before.items.map((item) => item.placementId).reverse(),
            );
            expect(after.hasMore).toBe(false);
            const moved = records.find((record) => record.startedHandoff)?.startedHandoff as {
              sessionId: string;
              operationId: string;
            };
            expect(records.find((record) => record.handoffOutcome)?.handoffOutcome).toMatchObject({
              status: "success",
            });
            expect(records.find((record) => record.replayedHandoff)?.replayedHandoff).toMatchObject(
              { replay: true, operation: { status: "success" } },
            );
            if (phase === "restored") {
              expect(
                records.find((record) => record.retainedHandoff)?.retainedHandoff,
              ).toMatchObject({ ...retainedHandoff, operation: { status: "success" } });
              expect(records.find((record) => record.retainedReplay)?.retainedReplay).toMatchObject(
                { ...retainedHandoff, replay: true, operation: { status: "success" } },
              );
            }
            retainedHandoff = { sessionId: moved.sessionId, operationId: moved.operationId };
            expect(records.some((record) => record.isError === true)).toBe(false);
            expect(records.filter((record) => record.error != null)).toEqual([]);
            expect(records).toContainEqual(
              expect.objectContaining({ sessionId: threadlessSessionId, archived: true }),
            );
            expect(records).toContainEqual(
              expect.objectContaining({ sessionId: threadlessSessionId, archived: false }),
            );
            return responses.stream([
              responses.created(`${phase}_done`),
              responses.assistantMessage(
                `${phase}_answer`,
                `APP_CONTEXT_OK_${phase}`,
                "final_answer",
              ),
              responses.completed(`${phase}_done`, true),
            ]);
          },
        })),
        ...["initial", "restored"].map<ScriptedModelExchange>((phase) => ({
          name: `fork session ${phase}`,
          match: (request) =>
            request.hasUserInputText(`APP_FORK_${phase}`) ||
            request.toolCallOutput(`fork_context_${phase}`) !== null,
          expectedCalls: 2,
          maximumCalls: 2,
          respond: (request, index) => {
            const callId = `fork_context_${phase}`;
            if (index === 0) {
              const tool = nativeCodeTool(request);
              return responses.stream([
                responses.created(`fork_call_${phase}`),
                nativeAppToolCall(
                  callId,
                  tool.name,
                  "text(await app.get_session_context({}));",
                  tool.namespace,
                ),
                responses.completed(`fork_call_${phase}`),
              ]);
            }
            const context = toolOutputRecords(request.toolCallOutput(callId)).find(
              (record) => typeof record.sessionId === "string",
            );
            expect(
              context,
              JSON.stringify(request.toolCallOutput(callId)).slice(0, 12_000),
            ).toBeDefined();
            forkContexts.set(phase, context!);
            return responses.stream([
              responses.created(`fork_done_${phase}`),
              responses.assistantMessage(
                `fork_answer_${phase}`,
                `APP_FORK_OK_${phase}`,
                "final_answer",
              ),
              responses.completed(`fork_done_${phase}`, true),
            ]);
          },
        })),
        ...["initial", "restored"].map<ScriptedModelExchange>((phase) => ({
          name: `followup session ${phase}`,
          match: (request) =>
            request.hasUserInputText(`APP_FOLLOWUP_${phase}`) &&
            !request.hasUserInputText(`APP_FORK_${phase}`),
          expectedCalls: 1,
          maximumCalls: 1,
          respond: () =>
            responses.stream([
              responses.created(`followup_${phase}`),
              responses.assistantMessage(
                `followup_answer_${phase}`,
                `APP_FOLLOWUP_OK_${phase}`,
                "final_answer",
              ),
              responses.completed(`followup_${phase}`, true),
            ]),
        })),
        ...["initial", "restored"].map<ScriptedModelExchange>((phase) => ({
          name: `child session ${phase}`,
          match: (request) =>
            request.hasUserInputText(`APP_CHILD_${phase}`) &&
            !request.hasUserInputText(`APP_FOLLOWUP_${phase}`),
          expectedCalls: 1,
          maximumCalls: 1,
          respond: () =>
            responses.stream([
              responses.created(`child_${phase}`),
              responses.assistantMessage(
                `child_answer_${phase}`,
                `APP_CHILD_OK_${phase}`,
                "final_answer",
              ),
              responses.completed(`child_${phase}`, true),
            ]),
        })),
      ],
    },
    async (model) => {
      const harness = await ElectronScenarioHarness.create({
        label: "native-app-tools-session",
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
        `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${model.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\ncode_mode = true\ncode_mode_only = true\n`,
        { mode: 0o600 },
      );
      try {
        const workspace = harness.profile.initialProjectsDirectory;
        execFileSync("git", ["init", "--initial-branch=main", workspace]);
        execFileSync("git", [
          "-C",
          workspace,
          "-c",
          "user.name=Nodex Test",
          "-c",
          "user.email=test@nodex.local",
          "commit",
          "--allow-empty",
          "-m",
          "Initial workspace",
        ]);
        let page = await harness.launch();
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.6-sol" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.initialProjectsDirectory,
          "Application context",
        );
        sessionId = draft.projectSessionId;
        projectId = draft.projectId;
        await invokeIpc(page, "project-sessions:create", {
          operationId: createBoundedOperationId("e2e.app-tools.threadless"),
          payload: {
            sessionId: threadlessSessionId,
            input: { projectId, noThreadFallbackTitle: "Organize this draft", initialPageIds: [] },
          },
        });
        const threadId = await sendAgentPrompt(page, sessionId, "APP_CONTEXT_initial");
        const initial = await waitForRuntimeCompletedAgentTurn(
          page,
          { sessionId, threadId },
          60_000,
        );
        const providerThreadId = initial.snapshot.projection.thread.activeProviderThreadId;
        const nativeThread = initial.snapshot.projection.providerThreads.find(
          (candidate) => candidate.id === providerThreadId,
        )?.nativeThreadRef;
        expect(nativeThread).toMatchObject({ driver: "codex", nativeId: expect.any(String) });
        await waitForFinalMarker(page, "APP_CONTEXT_OK_initial");
        page = await harness.restart();
        const composer = page.locator("[data-codex-composer='true']").first();
        await expect(composer).toBeEditable();
        await composer.fill("APP_CONTEXT_restored");
        await composer.press("Enter");
        await waitForFinalMarker(page, "APP_CONTEXT_OK_restored");
        const restored = await waitForRuntimeCompletedAgentTurn(
          page,
          { sessionId, threadId },
          60_000,
        );
        expect(restored.snapshot.projection.thread.activeProviderThreadId).toBe(providerThreadId);
        expect(
          restored.snapshot.projection.providerThreads.find(
            (candidate) => candidate.id === providerThreadId,
          )?.nativeThreadRef,
        ).toEqual(nativeThread);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${await readBoundedElectronRuntimeLogs(harness.profile)}`,
          { cause: error },
        );
      } finally {
        await harness.close();
      }
    },
  );
});
