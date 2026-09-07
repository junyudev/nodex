import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import {
  ElectronScenarioHarness,
  readBoundedElectronRuntimeLogs,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  responses,
  withScriptedModelServer,
  type ScriptedModelExchange,
} from "../../scripts/scenarios/runtime/scripted-model-server";
import {
  collectRecords,
  createAgentSmokeDraft,
  invokeIpc,
  requireCoreValue,
  sendAgentPrompt,
  setAgentExecutionProfile,
  waitForCompletedAgentTurn,
  waitForFinalMarker,
} from "./support/agent-smoke-harness";

const outputRecords = (output: unknown) =>
  collectRecords(output).flatMap((record) => {
    if (record.type !== "input_text" || typeof record.text !== "string") return [];
    try {
      return collectRecords(JSON.parse(record.text));
    } catch {
      return [];
    }
  });
const phases = ["mixed", "pinned", "lifecycle", "restored"] as const;
const sectionRows = (page: Page, heading: string) =>
  page
    .locator(`[data-app-action-sidebar-section-heading=${JSON.stringify(heading)}]`)
    .locator("[data-app-action-sidebar-project-label], [data-app-action-sidebar-thread-title]");
const rowTitles = (page: Page, heading: string) =>
  sectionRows(page, heading).evaluateAll((rows) =>
    rows.map(
      (row) =>
        row.getAttribute("data-app-action-sidebar-project-label") ??
        row.getAttribute("data-app-action-sidebar-thread-title"),
    ),
  );

test("native Sidebar commands converge across two windows with mixed and built-in orders", async () => {
  test.setTimeout(240_000);
  let actorId = "";
  let attachedId = "";
  const draftOne = createUuidV7();
  const draftTwo = createUuidV7();
  const projectA = createUuidV7();
  const projectB = createUuidV7();
  let sectionId = "";
  let sectionRevision = 0;
  let projectOrder: string[] = [];
  const program = (phase: (typeof phases)[number]): string[] => {
    const common = [
      '// @exec: {"yield_time_ms": 60000, "max_output_tokens": 30000}',
      'const unwrap = r => { const v = typeof r === "string" ? JSON.parse(r) : r; return v.structuredContent ?? (v.content ? JSON.parse(v.content[0].text) : v); };',
      "const call = async (name, args) => { const v = unwrap(await tools[`mcp__nodex_app__${name}`](args)); text({tool:name,result:v}); return v; };",
      'const sections = await call("list_sidebar_sections", {}); const canonical = kind => sections.items.find(section => section.kind === kind).sectionId;',
      'const readOrder = async (sectionId,itemKind) => { let after; let items=[]; let orderRevision; for(let page=0;page<20;page++){const w=await call("list_sidebar_order",{sectionId,itemKind,first:1,...(after?{after}:{})}); if(orderRevision && orderRevision!==w.orderRevision) throw Error("changed order while reading"); orderRevision=w.orderRevision; items.push(...w.items); after=w.nextCursor; if(!after) return {items,orderRevision};} throw Error("incomplete order");};',
    ];
    if (phase === "mixed")
      return [
        ...common,
        'const attached=await call("create_session",{target:{type:"projectless"},prompt:"SIDEBAR_CHILD",title:"Sidebar attached",model:"gpt-5.6-sol"}); await call("wait_sessions",{targets:[{sessionId:attached.sessionId}],timeoutMs:30000});',
        'const created = await call("create_sidebar_section", {name:"Sidebar Organize"}); const sectionId=created.section.sectionId;',
        'const extra=await call("create_sidebar_section",{name:"Temporary ordering"}); await call("reorder_sidebar_sections",{sectionIds:[extra.section.sectionId,sectionId]}); const ordered=(await call("list_sidebar_sections",{})).items.filter(section=>section.kind==="custom"); if(JSON.stringify(ordered.map(section=>section.sectionId))!==JSON.stringify([extra.section.sectionId,sectionId])) throw Error("Custom Section order did not persist"); await call("delete_sidebar_section",{sectionId:extra.section.sectionId,expectedRevision:ordered[0].revision}); created.section=(await call("list_sidebar_sections",{})).items.find(section=>section.sectionId===sectionId);',
        `await call("move_project_to_sidebar_section",{projectId:${JSON.stringify(projectA)},sectionId});`,
        `await call("move_session_to_sidebar_section",{sessionId:${JSON.stringify(draftOne)},sectionId});`,
        `await call("move_session_to_sidebar_section",{sessionId:${JSON.stringify(draftTwo)},sectionId});`,
        'let after; let items=[]; for(let page=0;page<10;page++){const w=await call("list_sidebar_section_items",{sectionId,first:1,...(after?{after}:{})}); items.push(...w.items); after=w.nextCursor; if(!after) break;}',
        'const desired=[items[2],items[0],items[1]]; const args={sectionId,items:desired.map(item=>({placementId:item.placementId,expectedRevision:item.revision,expectedRankKey:item.rankKey}))}; const reordered=await call("reorder_section",args); const replay=await call("reorder_section",{...args,operationId:reordered.operationId});',
        'const renamed=await call("rename_sidebar_section",{sectionId,name:"Sidebar Ordered",expectedRevision:created.section.revision}); text({phase:"mixed",section:renamed.section,attachedSessionId:attached.sessionId,replay});',
      ];
    if (phase === "pinned")
      return [
        ...common,
        `await call("move_project_to_sidebar_section",{projectId:${JSON.stringify(projectA)},sectionId:canonical("projects")});`,
        `await call("move_session_to_sidebar_section",{sessionId:${JSON.stringify(draftOne)},sectionId:canonical("pinned")});`,
        `await call("move_session_to_sidebar_section",{sessionId:${JSON.stringify(draftTwo)},sectionId:canonical("pinned")});`,
        `await call("set_session_pinned",{sessionId:${JSON.stringify(attachedId)},pinned:true});`,
        'const pins=await readOrder(canonical("pinned"),"session");',
        `const args={sectionId:canonical("pinned"),sessionIds:${JSON.stringify([draftTwo, attachedId, draftOne])},expectedOrderRevision:pins.orderRevision}; const reordered=await call("reorder_section",args); const replay=await call("reorder_section",{...args,operationId:reordered.operationId});`,
        'const current=await readOrder(canonical("pinned"),"session"); const incomplete=await call("reorder_section",{sectionId:canonical("pinned"),sessionIds:[current.items[0].sessionId],expectedOrderRevision:current.orderRevision});',
        'const projects=await readOrder(canonical("projects"),"project"); const desired=projects.items.slice().reverse(); await call("reorder_sidebar_projects",{sectionId:canonical("projects"),projectIds:desired.map(item=>item.projectId),expectedOrderRevision:projects.orderRevision}); text({phase:"pinned",projectOrder:desired.map(item=>item.title),pins:current,replay,incomplete});',
      ];
    if (phase === "lifecycle")
      return [
        ...common,
        `await call("set_session_title",{sessionId:${JSON.stringify(draftTwo)},title:"Sidebar renamed"});`,
        `await call("set_session_archived",{sessionId:${JSON.stringify(draftOne)},archived:true});`,
        'text({phase:"lifecycle",pins:await readOrder(canonical("pinned"),"session")});',
      ];
    return [
      ...common,
      `await call("set_session_archived",{sessionId:${JSON.stringify(draftOne)},archived:false});`,
      `await call("set_session_pinned",{sessionId:${JSON.stringify(draftOne)},pinned:true});`,
      `await call("move_session_to_sidebar_section",{sessionId:${JSON.stringify(draftTwo)},sectionId:null});`,
      `await call("move_project_to_sidebar_section",{projectId:${JSON.stringify(projectA)},sectionId:canonical("pinned")});`,
      `await call("move_project_to_sidebar_section",{projectId:${JSON.stringify(projectB)},sectionId:canonical("pinned")});`,
      'const projects=await readOrder(canonical("pinned"),"project");',
      `await call("reorder_sidebar_projects",{sectionId:canonical("pinned"),projectIds:${JSON.stringify([projectB, projectA])},expectedOrderRevision:projects.orderRevision});`,
      `await call("delete_sidebar_section",{sectionId:${JSON.stringify(sectionId)},expectedRevision:${sectionRevision}});`,
      'text({phase:"restored",pins:await readOrder(canonical("pinned"),"session")});',
    ];
  };
  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "Sidebar attached Session",
          match: (request) => request.hasUserInputText("SIDEBAR_CHILD"),
          expectedCalls: 1,
          maximumCalls: 1,
          respond: () =>
            responses.stream([
              responses.created("sidebar_child"),
              responses.assistantMessage(
                "sidebar_child_answer",
                "SIDEBAR_CHILD_OK",
                "final_answer",
              ),
              responses.completed("sidebar_child", true),
            ]),
        },
        ...phases.map<ScriptedModelExchange>((phase, phaseIndex) => ({
          name: `Sidebar ${phase}`,
          match: (request) =>
            request.hasUserInputText(`SIDEBAR_${phase}`) &&
            !phases
              .slice(phaseIndex + 1)
              .some((later) => request.hasUserInputText(`SIDEBAR_${later}`)),
          expectedCalls: 2,
          maximumCalls: 2,
          respond: (request, index) => {
            if (index === 0) {
              const tool = request.toolInvocation("functions", "exec");
              expect(tool).not.toBeNull();
              return responses.stream([
                responses.created(`sidebar_call_${phase}`),
                responses.customToolCall(`sidebar_${phase}`, tool!.name, program(phase).join("\n")),
                responses.completed(`sidebar_call_${phase}`),
              ]);
            }
            const records = outputRecords(request.toolCallOutput(`sidebar_${phase}`));
            const result = records.find((record) => record.phase === phase);
            expect(result, JSON.stringify(records)).toBeDefined();
            const errors = records.filter(
              (record) =>
                typeof record.code === "string" && !["revision_conflict"].includes(record.code),
            );
            expect(errors).toEqual([]);
            if (phase === "mixed") {
              const section = result!.section as { sectionId: string; revision: number };
              sectionId = section.sectionId;
              sectionRevision = section.revision;
              attachedId = result!.attachedSessionId as string;
            }
            if (phase === "pinned") {
              projectOrder = result!.projectOrder as string[];
              expect(result!.incomplete).toMatchObject({ error: { code: "revision_conflict" } });
              expect((result!.pins as { items: unknown[] }).items).toEqual([
                { kind: "session", sessionId: draftTwo, title: "Sidebar draft two" },
                { kind: "session", sessionId: attachedId, title: "Sidebar attached" },
                { kind: "session", sessionId: draftOne, title: "Sidebar draft one" },
              ]);
            }
            return responses.stream([
              responses.created(`sidebar_done_${phase}`),
              responses.assistantMessage(
                `sidebar_answer_${phase}`,
                `SIDEBAR_OK_${phase}`,
                "final_answer",
              ),
              responses.completed(`sidebar_done_${phase}`, true),
            ]);
          },
        })),
      ],
    },
    async (model) => {
      const harness = await ElectronScenarioHarness.create({
        label: "native-sidebar-two-windows",
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
        const first = await harness.launch();
        for (const [projectId, name] of [
          [projectA, "Sidebar Project A"],
          [projectB, "Sidebar Project B"],
        ]) {
          const root = join(harness.profile.initialProjectsDirectory, projectId!);
          mkdirSync(root, { recursive: true });
          requireCoreValue(
            await invokeIpc(first, "projects:create", {
              operationId: createBoundedOperationId("sidebar.fixture.project"),
              payload: { projectId, input: { name, sources: [root] } },
            }),
            "Project fixture",
          );
        }
        for (const [sessionId, title] of [
          [draftOne, "Sidebar draft one"],
          [draftTwo, "Sidebar draft two"],
        ]) {
          requireCoreValue(
            await invokeIpc(first, "project-sessions:create", {
              operationId: createBoundedOperationId("sidebar.fixture.session"),
              payload: {
                sessionId,
                input: { projectId: null, noThreadFallbackTitle: title, initialPageIds: [] },
              },
            }),
            "Session fixture",
          );
        }
        const actor = await createAgentSmokeDraft(
          first,
          harness.profile.initialProjectsDirectory,
          "Sidebar actor project",
        );
        actorId = actor.projectSessionId;
        await setAgentExecutionProfile(first, { preferredModelId: "gpt-5.6-sol" });
        await invokeIpc(first, "codex:permission:mode:set", actor.projectId, "full-access");
        const opened = harness.application.waitForEvent("window");
        expect(await invokeIpc(first, "window:new", {})).toBe(true);
        const second = await opened;
        await second.waitForURL((url) => url.protocol !== "about:");
        await second.waitForLoadState("domcontentloaded");
        await second.evaluate(() => window.api?.awaitInitialization?.());
        const windows = [first, second];
        const threadId = await sendAgentPrompt(first, actorId, "SIDEBAR_mixed");
        await waitForCompletedAgentTurn(first, threadId, 60_000);
        await waitForFinalMarker(first, "SIDEBAR_OK_mixed");
        for (const page of windows)
          await expect
            .poll(() => rowTitles(page, "Sidebar Ordered"))
            .toEqual(["Sidebar draft two", "Sidebar Project A", "Sidebar draft one"]);
        for (const phase of phases.slice(1)) {
          const composer = first.locator("[data-codex-composer='true']").first();
          await composer.fill(`SIDEBAR_${phase}`);
          await composer.press("Enter");
          await waitForFinalMarker(first, `SIDEBAR_OK_${phase}`);
          await waitForCompletedAgentTurn(first, threadId, 60_000);
          for (const page of windows) {
            if (phase === "pinned") {
              await expect
                .poll(() => rowTitles(page, "Pinned"))
                .toEqual(["Sidebar draft two", "Sidebar attached", "Sidebar draft one"]);
              await expect
                .poll(async () =>
                  (await rowTitles(page, "Projects")).filter((title) =>
                    title?.startsWith("Sidebar Project"),
                  ),
                )
                .toEqual(projectOrder.filter((title) => title.startsWith("Sidebar Project")));
            }
            if (phase === "lifecycle")
              await expect
                .poll(() => rowTitles(page, "Pinned"))
                .toEqual(["Sidebar renamed", "Sidebar attached"]);
            if (phase === "restored") {
              await expect
                .poll(() => rowTitles(page, "Pinned"))
                .toEqual([
                  "Sidebar attached",
                  "Sidebar draft one",
                  "Sidebar Project B",
                  "Sidebar Project A",
                ]);
              await expect(
                page.locator('[data-app-action-sidebar-section-heading="Sidebar Ordered"]'),
              ).toHaveCount(0);
              await expect(
                page.locator(
                  '[data-app-action-sidebar-section-heading="Chats"] [data-app-action-sidebar-thread-title="Sidebar renamed"]',
                ),
              ).toBeVisible();
            }
          }
        }
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
