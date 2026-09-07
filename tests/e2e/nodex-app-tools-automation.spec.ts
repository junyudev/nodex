import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import type { CodexScheduledAutomationListResponse } from "../../src/shared/types";
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
  collectRecords,
  createAgentSmokeDraft,
  invokeIpc,
  requireCoreValue,
  requireRecord,
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

const labeledResult = (records: Record<string, unknown>[], label: string) =>
  requireRecord(records.find((record) => record[label])?.[label], label);

test("manages durable Automation definitions through native MCP across a restart", async () => {
  test.setTimeout(180_000);
  let callerSessionId = "";
  let callerProjectId = "";
  let workspaceRoot = "";
  const selectedProjectId = createUuidV7();
  let retained: Record<string, unknown> | null = null;

  await withScriptedModelServer(
    {
      exchanges: ["initial", "restored"].map<ScriptedModelExchange>((phase) => ({
        name: `native Automation management ${phase}`,
        match: (request) =>
          request.hasUserInputText(`APP_AUTOMATION_${phase}`) &&
          (phase === "restored" || !request.hasUserInputText("APP_AUTOMATION_restored")),
        expectedCalls: 2,
        maximumCalls: 2,
        respond: (request, index) => {
          const callId = `app_automation_${phase}`;
          if (index === 0) {
            const tool = request.toolInvocation("functions", "exec");
            expect(tool).not.toBeNull();
            const initialScript = [
              "text({projects:unwrap(await tools.mcp__nodex_app__list_projects({}))});",
              `const cronArgs = {mode:"create",kind:"cron",name:"MCP scheduled review",prompt:"Review the selected Project",rrule:"FREQ=YEARLY",projectId:${JSON.stringify(selectedProjectId)},cwds:[${JSON.stringify(workspaceRoot)}],executionEnvironment:"local",notificationPolicy:"failed_runs_only"};`,
              "const created = unwrap(await tools.mcp__nodex_app__automation_update(cronArgs)); text({created});",
              "text({createReplay:unwrap(await tools.mcp__nodex_app__automation_update({...cronArgs,operationId:created.operationId}))});",
              "const viewed = unwrap(await tools.mcp__nodex_app__automation_update({mode:'view',id:created.item.id})); text({viewed});",
              "const updateArgs = {...cronArgs,mode:'update',id:viewed.item.id,expectedRevision:viewed.item.definitionRevision,status:'PAUSED',name:'MCP paused review',notificationPolicy:null};",
              "const updated = unwrap(await tools.mcp__nodex_app__automation_update(updateArgs)); text({updated});",
              "text({updateReplay:unwrap(await tools.mcp__nodex_app__automation_update({...updateArgs,operationId:updated.operationId}))});",
              "const heartbeatArgs = {mode:'create',kind:'heartbeat',name:'MCP follow-up',prompt:'Check this Session for progress',rrule:'FREQ=YEARLY',notificationPolicy:'failed_runs_only'};",
              "const heartbeat = unwrap(await tools.mcp__nodex_app__automation_update(heartbeatArgs)); text({heartbeat});",
              "text({heartbeatReplay:unwrap(await tools.mcp__nodex_app__automation_update({...heartbeatArgs,operationId:heartbeat.operationId}))});",
              "text({retained:{cronCreateArgs:{...cronArgs,operationId:created.operationId},cronUpdateArgs:{...updateArgs,operationId:updated.operationId},cronId:updated.item.id,cronRevision:updated.item.definitionRevision,heartbeatCreateArgs:{...heartbeatArgs,operationId:heartbeat.operationId},heartbeatId:heartbeat.item.id,heartbeatRevision:heartbeat.item.definitionRevision}});",
            ];
            const restoredScript = [
              `const retained = ${JSON.stringify(retained)};`,
              "text({restoredCron:unwrap(await tools.mcp__nodex_app__automation_update({mode:'view',id:retained.cronId}))});",
              "text({restoredHeartbeat:unwrap(await tools.mcp__nodex_app__automation_update({mode:'view',id:retained.heartbeatId}))});",
              "text({restoredCreateReplay:unwrap(await tools.mcp__nodex_app__automation_update(retained.cronCreateArgs))});",
              "text({restoredUpdateReplay:unwrap(await tools.mcp__nodex_app__automation_update(retained.cronUpdateArgs))});",
              "text({restoredHeartbeatReplay:unwrap(await tools.mcp__nodex_app__automation_update(retained.heartbeatCreateArgs))});",
              "const deleteArgs = {mode:'delete',id:retained.cronId,expectedRevision:retained.cronRevision};",
              "const deleted = unwrap(await tools.mcp__nodex_app__automation_update(deleteArgs)); text({deleted});",
              "text({deleteReplay:unwrap(await tools.mcp__nodex_app__automation_update({...deleteArgs,operationId:deleted.operationId}))});",
              "const heartbeatDeleteArgs = {mode:'delete',id:retained.heartbeatId,expectedRevision:retained.heartbeatRevision};",
              "const heartbeatDeleted = unwrap(await tools.mcp__nodex_app__automation_update(heartbeatDeleteArgs)); text({heartbeatDeleted});",
              "text({heartbeatDeleteReplay:unwrap(await tools.mcp__nodex_app__automation_update({...heartbeatDeleteArgs,operationId:heartbeatDeleted.operationId}))});",
            ];
            return responses.stream([
              responses.created(`${phase}_call`),
              responses.customToolCall(
                callId,
                tool!.name,
                [
                  '// @exec: {"yield_time_ms": 60000, "max_output_tokens": 18000}',
                  'const unwrap = r => { const v = typeof r === "string" ? JSON.parse(r) : r; return v.structuredContent ?? (v.content ? JSON.parse(v.content[0].text) : v); };',
                  ...(phase === "initial" ? initialScript : restoredScript),
                ].join("\n"),
                tool!.namespace,
              ),
              responses.completed(`${phase}_call`),
            ]);
          }

          const output = request.toolCallOutput(callId);
          const records = toolOutputRecords(output);
          expect(
            records.filter((record) => record.error != null),
            JSON.stringify(output),
          ).toEqual([]);
          expect(records.some((record) => record.isError === true)).toBe(false);
          if (phase === "initial") {
            const created = labeledResult(records, "created");
            expect(created.operationId).toEqual(expect.any(String));
            expect(created.item).toMatchObject({
              kind: "cron",
              status: "ACTIVE",
              projectId: selectedProjectId,
              targetSessionId: null,
              notificationPolicy: "failed_runs_only",
              definitionRevision: 1,
            });
            expect(labeledResult(records, "createReplay").item).toEqual(created.item);
            expect(labeledResult(records, "viewed").item).toEqual(created.item);
            const updated = labeledResult(records, "updated");
            expect(updated.item).toMatchObject({
              id: requireRecord(created.item, "Created Automation").id,
              status: "PAUSED",
              projectId: selectedProjectId,
              name: "MCP paused review",
              notificationPolicy: null,
              definitionRevision: 2,
            });
            expect(labeledResult(records, "updateReplay").item).toEqual(updated.item);
            const heartbeat = labeledResult(records, "heartbeat");
            expect(heartbeat.item).toMatchObject({
              kind: "heartbeat",
              projectId: null,
              targetSessionId: callerSessionId,
              notificationPolicy: "failed_runs_only",
              definitionRevision: 1,
            });
            expect(labeledResult(records, "heartbeatReplay").item).toEqual(heartbeat.item);
            retained = labeledResult(records, "retained");
          } else {
            if (!retained) throw new Error("Initial Automation receipts were not retained");
            expect(labeledResult(records, "restoredCron").item).toMatchObject({
              id: retained.cronId,
              projectId: selectedProjectId,
              status: "PAUSED",
              definitionRevision: retained.cronRevision,
              notificationPolicy: null,
            });
            expect(labeledResult(records, "restoredHeartbeat").item).toMatchObject({
              id: retained.heartbeatId,
              projectId: null,
              targetSessionId: callerSessionId,
              definitionRevision: retained.heartbeatRevision,
            });
            expect(labeledResult(records, "restoredCreateReplay").item).toMatchObject({
              id: retained.cronId,
              definitionRevision: 1,
            });
            expect(labeledResult(records, "restoredUpdateReplay").item).toEqual(
              labeledResult(records, "restoredCron").item,
            );
            expect(labeledResult(records, "restoredHeartbeatReplay").item).toEqual(
              labeledResult(records, "restoredHeartbeat").item,
            );
            expect(labeledResult(records, "deleted")).toMatchObject({
              success: true,
              status: "deleted",
            });
            expect(labeledResult(records, "deleteReplay")).toEqual(
              labeledResult(records, "deleted"),
            );
            expect(labeledResult(records, "heartbeatDeleted")).toMatchObject({
              success: true,
              status: "deleted",
            });
            expect(labeledResult(records, "heartbeatDeleteReplay")).toEqual(
              labeledResult(records, "heartbeatDeleted"),
            );
          }
          return responses.stream([
            responses.created(`${phase}_done`),
            responses.assistantMessage(
              `${phase}_answer`,
              `APP_AUTOMATION_OK_${phase}`,
              "final_answer",
            ),
            responses.completed(`${phase}_done`, true),
          ]);
        },
      })),
    },
    async (model) => {
      const harness = await ElectronScenarioHarness.create({
        label: "native-app-tools-automation",
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
        let page = await harness.launch();
        workspaceRoot = harness.profile.initialProjectsDirectory;
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.6-sol" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.initialProjectsDirectory,
          "Automation caller",
        );
        callerSessionId = draft.projectSessionId;
        callerProjectId = draft.projectId;
        await invokeIpc(page, "codex:permission:mode:set", callerProjectId, "full-access");
        requireCoreValue(
          await invokeIpc(page, "projects:create", {
            operationId: createBoundedOperationId("e2e.app-tools.automation.project"),
            payload: {
              projectId: selectedProjectId,
              input: {
                name: "Automation execution target",
                sources: [harness.profile.initialProjectsDirectory],
              },
            },
          }),
          "Automation target Project creation",
        );

        const threadId = await sendAgentPrompt(page, callerSessionId, "APP_AUTOMATION_initial");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        await waitForFinalMarker(page, "APP_AUTOMATION_OK_initial");
        const persisted = (await invokeIpc(
          page,
          "codex:scheduled-automations:list",
        )) as CodexScheduledAutomationListResponse;
        expect(persisted.items).toHaveLength(2);
        expect(persisted.items).toContainEqual(
          expect.objectContaining({
            kind: "cron",
            projectId: selectedProjectId,
            status: "PAUSED",
            definitionRevision: 2,
          }),
        );
        expect(persisted.items).toContainEqual(
          expect.objectContaining({
            kind: "heartbeat",
            projectId: null,
            targetSessionId: callerSessionId,
          }),
        );

        page = await harness.restart();
        expect(await invokeIpc(page, "codex:scheduled-automations:list")).toEqual(persisted);
        const composer = page.locator("[data-codex-composer='true']").first();
        await expect(composer).toBeEditable();
        await composer.fill("APP_AUTOMATION_restored");
        await composer.press("Enter");
        await waitForFinalMarker(page, "APP_AUTOMATION_OK_restored");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        expect(await invokeIpc(page, "codex:scheduled-automations:list")).toEqual({ items: [] });
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
