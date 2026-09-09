import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { RendererIpcSeedAdapter } from "../../scripts/scenarios/adapters/renderer-ipc-seed-adapter";
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

const outputRecords = (value: unknown) =>
  collectRecords(value).flatMap((record) => {
    if (record.type !== "input_text" || typeof record.text !== "string") return [];
    try {
      return collectRecords(JSON.parse(record.text));
    } catch {
      return [];
    }
  });

test("native Workbench tools arrange, read and safely edit the exact authorized Page", async () => {
  test.setTimeout(180_000);
  const pageId = createUuidV7();
  const secondPageId = createUuidV7();
  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "native Workbench controls",
          match: (request) => request.hasUserInputText("WORKBENCH_CONTROL_PROBE"),
          expectedCalls: 2,
          maximumCalls: 2,
          respond: (request, index) => {
            if (index === 0) {
              const tool = request.toolInvocation("functions", "exec");
              expect(tool).not.toBeNull();
              return responses.stream([
                responses.created("workbench_control"),
                responses.customToolCall(
                  "workbench_call",
                  tool!.name,
                  [
                    '// @exec: {"yield_time_ms": 60000, "max_output_tokens": 18000}',
                    'const unwrap = r => { const v = typeof r === "string" ? JSON.parse(r) : r; return v.structuredContent ?? (v.content ? JSON.parse(v.content[0].text) : v); };',
                    "const initial = unwrap(await tools.mcp__nodex_app__get_session_context({})); text({initial});",
                    'const groups = unwrap(await tools.mcp__nodex_app__list_tab_groups({observationId:initial.presentation.observationId})); const group = groups.items.find(g=>g.panelId === "right");',
                    `text({opened:unwrap(await tools.mcp__nodex_app__open_tab({observationId:initial.presentation.observationId,panelId:"right",groupId:group.groupId,target:{kind:"page",pageId:${JSON.stringify(pageId)}}}))});`,
                    'const nextContext = unwrap(await tools.mcp__nodex_app__get_session_context({mode:"refresh"})); const nextGroups = unwrap(await tools.mcp__nodex_app__list_tab_groups({observationId:nextContext.presentation.observationId}));',
                    `text({openedSecond:unwrap(await tools.mcp__nodex_app__open_tab({observationId:nextContext.presentation.observationId,panelId:"right",groupId:nextGroups.items.find(g=>g.panelId === "right").groupId,target:{kind:"page",pageId:${JSON.stringify(secondPageId)}}}))});`,
                    'const refreshed = unwrap(await tools.mcp__nodex_app__get_session_context({mode:"refresh"})); const tabs = unwrap(await tools.mcp__nodex_app__list_session_tabs({observationId:refreshed.presentation.observationId})); text({tabs});',
                    `const page = tabs.items.find(t=>t.pageId === ${JSON.stringify(pageId)});`,
                    'text({split:unwrap(await tools.mcp__nodex_app__split_tab_group({observationId:refreshed.presentation.observationId,panelId:"right",groupId:page.groupId,tabId:page.tabId,side:"right"}))});',
                    'const final = unwrap(await tools.mcp__nodex_app__get_session_context({mode:"refresh"})); text({final});',
                    "const finalTabs = unwrap(await tools.mcp__nodex_app__list_session_tabs({observationId:final.presentation.observationId})); const primary = finalTabs.items.find(t=>t.protected);",
                    "text({protectedClose:unwrap(await tools.mcp__nodex_app__close_tab({observationId:final.presentation.observationId,tabId:primary.tabId}))});",
                    `const observedPage = finalTabs.items.find(t=>t.pageId === ${JSON.stringify(pageId)}); const content=unwrap(await tools.mcp__nodex_app__read_tab_content({observationId:final.presentation.observationId,tabId:observedPage.tabId})); text({content}); if(content.status !== "ready") throw new Error(JSON.stringify(content));`,
                    `const patch = {pageId:${JSON.stringify(pageId)},body:{kind:"patch",ifMatch:content.validators.body,patches:[{oldMarkdown:"Keep this Page intact while arranging its view.",newMarkdown:"Keep this Page synchronized while arranging its view."}]}}; text({edited:unwrap(await tools.mcp__nodex_app__update_page(patch))});`,
                    "text({staleEdit:unwrap(await tools.mcp__nodex_app__update_page(patch))});",
                    `text({fetched:unwrap(await tools.mcp__nodex_app__fetch({id:${JSON.stringify(pageId)}}))});`,
                  ].join("\n"),
                  tool!.namespace,
                ),
                responses.completed("workbench_control"),
              ]);
            }
            const records = outputRecords(request.toolCallOutput("workbench_call"));
            expect(records.find((record) => record.initial)?.initial).toMatchObject({
              presentation: { status: "available", origin: "submission" },
            });
            expect(records.find((record) => record.opened)?.opened).toMatchObject({
              applied: true,
              persisted: true,
            });
            expect(records.find((record) => record.split)?.split).toMatchObject({
              applied: true,
              persisted: true,
            });
            expect(records.find((record) => record.tabs)?.tabs).toMatchObject({
              items: expect.arrayContaining([
                expect.objectContaining({ pageId, title: "Workbench Page", status: "authorized" }),
              ]),
            });
            expect(records.find((record) => record.final)?.final).toMatchObject({
              presentation: { groupCount: 3 },
            });
            expect(records.find((record) => record.protectedClose)?.protectedClose).toMatchObject({
              error: { code: "protected_primary" },
            });
            expect(records.find((record) => record.content)?.content).toMatchObject({
              status: "ready",
              kind: "page",
              readiness: "synchronized",
              output: {
                data: {
                  resource: { id: pageId },
                  content: {
                    format: "markdown",
                    markdown: expect.stringContaining("Keep this Page intact"),
                  },
                },
              },
              validators: { body: expect.any(String) },
            });
            expect(records.find((record) => record.edited)?.edited).toHaveProperty("data");
            expect(records.find((record) => record.staleEdit)?.staleEdit).toHaveProperty("error");
            expect(records.find((record) => record.fetched)?.fetched).toMatchObject({
              data: {
                resource: { id: pageId },
                content: {
                  format: "markdown",
                  markdown: expect.stringContaining("Keep this Page synchronized"),
                },
              },
            });
            return responses.stream([
              responses.created("workbench_final"),
              responses.assistantMessage(
                "workbench_answer",
                "WORKBENCH_CONTROL_OK",
                "final_answer",
              ),
              responses.completed("workbench_final", true),
            ]);
          },
        },
      ],
    },
    async (model) => {
      const harness = await ElectronScenarioHarness.create({
        label: "native-workbench-controls",
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
        const page = await harness.launch();
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.6-sol" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.initialProjectsDirectory,
          "Workbench controls",
        );
        const seed = new RendererIpcSeedAdapter(page);
        await seed.createPage({
          key: "page",
          pageId,
          operationId: createUuidV7(),
          projectId: draft.projectId,
          status: "build",
          title: "Workbench Page",
          nfm: "Keep this Page intact while arranging its view.",
        });
        await seed.createPage({
          key: "second",
          pageId: secondPageId,
          operationId: createUuidV7(),
          projectId: draft.projectId,
          status: "plan",
          title: "Companion Page",
          nfm: "This Page stays in the original group.",
        });
        await invokeIpc(page, "codex:permission:mode:set", draft.projectId, "full-access");
        threadId = await sendAgentPrompt(page, draft.projectSessionId, "WORKBENCH_CONTROL_PROBE");
        await waitForFinalMarker(page, "WORKBENCH_CONTROL_OK");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        await expect(page.getByRole("tab", { name: "Workbench Page", exact: true })).toBeVisible();
        expect((await seed.readPage(draft.projectId, pageId)).title).toBe("Workbench Page");
      } catch (error) {
        const snapshot = threadId
          ? await invokeIpc(harness.page, "codex:thread:snapshot:request", threadId).catch(
              () => null,
            )
          : null;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(snapshot).slice(-48_000)}\n${await readBoundedElectronRuntimeLogs(harness.profile)}`,
          { cause: error },
        );
      } finally {
        await harness.close();
      }
    },
  );
});
