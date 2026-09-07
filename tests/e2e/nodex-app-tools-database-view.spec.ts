import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { parseDatabaseViewId } from "../../src/shared/database-identities";
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

const requireSuccess = <Value>(
  result:
    | { readonly ok: true; readonly value: Value }
    | { readonly ok: false; readonly error: { readonly message: string } },
): Value => {
  if (result.ok) return result.value;
  throw new Error(result.error.message);
};

const UNWRAP =
  'const unwrap = r => { const v = typeof r === "string" ? JSON.parse(r) : r; return v.structuredContent ?? (v.content ? JSON.parse(v.content[0].text) : v); };';

test("native Database View tools distinguish displayed rows from the effective shared and personal query", async () => {
  test.setTimeout(180_000);
  const viewId = parseDatabaseViewId(createUuidV7());
  const expectedPages: Array<{ pageId: string; title: string }> = [];
  let viewResults: Record<string, unknown>[] = [];
  await withScriptedModelServer(
    {
      exchanges: [
        {
          name: "open the observed Database View",
          match: (request) =>
            request.hasUserInputText("DATABASE_VIEW_OPEN_PROBE") &&
            !request.hasUserInputText("DATABASE_VIEW_READ_PROBE"),
          expectedCalls: 2,
          maximumCalls: 2,
          respond: (request, index) => {
            if (index === 0) {
              const tool = request.toolInvocation("functions", "exec");
              expect(tool).not.toBeNull();
              return responses.stream([
                responses.created("database_view_open"),
                responses.customToolCall(
                  "database_view_open_call",
                  tool!.name,
                  [
                    UNWRAP,
                    "const initial=unwrap(await tools.mcp__nodex_app__get_session_context({})); const groups=unwrap(await tools.mcp__nodex_app__list_tab_groups({observationId:initial.presentation.observationId}));",
                    `text({opened:unwrap(await tools.mcp__nodex_app__open_tab({observationId:initial.presentation.observationId,panelId:"right",groupId:groups.items.find(g=>g.panelId === "right").groupId,target:{kind:"view",viewId:${JSON.stringify(viewId)}}}))});`,
                  ].join("\n"),
                  tool!.namespace,
                ),
                responses.completed("database_view_open"),
              ]);
            }
            const records = outputRecords(request.toolCallOutput("database_view_open_call"));
            expect(records.find((record) => record.opened)?.opened).toMatchObject({
              applied: true,
              persisted: true,
            });
            return responses.stream([
              responses.created("database_view_open_final"),
              responses.assistantMessage(
                "database_view_open_answer",
                "DATABASE_VIEW_OPEN_OK",
                "final_answer",
              ),
              responses.completed("database_view_open_final", true),
            ]);
          },
        },
        {
          name: "read the exact effective View",
          match: (request) => request.hasUserInputText("DATABASE_VIEW_READ_PROBE"),
          expectedCalls: 2,
          maximumCalls: 2,
          respond: (request, index) => {
            if (index === 0) {
              const tool = request.toolInvocation("functions", "exec");
              expect(tool).not.toBeNull();
              return responses.stream([
                responses.created("database_view_read"),
                responses.customToolCall(
                  "database_view_read_call",
                  tool!.name,
                  [
                    '// @exec: {"yield_time_ms": 60000, "max_output_tokens": 18000}',
                    UNWRAP,
                    `const exact = async () => { const context=unwrap(await tools.mcp__nodex_app__get_session_context({mode:"refresh"})); const tabs=unwrap(await tools.mcp__nodex_app__list_session_tabs({observationId:context.presentation.observationId})); const tab=tabs.items.find(t=>t.viewId === ${JSON.stringify(viewId)}); if(!tab) throw new Error(JSON.stringify(tabs)); return {observationId:context.presentation.observationId,tabId:tab.tabId}; };`,
                    'const summarize = r => { if(r.status !== "ready") return r; const result=r.query.result; const fields=["page_id","title"]; return {...r,query:{...r.query,result:{...result,columns:fields,rows:result.rows.map(row=>fields.map(field=>row[result.columns.indexOf(field)]))}}}; };',
                    'text({loaded:summarize(unwrap(await tools.mcp__nodex_app__read_tab_content({...await exact(),view:{range:"loaded",limit:100,propertyIds:["status"]}})))});',
                    'text({viewport:summarize(unwrap(await tools.mcp__nodex_app__read_tab_content({...await exact(),view:{range:"viewport",limit:100,propertyIds:["status"]}})))});',
                    'text({effective:summarize(unwrap(await tools.mcp__nodex_app__query_displayed_view({...await exact(),propertyIds:["status"]})))});',
                  ].join("\n"),
                  tool!.namespace,
                ),
                responses.completed("database_view_read"),
              ]);
            }
            viewResults = outputRecords(request.toolCallOutput("database_view_read_call"));
            return responses.stream([
              responses.created("database_view_read_final"),
              responses.assistantMessage(
                "database_view_read_answer",
                "DATABASE_VIEW_READ_OK",
                "final_answer",
              ),
              responses.completed("database_view_read_final", true),
            ]);
          },
        },
      ],
    },
    async (model) => {
      const harness = await ElectronScenarioHarness.create({
        label: "native-database-view-content",
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
          "Database View content",
        );
        const seed = new RendererIpcSeedAdapter(page);
        const initial = requireSuccess(
          await seed.readDatabase({
            projectId: draft.projectId,
            read: { target: { kind: "project_default" }, mode: "database" },
          }),
        );
        if (initial.value.kind !== "database") throw new Error("Expected the Project Database");
        const board = initial.value.value.views.find((view) => view.isDefault);
        if (!board) throw new Error("Project Database has no default View");
        const fixturePages = [
          ...Array.from({ length: 30 }, (_, index) => ({
            title: `needle ${String(index).padStart(2, "0")}`,
            status: "build" as const,
            matches: true,
          })),
          { title: "Unsearched build Page", status: "build" as const, matches: false },
          { title: "needle excluded by shared filter", status: "plan" as const, matches: false },
        ];
        for (const [index, fixture] of fixturePages.entries()) {
          const pageId = createUuidV7();
          await seed.createPage({
            key: `page-${index}`,
            pageId,
            operationId: createUuidV7(),
            projectId: draft.projectId,
            title: fixture.title,
            status: fixture.status,
            nfm: "",
          });
          if (fixture.matches) expectedPages.push({ pageId, title: fixture.title });
        }
        requireSuccess(
          await seed.applyDatabase({
            operationId: createUuidV7(),
            projectId: draft.projectId,
            storeEpoch: initial.storeEpoch,
            actor: { kind: "electron_e2e" },
            operations: [
              {
                kind: "duplicate_view",
                databaseId: board.databaseId,
                sourceViewId: board.viewId,
                expectedRevision: board.revision,
                newViewId: viewId,
              },
              {
                kind: "change_view_layout",
                databaseId: board.databaseId,
                viewId,
                expectedRevision: 1,
                layout: "list",
              },
            ],
          }),
        );
        const list = requireSuccess(
          await seed.readDatabase({
            projectId: draft.projectId,
            read: { target: { kind: "view", viewId }, mode: "view" },
          }),
        );
        if (list.value.kind !== "view") throw new Error("Expected the List View");
        const view = list.value.value;
        requireSuccess(
          await seed.applyDatabase({
            operationId: createUuidV7(),
            projectId: draft.projectId,
            storeEpoch: initial.storeEpoch,
            actor: { kind: "electron_e2e" },
            operations: [
              {
                kind: "put_view",
                databaseId: view.databaseId,
                dataSourceId: view.dataSourceId,
                viewId,
                expectedRevision: view.revision,
                name: "Observed List",
                layout: "list",
                isDefault: false,
                config: {
                  ...view.config,
                  rules: {
                    propertyFilters: [
                      {
                        filterId: createUuidV7(),
                        clause: {
                          kind: "clause",
                          propertyId: "status",
                          operator: "select_is",
                          value: "build",
                        },
                      },
                    ],
                    advancedFilter: null,
                    sorts: [{ field: { kind: "title" }, direction: "asc", nulls: "last" }],
                  },
                  presentation: { ...view.config.presentation, group: null, subgroup: null },
                },
              },
              {
                kind: "put_view_personal_preferences",
                viewId,
                expectedRevision: 0,
                rulesOverride: {
                  sorts: [{ field: { kind: "title" }, direction: "desc", nulls: "last" }],
                },
                presentationOverride: {},
              },
            ],
          }),
        );
        await invokeIpc(page, "codex:permission:mode:set", draft.projectId, "full-access");
        threadId = await sendAgentPrompt(page, draft.projectSessionId, "DATABASE_VIEW_OPEN_PROBE");
        await waitForFinalMarker(page, "DATABASE_VIEW_OPEN_OK");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        const surface = page.locator(`[data-database-view-id="${viewId}"]:visible`);
        await expect(surface).toBeVisible();
        await page
          .getByTestId("db-view-toolbar")
          .getByRole("button", { name: "Search", exact: true })
          .click();
        await page.getByRole("textbox", { name: "Search tasks", exact: true }).fill("needle");
        await expect(
          surface.locator('[data-list-row="true"][data-database-view-page-id]').first(),
        ).toContainText("needle 29");
        const composer = page.locator('[data-codex-composer="true"]:visible');
        await expect(composer).toBeVisible();
        await composer.fill("DATABASE_VIEW_READ_PROBE");
        await page.getByRole("button", { name: "Send prompt", exact: true }).click();
        await waitForFinalMarker(page, "DATABASE_VIEW_READ_OK");
        await waitForCompletedAgentTurn(page, threadId, 60_000);
        const records = viewResults;
        await test.info().attach("native-view-results", {
          body: JSON.stringify(records, null, 2),
          contentType: "application/json",
        });
        const loaded = records.find((record) => record.loaded)?.loaded as {
          query: { result: { rows: unknown[][] }; rules_fingerprint: string };
          display: {
            coverage: {
              returnedCount: number;
              loadedOccurrenceCount: number;
              viewportOccurrenceCount: number;
            };
          };
        };
        const viewport = records.find((record) => record.viewport)?.viewport as typeof loaded;
        const effective = records.find((record) => record.effective)?.effective as typeof loaded;
        const expectedRows = [...expectedPages]
          .reverse()
          .map(({ pageId, title }) => [pageId, title]);
        for (const [range, result] of Object.entries({ loaded, viewport, effective })) {
          expect(result, `${range} View content`).toMatchObject({
            status: "ready",
            kind: "database_view",
            display: {
              databaseViewId: viewId,
              layout: "list",
              preferencesRevision: 1,
              search: { current: "needle", deferred: "needle", pending: false },
              preferencesOverride: {
                rulesOverride: {
                  sorts: [{ field: { kind: "title" }, direction: "desc", nulls: "last" }],
                },
              },
              pending: {
                preferences: false,
                optimistic: false,
                loading: false,
                options: false,
              },
            },
            query: { preferences_revision: 1, rules_fingerprint: expect.any(String) },
          });
        }
        expect(loaded).toMatchObject({
          readiness: "observed",
          collapseTreatment: "captured_selection",
          query: { coverage: { kind: "observed" } },
          display: {
            coverage: {
              range: "loaded",
              returnedCount: expectedRows.length,
              allRowsLoaded: true,
            },
          },
        });
        expect(effective).toMatchObject({
          readiness: "effective_query",
          collapseTreatment: "ignored",
          query: {
            coverage: { kind: "effective_complete" },
            total_effective_occurrences: expectedRows.length,
          },
        });
        expect(loaded.query.result.rows).toEqual(expectedRows);
        expect(effective.query.result.rows).toEqual(expectedRows);
        expect(viewport.query.result.rows.length).toBeGreaterThan(0);
        expect(viewport.query.result.rows.length).toBeLessThan(expectedRows.length);
        expect(viewport.display.coverage.returnedCount).toBe(viewport.query.result.rows.length);
        expect(viewport.display.coverage.loadedOccurrenceCount).toBe(expectedRows.length);
        expect(
          viewport.query.result.rows.every((row) =>
            expectedRows.some((expectedRow) => expectedRow[0] === row[0]),
          ),
        ).toBe(true);
        expect(effective.query.rules_fingerprint).toBe(loaded.query.rules_fingerprint);
        expect(effective.query.rules_fingerprint).toBe(viewport.query.rules_fingerprint);
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
