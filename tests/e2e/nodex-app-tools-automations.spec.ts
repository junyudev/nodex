import { nativeAppToolCall } from "./support/native-app-tools";
import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import type { AutomationListResponse } from "../../src/shared/types";
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
  waitForRuntimeCompletedAgentTurn,
  readRuntimeConversation,
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

test("an Agent changes Automations for its person, its proposals are reviewed as Owner, and receipts survive a restart", async ({}, testInfo) => {
  test.setTimeout(180_000);
  let callerSessionId = "";
  let workspaceRoot = "";
  const selectedProjectId = createUuidV7();
  const cronCreateKey = createUuidV7();
  const heartbeatCreateKey = createUuidV7();
  let retained: Record<string, unknown> | null = null;
  let reviewEvidence: unknown = null;

  await withScriptedModelServer(
    {
      exchanges: ["initial", "restored"].map<ScriptedModelExchange>((phase) => ({
        name: `native Automation management ${phase}`,
        match: (request) =>
          (request.hasUserInputText(`APP_AUTOMATION_${phase}`) &&
            (phase === "restored" || !request.hasUserInputText("APP_AUTOMATION_restored"))) ||
          request.toolCallOutput(`app_automation_${phase}`) !== null,
        expectedCalls: 2,
        maximumCalls: 2,
        respond: (request, index) => {
          const callId = `app_automation_${phase}`;
          if (index === 0) {
            const tool = request.toolInvocation("functions", "exec");
            expect(tool).not.toBeNull();
            const initialScript = [
              "text({projects:unwrap(await app.list_projects({}))});",
              `const cronArgs = {operation:"create",kind:"cron",name:"MCP clock review",prompt:"Review the selected Project",rrule:"FREQ=YEARLY",projectId:${JSON.stringify(selectedProjectId)},cwds:[${JSON.stringify(workspaceRoot)}],executionEnvironment:"local",notificationPolicy:"failed_runs_only",idempotencyKey:${JSON.stringify(cronCreateKey)}};`,
              "const created = unwrap(await app.automations_update(cronArgs)); text({created});",
              "text({createReplay:unwrap(await app.automations_update(cronArgs))});",
              "const viewed = unwrap(await app.automations_update({operation:'view',id:created.item.id})); text({viewed});",
              "const {idempotencyKey: _createKey,...definition} = cronArgs; const updated = unwrap(await app.automations_update({...definition,operation:'update',id:viewed.item.id,expectedRevision:viewed.item.automationRevision,status:'ACTIVE',name:'MCP direct review'})); text({updated});",
              "text({proposed:unwrap(await app.automations_update({...definition,operation:'suggested_update',id:viewed.item.id,expectedRevision:updated.item.automationRevision,status:'PAUSED',name:'MCP paused review',notificationPolicy:null}))});",
              "text({afterProposal:unwrap(await app.automations_update({operation:'view',id:created.item.id}))});",
              `const heartbeatArgs = {operation:'create',kind:'heartbeat',name:'MCP follow-up',prompt:'Check this Session for progress',rrule:'FREQ=YEARLY',notificationPolicy:'failed_runs_only',idempotencyKey:${JSON.stringify(heartbeatCreateKey)}};`,
              "const heartbeat = unwrap(await app.automations_update(heartbeatArgs)); text({heartbeat});",
              "text({heartbeatReplay:unwrap(await app.automations_update(heartbeatArgs))});",
              "text({retained:{cronCreateArgs:cronArgs,cronId:created.item.id,cronRevision:created.item.automationRevision,cronOperationId:created.operationId,heartbeatCreateArgs:heartbeatArgs,heartbeatId:heartbeat.item.id,heartbeatRevision:heartbeat.item.automationRevision,heartbeatOperationId:heartbeat.operationId}});",
            ];
            const restoredScript = [
              `const retained = ${JSON.stringify(retained)};`,
              "text({restoredCron:unwrap(await app.automations_update({operation:'view',id:retained.cronId}))});",
              "text({restoredHeartbeat:unwrap(await app.automations_update({operation:'view',id:retained.heartbeatId}))});",
              "text({restoredCreateReplay:unwrap(await app.automations_update(retained.cronCreateArgs))});",
              "text({restoredHeartbeatReplay:unwrap(await app.automations_update(retained.heartbeatCreateArgs))});",
              "text({heartbeatDeleted:unwrap(await app.automations_update({operation:'delete',id:retained.heartbeatId,expectedRevision:retained.heartbeatRevision}))});",
            ];
            return responses.stream([
              responses.created(`${phase}_call`),
              nativeAppToolCall(
                callId,
                tool!.name,
                [
                  '// @exec: {"yield_time_ms": 60000, "max_output_tokens": 18000}',
                  'const raw = r => typeof r === "string" ? JSON.parse(r) : r; const unwrap = r => { const v = raw(r); return v.structuredContent ?? (v.content ? JSON.parse(v.content[0].text) : v); };',
                  ...(phase === "initial" ? initialScript : restoredScript),
                ].join("\n"),
                tool!.namespace,
              ),
              responses.completed(`${phase}_call`),
            ]);
          }

          const output = request.toolCallOutput(callId);
          const records = toolOutputRecords(output);
          if (phase === "initial") {
            const created = labeledResult(records, "created");
            expect(created.operationId).toEqual(expect.any(String));
            expect(created.item).toMatchObject({
              kind: "cron",
              mode: "ask_first",
              status: "ACTIVE",
              projectId: selectedProjectId,
              targetSessionId: null,
              notificationPolicy: "failed_runs_only",
              automationRevision: 1,
            });
            expect(labeledResult(records, "createReplay").item).toEqual(created.item);
            expect(labeledResult(records, "viewed").item).toEqual(created.item);
            // The Agent acts with its person's authority: its edit commits directly.
            const updated = labeledResult(records, "updated");
            expect(updated.item).toMatchObject({
              id: requireRecord(created.item, "Created Automation").id,
              name: "MCP direct review",
              status: "ACTIVE",
              mode: "ask_first",
              automationRevision: 2,
            });
            expect(labeledResult(records, "proposed")).toMatchObject({
              committed: false,
              proposal: {
                operation: "suggested_update",
                id: requireRecord(created.item, "Created Automation").id,
                expectedRevision: 2,
                status: "PAUSED",
                projectId: selectedProjectId,
                name: "MCP paused review",
                notificationPolicy: null,
              },
            });
            expect(labeledResult(records, "afterProposal").item).toEqual(updated.item);
            const heartbeat = labeledResult(records, "heartbeat");
            expect(heartbeat.item).toMatchObject({
              kind: "heartbeat",
              mode: "ask_first",
              projectId: null,
              targetSessionId: callerSessionId,
              notificationPolicy: "failed_runs_only",
              automationRevision: 1,
            });
            expect(labeledResult(records, "heartbeatReplay").item).toEqual(heartbeat.item);
            retained = labeledResult(records, "retained");
          } else {
            if (!retained) throw new Error("Initial Automation receipts were not retained");
            expect(labeledResult(records, "restoredCron").item).toMatchObject({
              id: retained.cronId,
              projectId: selectedProjectId,
              status: "PAUSED",
              automationRevision: retained.cronRevision,
              mode: "ask_first",
              notificationPolicy: null,
            });
            expect(labeledResult(records, "restoredHeartbeat").item).toMatchObject({
              id: retained.heartbeatId,
              projectId: null,
              targetSessionId: callerSessionId,
              automationRevision: retained.heartbeatRevision,
            });
            expect(labeledResult(records, "restoredCreateReplay").item).toMatchObject({
              id: retained.cronId,
              automationRevision: 1,
            });
            expect(labeledResult(records, "restoredCreateReplay").operationId).toBe(
              retained.cronOperationId,
            );
            expect(labeledResult(records, "restoredHeartbeatReplay").item).toEqual(
              labeledResult(records, "restoredHeartbeat").item,
            );
            expect(labeledResult(records, "restoredHeartbeatReplay").operationId).toBe(
              retained.heartbeatOperationId,
            );
            expect(labeledResult(records, "heartbeatDeleted").operationId).toEqual(
              expect.any(String),
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
        label: "native-app-tools-automations",
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
        workspaceRoot = harness.profile.projectsDirectory;
        await setAgentExecutionProfile(page, { preferredModelId: "gpt-5.6-sol" });
        const draft = await createAgentSmokeDraft(
          page,
          harness.profile.projectsDirectory,
          "Automation caller",
        );
        callerSessionId = draft.projectSessionId;
        requireCoreValue(
          await invokeIpc(page, "projects:create", {
            operationId: createBoundedOperationId("e2e.app-tools.automations.project"),
            payload: {
              projectId: selectedProjectId,
              input: {
                name: "Automation execution target",
                sources: [harness.profile.projectsDirectory],
              },
            },
          }),
          "Automation target Project creation",
        );

        const threadId = await sendAgentPrompt(page, callerSessionId, "APP_AUTOMATION_initial");
        const initial = await waitForRuntimeCompletedAgentTurn(
          page,
          { sessionId: callerSessionId, threadId },
          60_000,
        );
        const providerThreadId = initial.snapshot.projection.thread.activeProviderThreadId;
        const nativeThread = initial.snapshot.projection.providerThreads.find(
          (candidate) => candidate.id === providerThreadId,
        )?.nativeThreadRef;
        expect(nativeThread).toMatchObject({ driver: "codex", nativeId: expect.any(String) });
        await waitForFinalMarker(page, "APP_AUTOMATION_OK_initial");
        const receipts = requireRecord(retained, "Initial Automation receipts");
        const beforeReview = (await invokeIpc(page, "automations:list")) as AutomationListResponse;
        expect(beforeReview.items).toHaveLength(2);
        expect(beforeReview.items).toContainEqual(
          expect.objectContaining({
            id: receipts.cronId,
            name: "MCP direct review",
            status: "ACTIVE",
            mode: "ask_first",
            automationRevision: 2,
          }),
        );

        const metadata = initial.snapshot.projection.visibleTurnItems.length
          ? initial
          : await readRuntimeConversation(page, { sessionId: callerSessionId, threadId });
        const automationCalls = metadata.snapshot.projection.visibleTurnItems
          .filter(
            (row) =>
              row.item.type === "dynamic_tool" &&
              (row.item.mcpToolCall?.tool === "automations_update" ||
                row.item.toolName?.endsWith("automations_update")),
          )
          .slice(-12);
        const operation = (value: unknown) =>
          value !== null && typeof value === "object" && "operation" in value
            ? value.operation
            : null;
        const proposedCall = automationCalls.find(
          ({ item }) =>
            item.type === "dynamic_tool" &&
            (operation(item.input) === "suggested_update" ||
              operation(item.mcpToolCall?.arguments) === "suggested_update"),
        );
        reviewEvidence = {
          calls: automationCalls,
          selectedSourceItemId: proposedCall?.sourceItemId ?? null,
          detail: proposedCall
            ? await invokeIpc(page, "agent-runtime:session:item", {
                sessionId: callerSessionId,
                threadId,
                sourceThreadId: proposedCall.sourceThreadId,
                itemId: proposedCall.sourceItemId,
              }).catch((cause: unknown) => ({
                error: cause instanceof Error ? cause.message : String(cause),
              }))
            : null,
        };
        const completedWork = page.getByRole("button", { name: /^Worked for / });
        await expect(completedWork).toHaveAttribute("aria-expanded", "false");
        await completedWork.click();
        await expect(completedWork).toHaveAttribute("aria-expanded", "true");
        await page.getByRole("button", { name: /MCP paused review · Proposed update/ }).click();
        const editor = page.locator('[data-automation-side-panel-tab="true"]:visible');
        await expect(editor.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
          "MCP paused review",
        );
        await expect(editor.getByRole("button", { name: "Mode", exact: true })).toHaveText(
          "Ask first",
        );
        await testInfo.attach("owner-automation-review", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        await editor.getByRole("button", { name: "Apply changes", exact: true }).click();
        await expect
          .poll(async () => {
            const automations = (await invokeIpc(
              page,
              "automations:list",
            )) as AutomationListResponse;
            return automations.items.find((automation) => automation.id === receipts.cronId);
          })
          .toMatchObject({
            status: "PAUSED",
            name: "MCP paused review",
            mode: "ask_first",
            notificationPolicy: null,
            automationRevision: 3,
          });
        retained = { ...receipts, cronRevision: 3 };
        const persisted = (await invokeIpc(page, "automations:list")) as AutomationListResponse;
        expect(persisted.items).toHaveLength(2);
        expect(persisted.items).toContainEqual(
          expect.objectContaining({
            kind: "cron",
            id: receipts.cronId,
            projectId: selectedProjectId,
            status: "PAUSED",
            automationRevision: 3,
          }),
        );
        expect(persisted.items).toContainEqual(
          expect.objectContaining({
            kind: "heartbeat",
            id: receipts.heartbeatId,
            projectId: null,
            targetSessionId: callerSessionId,
          }),
        );

        page = await harness.restart();
        expect(await invokeIpc(page, "automations:list")).toEqual(persisted);
        const composer = page.locator("[data-codex-composer='true']").first();
        await expect(composer).toBeEditable();
        await composer.fill("APP_AUTOMATION_restored");
        await composer.press("Enter");
        await waitForFinalMarker(page, "APP_AUTOMATION_OK_restored");
        const restored = await waitForRuntimeCompletedAgentTurn(
          page,
          { sessionId: callerSessionId, threadId },
          60_000,
        );
        expect(restored.snapshot.projection.thread.activeProviderThreadId).toBe(providerThreadId);
        expect(
          restored.snapshot.projection.providerThreads.find(
            (candidate) => candidate.id === providerThreadId,
          )?.nativeThreadRef,
        ).toEqual(nativeThread);
        // The Agent deleted the heartbeat for its person; the person deletes the other one.
        expect(await invokeIpc(page, "automations:list")).toEqual({
          items: persisted.items.filter((automation) => automation.id !== receipts.heartbeatId),
        });
        await page.getByRole("button", { name: "Automations", exact: true }).click();
        const row = page.locator(`[data-automation-id="${String(receipts.cronId)}"]`);
        await row.hover();
        await row.getByRole("button", { name: "More automation actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
        const confirmation = page.getByRole("dialog", {
          name: "Delete automation?",
          exact: true,
        });
        await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
        await expect(row).toBeHidden();
        expect(await invokeIpc(page, "automations:list")).toEqual({ items: [] });
      } catch (error) {
        const presentation = await harness.page
          .evaluate(() => ({
            body: document.body.innerText.slice(-24_000),
            scroll: Array.from(
              document.querySelectorAll<HTMLElement>("[data-virtualized-turn-content]"),
            )
              .slice(-8)
              .map((element) => ({
                top: element.getBoundingClientRect().top,
                height: element.getBoundingClientRect().height,
                scrollTop: element.parentElement?.scrollTop,
                scrollHeight: element.parentElement?.scrollHeight,
                clientHeight: element.parentElement?.clientHeight,
              })),
            buttons: Array.from(document.querySelectorAll('button, [role="button"]'))
              .slice(-100)
              .map((button) => ({
                label: button.getAttribute("aria-label") ?? button.textContent?.trim(),
                expanded: button.getAttribute("aria-expanded"),
                visible: button.getClientRects().length > 0,
              })),
          }))
          .catch(() => null);
        const evidence = JSON.stringify({ reviewEvidence, presentation });
        await testInfo.attach("automation-review-evidence", {
          body: Buffer.from(
            evidence.length <= 64_000
              ? evidence
              : JSON.stringify({ truncated: true, preview: evidence.slice(0, 64_000) }),
          ),
          contentType: "application/json",
        });
        await testInfo.attach("automation-review-failure", {
          body: await harness.page.screenshot(),
          contentType: "image/png",
        });
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
