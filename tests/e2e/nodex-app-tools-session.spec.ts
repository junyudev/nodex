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
  invokeIpc,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForCompletedAgentTurn,
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
          match: (request) =>
            request.hasUserInputText(`APP_CONTEXT_${phase}`) &&
            (phase === "restored" || !request.hasUserInputText("APP_CONTEXT_restored")),
          expectedCalls: 2,
          maximumCalls: 2,
          respond: (request, index) => {
            const callId = `app_context_${phase}`;
            if (index === 0) {
              const tool = request.toolInvocation("functions", "exec");
              expect(tool).not.toBeNull();
              return responses.stream([
                responses.created(`${phase}_call`),
                responses.customToolCall(
                  callId,
                  tool!.name,
                  [
                    // Omit storage receipts so the complete workflow fits in the tool output budget.
                    '// @exec: {"yield_time_ms": 60000, "max_output_tokens": 30000}',
                    'const unwrap = r => { const v = typeof r === "string" ? JSON.parse(r) : r; return JSON.parse(JSON.stringify(v.structuredContent ?? (v.content ? JSON.parse(v.content[0].text) : v), (key, value) => key === "receipt" ? undefined : value)); };',
                    'text(unwrap(await tools.mcp__nodex_app__get_session_context({}))); text(unwrap(await tools.mcp__nodex_app__list_projects({}))); text(unwrap(await tools.mcp__nodex_app__get_app_capabilities({}))); text(unwrap(await tools.mcp__nodex_app__describe_content_schema({scope:{},relation:"pages"}))); text(unwrap(await tools.mcp__nodex_app__query_content({scope:{},sql:"SELECT count(*) AS page_count FROM pages"})));',
                    "text(unwrap(await tools.mcp__nodex_app__read_session({turnLimit:1,maxOutputCharsPerItem:100})));",
                    `const launchArgs = {prompt:"APP_CHILD_${phase}",title:"MCP child ${phase}",target:{type:"project",projectId:${JSON.stringify(projectId)},environment:{type:"local"}},model:"gpt-5.6-sol"};`,
                    "const child = unwrap(await tools.mcp__nodex_app__create_session(launchArgs)); text({createdChild:child});",
                    "text({replayedChild:unwrap(await tools.mcp__nodex_app__create_session({...launchArgs,operationId:child.operationId}))});",
                    "text({childWait:unwrap(await tools.mcp__nodex_app__wait_sessions({targets:[{sessionId:child.sessionId}],timeoutMs:30000}))});",
                    "text({childHistory:unwrap(await tools.mcp__nodex_app__read_session({sessionId:child.sessionId,turnLimit:1}))});",
                    `const messageArgs = {sessionId:child.sessionId,prompt:"APP_FOLLOWUP_${phase}"};`,
                    "const sent = unwrap(await tools.mcp__nodex_app__send_message_to_session(messageArgs)); text({sentMessage:sent});",
                    "text({replayedMessage:unwrap(await tools.mcp__nodex_app__send_message_to_session({...messageArgs,operationId:sent.operationId}))});",
                    "text({followupWait:unwrap(await tools.mcp__nodex_app__wait_sessions({targets:[{sessionId:child.sessionId}],timeoutMs:30000}))});",
                    "text({followupHistory:unwrap(await tools.mcp__nodex_app__read_session({sessionId:child.sessionId,turnLimit:2}))});",
                    "const forkArgs = {sessionId:child.sessionId}; const forked = unwrap(await tools.mcp__nodex_app__fork_session(forkArgs)); text({forkedChild:forked});",
                    "text({replayedFork:unwrap(await tools.mcp__nodex_app__fork_session({...forkArgs,operationId:forked.operationId}))});",
                    `text({forkMessage:unwrap(await tools.mcp__nodex_app__send_message_to_session({sessionId:forked.sessionId,prompt:"APP_FORK_${phase}"}))});`,
                    "text({forkWait:unwrap(await tools.mcp__nodex_app__wait_sessions({targets:[{sessionId:forked.sessionId}],timeoutMs:30000}))});",
                    "text({forkHistory:unwrap(await tools.mcp__nodex_app__read_session({sessionId:forked.sessionId,turnLimit:1}))});",

                    ...(retainedHandoff
                      ? [
                          `text({retainedHandoff:unwrap(await tools.mcp__nodex_app__get_handoff_status(${JSON.stringify(retainedHandoff)}))});`,
                          `text({retainedReplay:unwrap(await tools.mcp__nodex_app__handoff_session(${JSON.stringify(retainedHandoff)}))});`,
                        ]
                      : []),
                    "const moved = unwrap(await tools.mcp__nodex_app__handoff_session({sessionId:child.sessionId})); text({startedHandoff:moved});",
                    "let progress = moved.operation; for (let attempt = 0; attempt < 20 && progress?.status === 'running'; attempt++) { const observed = unwrap(await tools.mcp__nodex_app__get_handoff_status({sessionId:child.sessionId,operationId:moved.operationId,afterRevision:progress.revision,waitMs:30000})); progress = observed.operation; } text({handoffOutcome:progress});",
                    "text({replayedHandoff:unwrap(await tools.mcp__nodex_app__handoff_session({sessionId:child.sessionId,operationId:moved.operationId}))});",

                    `const created = unwrap(await tools.mcp__nodex_app__create_sidebar_section({name:${JSON.stringify(`MCP section ${phase}`)}})); text(created);`,
                    `text(unwrap(await tools.mcp__nodex_app__move_session_to_sidebar_section({sessionId:${JSON.stringify(threadlessSessionId)},sectionId:created.section.sectionId})));`,
                    `text(unwrap(await tools.mcp__nodex_app__move_project_to_sidebar_section({projectId:${JSON.stringify(projectId)},sectionId:created.section.sectionId})));`,
                    "const placementWindow = unwrap(await tools.mcp__nodex_app__list_sidebar_section_items({sectionId:created.section.sectionId})); text({mixedBefore:placementWindow});",
                    "const orderArgs = {sectionId:created.section.sectionId,items:placementWindow.items.slice().reverse().map(item => ({placementId:item.placementId,expectedRevision:item.revision,expectedRankKey:item.rankKey}))}; const reordered = unwrap(await tools.mcp__nodex_app__reorder_section(orderArgs)); text({mixedReorder:reordered});",
                    "text({mixedReplay:unwrap(await tools.mcp__nodex_app__reorder_section({...orderArgs,operationId:reordered.operationId}))});",
                    "text({mixedAfter:unwrap(await tools.mcp__nodex_app__list_sidebar_section_items({sectionId:created.section.sectionId}))});",
                    `text(unwrap(await tools.mcp__nodex_app__set_session_title({sessionId:${JSON.stringify(threadlessSessionId)},title:"MCP draft ${phase}"})));`,
                    `text(unwrap(await tools.mcp__nodex_app__read_session({sessionId:${JSON.stringify(threadlessSessionId)}})));`,
                    `const observed = unwrap(await tools.mcp__nodex_app__wait_sessions({targets:[{sessionId:${JSON.stringify(threadlessSessionId)}}],timeoutMs:0})); text({draftWait:observed});`,
                    `text({unchangedWait:unwrap(await tools.mcp__nodex_app__wait_sessions({targets:[{sessionId:${JSON.stringify(threadlessSessionId)},afterCursor:observed.targets[0].cursor}],timeoutMs:1}))});`,
                    `const active = unwrap(await tools.mcp__nodex_app__list_sessions({limit:50})); text({activeDraft:active.sessions.find(s => s.sessionId === ${JSON.stringify(threadlessSessionId)})});`,
                    `text(unwrap(await tools.mcp__nodex_app__set_session_archived({sessionId:${JSON.stringify(threadlessSessionId)},archived:true})));`,
                    `const archived = unwrap(await tools.mcp__nodex_app__list_archived_sessions({limit:50})); text({archivedDraft:archived.sessions.find(s => s.sessionId === ${JSON.stringify(threadlessSessionId)})});`,
                    `text(unwrap(await tools.mcp__nodex_app__set_session_archived({sessionId:${JSON.stringify(threadlessSessionId)},archived:false})));`,
                    'const renamed = unwrap(await tools.mcp__nodex_app__rename_sidebar_section({sectionId:created.section.sectionId,expectedRevision:created.section.revision,name:"MCP organized"})); text(renamed);',
                    "text(unwrap(await tools.mcp__nodex_app__list_sidebar_sections({first:20})));",
                    "text(unwrap(await tools.mcp__nodex_app__delete_sidebar_section({sectionId:renamed.section.sectionId,expectedRevision:renamed.section.revision})));",
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
            expect(records).toContainEqual(
              expect.objectContaining({
                createdChild: expect.objectContaining({ launchState: "started", projectId }),
              }),
            );
            expect(records).toContainEqual(
              expect.objectContaining({
                replayedChild: expect.objectContaining({ launchState: "attached", replay: true }),
              }),
            );
            expect(
              records.find((record) => record.childWait)?.childWait,
              JSON.stringify(records.find((record) => record.childHistory)),
            ).toMatchObject({
              targets: expect.arrayContaining([
                expect.objectContaining({ disposition: "complete" }),
              ]),
            });
            expect(records.find((record) => record.childHistory)?.childHistory).toMatchObject({
              title: `MCP child ${phase}`,
            });
            expect(records.find((record) => record.sentMessage)?.sentMessage).toMatchObject({
              deliveryState: "started",
              replay: false,
            });
            expect(records.find((record) => record.replayedMessage)?.replayedMessage).toMatchObject(
              { deliveryState: "unconfirmed", replay: true },
            );
            expect(records.find((record) => record.followupWait)?.followupWait).toMatchObject({
              targets: expect.arrayContaining([
                expect.objectContaining({ disposition: "complete" }),
              ]),
            });
            expect(JSON.stringify(records.find((record) => record.followupHistory))).toContain(
              `APP_FOLLOWUP_OK_${phase}`,
            );
            const forked = records.find((record) => record.forkedChild)?.forkedChild as Record<
              string,
              unknown
            >;
            expect(forked).toMatchObject({ forkState: "attached", replay: false });
            expect(records.find((record) => record.replayedFork)?.replayedFork).toMatchObject({
              forkState: "attached",
              replay: true,
              sessionId: forked.sessionId,
            });
            expect(records.find((record) => record.forkWait)?.forkWait).toMatchObject({
              targets: expect.arrayContaining([
                expect.objectContaining({ disposition: "complete" }),
              ]),
            });
            expect(JSON.stringify(records.find((record) => record.forkHistory))).toContain(
              `APP_FORK_OK_${phase}`,
            );
            expect(forkContexts.get(phase)).toMatchObject({
              sessionId: forked.sessionId,
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
          match: (request) => request.hasUserInputText(`APP_FORK_${phase}`),
          expectedCalls: 2,
          maximumCalls: 2,
          respond: (request, index) => {
            const callId = `fork_context_${phase}`;
            if (index === 0) {
              const tool = request.toolInvocation("functions", "exec")!;
              return responses.stream([
                responses.created(`fork_call_${phase}`),
                responses.customToolCall(
                  callId,
                  tool.name,
                  "text(await tools.mcp__nodex_app__get_session_context({}));",
                  tool.namespace,
                ),
                responses.completed(`fork_call_${phase}`),
              ]);
            }
            const context = toolOutputRecords(request.toolCallOutput(callId)).find(
              (record) => typeof record.sessionId === "string",
            );
            expect(context).toBeDefined();
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
        `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${model.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\n`,
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
        await invokeIpc(page, "codex:permission:mode:set", projectId, "full-access");
        await invokeIpc(page, "project-sessions:create", {
          operationId: createBoundedOperationId("e2e.app-tools.threadless"),
          payload: {
            sessionId: threadlessSessionId,
            input: { projectId, noThreadFallbackTitle: "Organize this draft", initialPageIds: [] },
          },
        });
        const threadId = await sendAgentPrompt(page, sessionId, "APP_CONTEXT_initial");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        await waitForFinalMarker(page, "APP_CONTEXT_OK_initial");
        page = await harness.restart();
        const composer = page.locator("[data-codex-composer='true']").first();
        await expect(composer).toBeEditable();
        await composer.fill("APP_CONTEXT_restored");
        await composer.press("Enter");
        await waitForFinalMarker(page, "APP_CONTEXT_OK_restored");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
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
