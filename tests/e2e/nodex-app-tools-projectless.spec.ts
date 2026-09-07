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
  type ScriptedModelExchange,
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

const outputRecords = (value: unknown) =>
  collectRecords(value).flatMap((record) => {
    if (record.type !== "input_text" || typeof record.text !== "string") return [];
    try {
      return collectRecords(JSON.parse(record.text));
    } catch {
      return [];
    }
  });
const unwrap =
  'const unwrap = r => { const v = typeof r === "string" ? JSON.parse(r) : r; return v.structuredContent ?? (v.content ? JSON.parse(v.content[0].text) : v); };';

test("projectless native tools preserve Library authority and Plan Mode through content and Automation operations", async () => {
  test.setTimeout(180_000);
  const pageId = createUuidV7();
  let viewId = "";
  let automationId = "";
  let automationRevision = 0;
  const callerSession = { id: "" };
  await withScriptedModelServer(
    {
      exchanges: ["write", "plan"].map<ScriptedModelExchange>((phase) => ({
        name: `projectless ${phase}`,
        match: (request) =>
          request.hasUserInputText(`PROJECTLESS_${phase}`) &&
          (phase === "plan" || !request.hasUserInputText("PROJECTLESS_plan")),
        expectedCalls: 2,
        maximumCalls: 2,
        respond: (request, index) => {
          const callId = `projectless_${phase}`;
          if (index === 0) {
            const tool = request.toolInvocation("functions", "exec");
            expect(tool).not.toBeNull();
            const common = [
              '// @exec: {"yield_time_ms": 60000, "max_output_tokens": 22000}',
              unwrap,
              "text({context:unwrap(await tools.mcp__nodex_app__get_context({}))});",
              `const fetched=unwrap(await tools.mcp__nodex_app__fetch({id:${JSON.stringify(pageId)},prepareFor:[{kind:"title"},{kind:"body"}]})); text({fetched});`,
            ];
            const script =
              phase === "write"
                ? [
                    ...common,
                    `text({updated:unwrap(await tools.mcp__nodex_app__update_page({pageId:${JSON.stringify(pageId)},body:{kind:"patch",ifMatch:fetched.data.content.etag,patches:[{oldMarkdown:"Original projectless content.",newMarkdown:"Updated without an actor Project."}]}}))});`,
                    'text({created:unwrap(await tools.mcp__nodex_app__create_pages({destination:{kind:"library"},pages:[{title:"Created without a Project",markdown:"Independent Library Page."}],return:["etags"]}))});',
                    'text({sql:unwrap(await tools.mcp__nodex_app__query_content({scope:{},sql:"SELECT title FROM pages",parameters:{}}))});',
                    "text({schema:unwrap(await tools.mcp__nodex_app__describe_content_schema({scope:{}}))});",
                    'const cron={kind:"cron",name:"Projectless review",prompt:"Review this independent task",rrule:"FREQ=YEARLY",projectId:null,cwds:[],executionEnvironment:"local"}; const automation=unwrap(await tools.mcp__nodex_app__automation_update({mode:"create",...cron})); text({automation});',
                    'text({automationUpdated:unwrap(await tools.mcp__nodex_app__automation_update({...cron,mode:"update",id:automation.item.id,expectedRevision:automation.item.definitionRevision,status:"PAUSED",name:"Projectless paused review"}))});',
                    "const context=unwrap(await tools.mcp__nodex_app__get_session_context({})); text({session:context}); const groups=unwrap(await tools.mcp__nodex_app__list_tab_groups({observationId:context.presentation.observationId}));",
                    `text({opened:unwrap(await tools.mcp__nodex_app__open_tab({observationId:context.presentation.observationId,panelId:"right",groupId:groups.items.find(g=>g.panelId==="right").groupId,target:{kind:"view",viewId:${JSON.stringify(viewId)}}}))});`,
                    'const current=unwrap(await tools.mcp__nodex_app__get_session_context({mode:"refresh"})); const tabs=unwrap(await tools.mcp__nodex_app__list_session_tabs({observationId:current.presentation.observationId}));',
                    `const target=tabs.items.find(t=>t.viewId===${JSON.stringify(viewId)}); if(!target) throw new Error(JSON.stringify(tabs)); text({view:unwrap(await tools.mcp__nodex_app__query_displayed_view({observationId:current.presentation.observationId,tabId:target.tabId,propertyIds:["status"]}))});`,
                  ]
                : [
                    ...common,
                    `text({deniedWrite:unwrap(await tools.mcp__nodex_app__update_page({pageId:${JSON.stringify(pageId)},body:{kind:"replace",ifMatch:fetched.data.content.etag,markdown:"Forbidden Plan write"}}))});`,
                    `text({automationRead:unwrap(await tools.mcp__nodex_app__automation_update({mode:"view",id:${JSON.stringify(automationId)}}))});`,
                    `text({deniedAutomation:unwrap(await tools.mcp__nodex_app__automation_update({mode:"delete",id:${JSON.stringify(automationId)},expectedRevision:${automationRevision}}))});`,
                  ];
            return responses.stream([
              responses.created(callId),
              responses.customToolCall(callId, tool!.name, script.join("\n"), tool!.namespace),
              responses.completed(callId),
            ]);
          }
          const records = outputRecords(request.toolCallOutput(callId));
          const result = (label: string) =>
            requireRecord(records.find((record) => record[label])?.[label], label);
          expect(result("context")).toMatchObject({ data: { project: null } });
          expect(result("fetched")).toHaveProperty("data.resource");
          if (phase === "write") {
            expect(result("updated")).toHaveProperty("data");
            expect(result("created")).toHaveProperty("data.pages");
            expect(result("sql")).toEqual({ error: { code: "project_context_required" } });
            expect(result("schema")).toEqual({ error: { code: "project_context_required" } });
            expect(result("session")).toMatchObject({
              projectId: null,
              executionProjectId: null,
              sessionId: callerSession.id,
            });
            expect(result("view")).toMatchObject({
              status: "ready",
              kind: "database_view",
              query: { result: { returned_count: 1 } },
            });
            const saved = requireRecord(result("automationUpdated").item, "saved Automation");
            expect(saved).toMatchObject({
              projectId: null,
              status: "PAUSED",
              name: "Projectless paused review",
            });
            automationId = saved.id as string;
            automationRevision = saved.definitionRevision as number;
          } else {
            expect(result("deniedWrite")).toMatchObject({
              error: { code: "authorization_denied" },
            });
            expect(result("deniedAutomation")).toEqual({ error: { code: "read_only_turn" } });
            expect(result("automationRead")).toMatchObject({
              item: { id: automationId, projectId: null },
            });
          }
          return responses.stream([
            responses.created(`${callId}_final`),
            responses.assistantMessage(
              `${callId}_answer`,
              `PROJECTLESS_${phase}_OK`,
              "final_answer",
            ),
            responses.completed(`${callId}_final`, true),
          ]);
        },
      })),
    },
    async (model) => {
      const harness = await ElectronScenarioHarness.create({
        label: "native-projectless-authority",
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
        const seedProject = await createAgentSmokeDraft(
          page,
          harness.profile.initialProjectsDirectory,
          "Content fixture",
        );
        const seed = new RendererIpcSeedAdapter(page);
        await seed.createPage({
          key: "target",
          pageId,
          operationId: createUuidV7(),
          projectId: seedProject.projectId,
          title: "Projectless content",
          status: "build",
          nfm: "Original projectless content.",
        });
        const database = await seed.readDatabase({
          projectId: seedProject.projectId,
          read: { target: { kind: "project_default" }, mode: "database" },
        });
        if (!database.ok || database.value.value.kind !== "database")
          throw new Error("Expected fixture Database");
        viewId = database.value.value.value.views.find((view) => view.isDefault)!.viewId;
        const newProjectlessChat = page.getByRole("button", {
          name: "New projectless chat",
          exact: true,
        });
        await newProjectlessChat.focus();
        await newProjectlessChat.press("Enter");
        await expect
          .poll(async () => {
            const window = requireRecord(
              await invokeIpc(page, "workspace:tasks:list", null, { first: 20 }),
              "projectless tasks",
            );
            const draft = collectRecords(window.items).find(
              (item) =>
                item.projectId === null && item.thread === null && typeof item.id === "string",
            );
            callerSession.id = typeof draft?.id === "string" ? draft.id : "";
            return callerSession.id;
          })
          .not.toBe("");
        await invokeIpc(page, "codex:permission:mode:set", null, "full-access");
        threadId = await sendAgentPrompt(page, callerSession.id, "PROJECTLESS_write");
        await waitForFinalMarker(page, "PROJECTLESS_write_OK");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        const composer = page.locator('[data-codex-composer="true"]:visible');
        await composer.focus();
        await composer.press("Shift+Tab");
        await expect(page.getByLabel("Plan", { exact: true })).toBeVisible();
        await composer.fill("PROJECTLESS_plan");
        await page.getByRole("button", { name: "Send prompt", exact: true }).click();
        await waitForFinalMarker(page, "PROJECTLESS_plan_OK");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        expect((await seed.readPage(seedProject.projectId, pageId)).title).toBe(
          "Projectless content",
        );
      } catch (error) {
        const snapshot = threadId
          ? await invokeIpc(harness.page, "codex:thread:snapshot:request", threadId).catch(
              () => null,
            )
          : null;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(snapshot).slice(-36_000)}\n${await readBoundedElectronRuntimeLogs(harness.profile)}`,
          { cause: error },
        );
      } finally {
        await harness.close();
      }
    },
  );
});
