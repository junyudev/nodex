import { nativeAppToolCall } from "./support/native-app-tools";
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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
  setAgentExecutionProfile,
  waitForFinalMarker,
} from "./support/agent-smoke-harness";
import { waitForDraftScene } from "./support/new-chat-draft";

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

const waitForCompletedSession = async (page: Page, sessionId: string) => {
  await expect
    .poll(
      async () => {
        const conversation = requireRecord(
          await invokeIpc(page, "agent-runtime:session:control", { sessionId }),
          "Session control",
        );
        const snapshot = requireRecord(conversation.snapshot, "Session snapshot");
        const projection = requireRecord(snapshot.projection, "Session projection");
        return Array.isArray(projection.runs)
          ? requireRecord(projection.runs.at(-1), "Latest Run").status
          : null;
      },
      { timeout: 60_000 },
    )
    .toBe("completed");
};

test("projectless agents use Profile content and Automation tools in both interaction modes", async () => {
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
              "text({context:unwrap(await app.get_context({}))});",
              `const fetched=unwrap(await app.fetch({id:${JSON.stringify(pageId)},prepareFor:[{kind:"title"},{kind:"body"}]})); text({fetched});`,
            ];
            const script =
              phase === "write"
                ? [
                    ...common,
                    `text({updated:unwrap(await app.update_page({pageId:${JSON.stringify(pageId)},body:{kind:"patch",ifMatch:fetched.data.content.etag,patches:[{oldMarkdown:"Original projectless content.",newMarkdown:"Updated without an actor Project."}]}}))});`,
                    'text({created:unwrap(await app.create_pages({destination:{kind:"library"},pages:[{title:"Created without a Project",markdown:"Independent Library Page."}],return:["etags"]}))});',
                    'text({sql:unwrap(await app.query_content({scope:{},sql:"SELECT title FROM pages",parameters:{}}))});',
                    // Table names prove the schema read without spending the output budget on it.
                    "const schema=unwrap(await app.describe_content_schema({scope:{}})); text({schema:{tables:schema.tables.map(t=>t.table)}});",
                    'const cron={kind:"cron",name:"Projectless review",prompt:"Review this independent task",rrule:"FREQ=YEARLY",projectId:null,cwds:[],executionEnvironment:"local"}; const automation=unwrap(await app.automation_update({mode:"create",...cron})); text({automation});',
                    'text({automationUpdated:unwrap(await app.automation_update({...cron,mode:"update",id:automation.item.id,expectedRevision:automation.item.definitionRevision,status:"PAUSED",name:"Projectless paused review"}))});',
                    "const context=unwrap(await app.get_session_context({})); text({session:context}); const groups=unwrap(await app.list_tab_groups({observationId:context.presentation.observationId}));",
                    `text({opened:unwrap(await app.open_tab({observationId:context.presentation.observationId,panelId:"right",groupId:groups.items.find(g=>g.panelId==="right").groupId,target:{kind:"view",viewId:${JSON.stringify(viewId)}}}))});`,
                    'const current=unwrap(await app.get_session_context({mode:"refresh"})); const tabs=unwrap(await app.list_session_tabs({observationId:current.presentation.observationId}));',
                    `const target=tabs.items.find(t=>t.viewId===${JSON.stringify(viewId)}); if(!target) throw new Error(JSON.stringify(tabs)); text({view:unwrap(await app.query_displayed_view({observationId:current.presentation.observationId,tabId:target.tabId,propertyIds:["status"]}))});`,
                  ]
                : [
                    ...common,
                    `text({planWrite:unwrap(await app.update_page({pageId:${JSON.stringify(pageId)},body:{kind:"replace",ifMatch:fetched.data.content.etag,markdown:"Planned content update"}}))});`,
                    `text({automationRead:unwrap(await app.automation_update({mode:"view",id:${JSON.stringify(automationId)}}))});`,
                    `text({deletedAutomation:unwrap(await app.automation_update({mode:"delete",id:${JSON.stringify(automationId)},expectedRevision:${automationRevision}}))});`,
                  ];
            return responses.stream([
              responses.created(callId),
              nativeAppToolCall(callId, tool!.name, script.join("\n"), tool!.namespace),
              responses.completed(callId),
            ]);
          }
          const output = request.toolCallOutput(callId);
          const records = outputRecords(output);
          const result = (label: string) =>
            requireRecord(
              records.find((record) => record[label])?.[label],
              `${label}; tool output: ${JSON.stringify(output).slice(-8_000)}`,
            );
          expect(result("context")).toMatchObject({ data: { project: null } });
          expect(result("fetched")).toHaveProperty("data.resource");
          if (phase === "write") {
            expect(result("updated")).toHaveProperty("data");
            expect(result("created")).toHaveProperty("data.pages");
            expect(result("sql")).toHaveProperty("rows");
            expect(result("schema")).toHaveProperty("tables");
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
            expect(result("planWrite")).toHaveProperty("data");
            expect(result("deletedAutomation")).not.toHaveProperty("error");
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
        label: "native-projectless-content",
        cwd: process.cwd(),
        prepareAgentRuntime: false,
        isolateHostDirectories: true,
        environment: {
          ...model.loopbackEnvironment(),
          OPENAI_API_KEY: "nodex-scripted-model-test-key",
          NODEX_LOG_FILE: "1",
          NODEX_LOG_CONSOLE: "0",
        },
      });
      const workspaceHome = join(harness.profile.runRoot, "home");
      writeFileSync(
        join(harness.profile.codexHome, "config.toml"),
        `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(`${model.baseUrl}/v1`)}\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nrespect_system_proxy = false\n`,
        { mode: 0o600 },
      );
      let threadId: string | null = null;
      let processDiagnostics = "";
      try {
        const page = await harness.launch();
        harness.application.process().stderr?.on("data", (chunk: Buffer) => {
          processDiagnostics = `${processDiagnostics}${chunk.toString("utf8")}`.slice(-16_000);
        });
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
          markdown: "Original projectless content.",
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
        const scene = await waitForDraftScene(page, callerSession.id);
        await setAgentExecutionProfile(page);
        const composer = scene.locator('[data-codex-composer="true"]:visible');
        await composer.fill("PROJECTLESS_write");
        await page.getByRole("button", { name: "Send prompt", exact: true }).click();
        await expect
          .poll(async () => {
            const session = requireRecord(
              await invokeIpc(page, "project-sessions:get", callerSession.id),
              "Product Session",
            );
            const execution =
              session.executionRef && typeof session.executionRef === "object"
                ? requireRecord(session.executionRef, "Execution reference")
                : null;
            threadId = typeof execution?.threadId === "string" ? execution.threadId : null;
            return threadId;
          })
          .toBeTruthy();
        let executionCwd = "";
        await expect
          .poll(async () => {
            const control = requireRecord(
              await invokeIpc(page, "agent-runtime:session:control", {
                sessionId: callerSession.id,
              }),
              "Projectless Session control",
            );
            const snapshot = requireRecord(control.snapshot, "Projectless snapshot");
            const projection = requireRecord(snapshot.projection, "Projectless projection");
            const thread = requireRecord(projection.thread ?? {}, "Projectless Thread");
            executionCwd = typeof thread.worktreePath === "string" ? thread.worktreePath : "";
            return executionCwd;
          })
          .not.toBe("");
        const workspacePath = relative(workspaceHome, executionCwd);
        expect(workspacePath).not.toMatch(/^\.\.(?:[/\\]|$)/);
        expect(isAbsolute(workspacePath)).toBe(false);
        await waitForFinalMarker(page, "PROJECTLESS_write_OK");
        await waitForCompletedSession(page, callerSession.id);
        await composer.focus();
        await composer.press("Shift+Tab");
        await expect(page.getByLabel("Plan", { exact: true })).toBeVisible();
        await composer.fill("PROJECTLESS_plan");
        await page.getByRole("button", { name: "Send prompt", exact: true }).click();
        await waitForFinalMarker(page, "PROJECTLESS_plan_OK");
        await waitForCompletedSession(page, callerSession.id);
        expect((await seed.readPage(seedProject.projectId, pageId)).descriptionPreview).toContain(
          "Planned content update",
        );
      } catch (error) {
        const presented = await harness.page
          .locator("body")
          .innerText()
          .catch(() => "");
        const product = callerSession.id
          ? await invokeIpc(harness.page, "project-sessions:get", callerSession.id).catch(
              () => null,
            )
          : null;
        const snapshot = threadId
          ? await invokeIpc(harness.page, "agent-runtime:session:control", {
              sessionId: callerSession.id,
            }).catch(() => null)
          : null;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({ product, snapshot }).slice(-36_000)}\n${presented.slice(-16_000)}\n${await readBoundedElectronRuntimeLogs(harness.profile)}\n${processDiagnostics}`,
          { cause: error },
        );
      } finally {
        await harness.close();
      }
    },
  );
});
