import { expect, test } from "vite-plus/test";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { runScenarioDatabase } from "../../../scripts/scenarios/adapters/core-client-seed-runtime";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  createCustomOptionId,
  createCustomPropertyId,
  parseDatabaseViewId,
  parseDataSourceOptionId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import type {
  DatabaseApplyOperationV2,
  DatabaseDataEditUndoRecipeV2,
  DatabasePropertySchemaV2,
  DatabasePropertyValueInputV2,
} from "../../shared/database-module-v2";
import { buildDatabaseViewWindowRenderModel } from "../../renderer/lib/database-view-render-model";
import {
  buildDatabaseViewMoveOperations,
  buildDatabaseViewMovePageRunOperations,
  commitDatabaseViewOperations,
} from "../../renderer/lib/database-view-row-mutations";
import {
  databaseViewHistoryScopeKey,
  createDatabaseViewMutationHistory,
} from "../../renderer/components/workbench/database-view-mutation-history";
import {
  createCoreDatabaseModuleAdapter,
  createCoreLibraryDatabaseModuleAdapter,
} from "./database-module-adapter";

const scenario = { scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID };
const statusPropertyId = parseDataSourcePropertyId("status");
const statusValue = (value: string): DatabasePropertyValueInputV2 => ({
  kind: "select",
  optionId: parseDataSourceOptionId({ propertyId: "status", value }),
});

const database = (ctx: CoreScenarioContext, access: "project" | "library" = "project") => {
  const projectId = ctx.manifest.projectId;
  const viewId = parseDatabaseViewId(ctx.manifest.databaseViewId!);
  const project = createCoreDatabaseModuleAdapter({
    ...ctx.runtime.identity,
    projectId,
    client: ctx.runtime.clientForProject(projectId),
  });
  const library = createCoreLibraryDatabaseModuleAdapter({
    ...ctx.runtime.identity,
    client: ctx.client,
  });
  const read = async () =>
    buildDatabaseViewWindowRenderModel(
      await runScenarioDatabase(ctx.runtime, (module) =>
        module.viewWindow({ kind: "project", projectId }, { databaseViewId: viewId, first: 100 }),
      ),
    );
  const readRow = async (pageId: string) => {
    const snapshot = await ctx.runtime
      .clientForProject(projectId)
      .databaseRead({ kind: "row_detail", page_id: pageId });
    if (snapshot.value.kind !== "row_detail") throw new Error("Missing row detail");
    return snapshot.value.value.summary;
  };
  const apply = async (
    operations: readonly DatabaseApplyOperationV2[],
    operationId = createUuidV7(),
  ) => {
    const model = await read();
    const receipt = await commitDatabaseViewOperations({
      model: {
        ...model,
        accessContext: access === "library" ? { kind: "library" } : model.accessContext,
      },
      operations,
      operationId,
      dependencies: {
        applyProject: (_projectId, request) => project.apply(request),
        applyLibrary: (request) => library.apply(request),
      },
    });
    if (!receipt) throw new Error("Missing Database receipt");
    return receipt;
  };
  const edit = async (
    pageId: string,
    propertyId: string,
    value: DatabasePropertyValueInputV2,
  ): Promise<DatabaseApplyOperationV2> => {
    const model = await read();
    const row = await readRow(pageId);
    const property = model.query.properties.find((property) => property.propertyId === propertyId)!;
    return {
      kind: "edit_property_values",
      edits: [
        {
          pageId,
          dataSourceId: model.dataSourceId,
          propertyId: property.propertyId,
          edit: {
            kind: "replace",
            expectedValueRevision: row.database_value_revisions[propertyId] ?? 0,
            value,
          },
        },
      ],
    };
  };
  const recipe = (receipt: Awaited<ReturnType<typeof apply>>) => {
    expect(receipt.operationOutcomes).toHaveLength(1);
    const outcome = receipt.operationOutcomes[0];
    if (outcome?.kind !== "data_edit" || !outcome.undoRecipe)
      throw new Error("Missing whole-gesture inverse");
    expect(outcome.operationIndex).toBe(0);
    expect(outcome.operationCount).toBe(receipt.operationKinds.length);
    return outcome.undoRecipe;
  };
  const reverse = (recipe: DatabaseDataEditUndoRecipeV2, operationId?: string) =>
    apply([{ kind: "reverse_data_edit", recipe }], operationId);
  return { read, readRow, apply, edit, recipe, reverse };
};

test.each(["data", "list"] as const)(
  "%s history authorizes before comparing a foreign Project's property values",
  async (kind) => {
    await withCoreScenario(scenario, async (ctx) => {
      const db = database(ctx);
      const model = await db.read();
      const pageId = ctx.manifest.pageIdsByKey.source!;
      const before = await db.readRow(pageId);
      const foreign = await ctx.seed.createProject({
        name: "Separate history authority",
        sources: [ctx.profile.initialProjectsDirectory],
      });
      const client = ctx.runtime.clientForProject(foreign.id);
      await expect(
        client.databaseRead({ kind: "row_detail", page_id: pageId }),
      ).rejects.toMatchObject({
        coreError: { code: "unauthorized" },
      });
      const adapter = createCoreDatabaseModuleAdapter({
        ...ctx.runtime.identity,
        projectId: foreign.id,
        client,
      });
      for (const guess of ["review", "build"]) {
        const result = await adapter.apply({
          operationId: createUuidV7(),
          projectId: foreign.id,
          storeEpoch: model.storeEpoch,
          actor: { kind: "test" },
          operations: [
            kind === "data"
              ? {
                  kind: "reverse_data_edit",
                  recipe: {
                    propertyStates: [
                      {
                        address: {
                          dataSourceId: model.dataSourceId,
                          pageId,
                          propertyId: statusPropertyId,
                        },
                        propertyType: "select",
                        beforeValue: statusValue("ship"),
                        afterValue: statusValue(guess),
                      },
                    ],
                    positionStates: [],
                  },
                }
              : {
                  kind: "undo_list_occurrence_move",
                  recipe: {
                    viewId: model.databaseViewId,
                    dataSourceId: model.dataSourceId,
                    propertyStates: [
                      {
                        pageId,
                        propertyId: statusPropertyId,
                        beforeValue: statusValue("ship"),
                        afterValue: statusValue(guess),
                      },
                    ],
                    postParentGuards: [{ pageId, parentPageId: null }],
                    postOrderRuns: [],
                    restoreRuns: [{ pageIds: [pageId], parentPageId: null, beforePageId: null }],
                  },
                },
          ],
        });
        expect(result).toMatchObject({ ok: false, error: { code: "authorization_denied" } });
      }
      expect(await db.readRow(pageId)).toEqual(before);
    });
  },
);

test("history authorizes its complete batch before any permitted item can conflict or commit", async () => {
  await withCoreScenario(scenario, async (ctx) => {
    const db = database(ctx);
    const protectedModel = await db.read();
    const protectedPageId = ctx.manifest.pageIdsByKey.source!;
    const other = await ctx.seed.createProject({
      name: "Own and restricted history",
      sources: [ctx.profile.initialProjectsDirectory],
    });
    const ownPageId = createUuidV7();
    await ctx.seed.createPage({
      key: "authorized-history-row",
      pageId: ownPageId,
      projectId: other.id,
      operationId: createUuidV7(),
      status: "build",
      title: "Permitted row",
      nfm: "Independent content",
    });
    const ownModel = buildDatabaseViewWindowRenderModel(
      await runScenarioDatabase(ctx.runtime, (module) =>
        module.viewWindow(
          { kind: "project", projectId: other.id },
          {
            databaseViewId: parseDatabaseViewId(other.defaultDatabaseViewId!),
            first: 100,
          },
        ),
      ),
    );
    const client = ctx.runtime.clientForProject(other.id);
    const adapter = createCoreDatabaseModuleAdapter({
      ...ctx.runtime.identity,
      projectId: other.id,
      client,
    });
    const beforeOwn = await client.databaseRead({ kind: "row_detail", page_id: ownPageId });
    const beforeProtected = await db.readRow(protectedPageId);
    const beforeCommit = (
      await ctx.seed.readBoard(ctx.manifest.projectId, protectedModel.databaseViewId)
    ).commitSeq;
    for (const ownPostValue of ["build", "review"]) {
      const result = await adapter.apply({
        operationId: createUuidV7(),
        projectId: other.id,
        storeEpoch: ownModel.storeEpoch,
        actor: { kind: "test" },
        operations: [
          {
            kind: "reverse_data_edit",
            recipe: {
              propertyStates: [
                {
                  address: {
                    dataSourceId: ownModel.dataSourceId,
                    pageId: ownPageId,
                    propertyId: statusPropertyId,
                  },
                  propertyType: "select",
                  beforeValue: statusValue("ship"),
                  afterValue: statusValue(ownPostValue),
                },
                {
                  address: {
                    dataSourceId: protectedModel.dataSourceId,
                    pageId: protectedPageId,
                    propertyId: statusPropertyId,
                  },
                  propertyType: "select",
                  beforeValue: statusValue("ship"),
                  afterValue: statusValue("build"),
                },
              ],
              positionStates: [],
            },
          },
        ],
      });
      expect(result).toMatchObject({ ok: false, error: { code: "authorization_denied" } });
    }
    expect((await client.databaseRead({ kind: "row_detail", page_id: ownPageId })).value).toEqual(
      beforeOwn.value,
    );
    expect(await db.readRow(protectedPageId)).toEqual(beforeProtected);
    expect(
      (await ctx.seed.readBoard(ctx.manifest.projectId, protectedModel.databaseViewId)).commitSeq,
    ).toBe(beforeCommit);
  });
});

test.each(["project", "library"] as const)(
  "%s: complete data gestures preserve order, recover exact replies and guard the entire inverse",
  async (access) => {
    await withCoreScenario(scenario, async (ctx) => {
      const db = database(ctx, access);
      const pages = [ctx.manifest.pageIdsByKey.source!, ctx.manifest.pageIdsByKey.other!];
      const statuses = async () =>
        (await db.read()).query.rows.map((row) => row.values.status?.value);
      const a = db.recipe(
        await db.apply(
          await Promise.all(pages.map((page) => db.edit(page, "status", statusValue("review")))),
        ),
      );
      expect(a.propertyStates).toHaveLength(2);
      expect(a.propertyStates.map((state) => state.address.pageId)).toEqual(
        expect.arrayContaining(pages),
      );
      const b = db.recipe(
        await db.apply([await db.edit(pages[0]!, "status", statusValue("ship"))]),
      );
      await expect(db.reverse(a)).rejects.toThrow(/changed/);
      expect(await statuses()).toEqual(expect.arrayContaining(["ship", "review"]));
      const redoB = db.recipe(await db.reverse(b));
      const operationId = createUuidV7();
      const undone = await db.reverse(a, operationId);
      const duplicate = await db.reverse(a, operationId);
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.commitSeq).toBe(undone.commitSeq);
      expect(duplicate.operationOutcomes).toEqual(undone.operationOutcomes);
      expect(await statuses()).toEqual(["build", "build"]);
      await db.reverse(db.recipe(undone));
      await db.reverse(redoB);
      expect(await statuses()).toEqual(expect.arrayContaining(["ship", "review"]));
      const noChange = await db.apply([await db.edit(pages[0]!, "status", statusValue("ship"))]);
      expect(noChange.operationOutcomes).toEqual([
        { kind: "data_edit", operationIndex: 0, operationCount: 1, undoRecipe: null },
      ]);
      await expect(
        db.reverse({ ...b, propertyStates: [...b.propertyStates, ...b.propertyStates] }),
      ).rejects.toThrow(/repeat|duplicat/i);
    });
  },
);

test.each(["asc", "desc"] as const)(
  "%s: real View move builders and data Undo follow visual order for single and multi-row gestures",
  async (direction) => {
    await withCoreScenario(scenario, async (ctx) => {
      const db = database(ctx);
      for (const key of ["third", "fourth"]) {
        await ctx.seed.createPage({
          key,
          pageId: createUuidV7(),
          projectId: ctx.manifest.projectId,
          operationId: createUuidV7(),
          status: "build",
          title: key,
          nfm: "Body",
        });
      }
      const initial = await db.read();
      const view = initial.query.view;
      await db.apply([
        {
          kind: "put_view",
          databaseId: view.databaseId,
          dataSourceId: view.dataSourceId,
          viewId: view.viewId,
          expectedRevision: view.revision,
          name: view.name,
          layout: view.layout,
          isDefault: view.isDefault,
          config: {
            ...view.config,
            rules: {
              ...view.config.rules,
              propertyFilters: [],
              advancedFilter: null,
              sorts: [{ field: { kind: "manual" }, direction, nulls: "last" }],
            },
            presentation: { ...view.config.presentation, group: null, subgroup: null },
          },
        },
      ]);
      const unpositioned = await db.read();
      await db.apply([
        {
          kind: "position_pages",
          viewId: view.viewId,
          pages: unpositioned.query.rows.map((row) => ({
            pageId: row.page.pageId,
            expectedPositionRevision: row.position?.revision ?? 0,
          })),
        },
      ]);
      for (const mode of ["single", "complete", "run"] as const) {
        const model = await db.read();
        const ids = model.query.rows.map((row) => row.page.pageId);
        expect(ids).toHaveLength(4);
        const operations =
          mode === "run"
            ? buildDatabaseViewMovePageRunOperations({
                model,
                pageIds: ids.slice(2),
                direction: "top",
                groupComplete: true,
              })
            : buildDatabaseViewMoveOperations({
                model,
                pageId: ids[2]!,
                direction: "top",
                groupComplete: mode === "complete",
              });
        expect(operations).toHaveLength(1);
        const history = createDatabaseViewMutationHistory(databaseViewHistoryScopeKey(model));
        const commit: typeof commitDatabaseViewOperations = (request) =>
          db.apply(request.operations, request.operationId);
        await history.executeOperations({ model, operations, commitOperations: commit });
        const expected =
          mode === "run" ? [...ids.slice(2), ...ids.slice(0, 2)] : [ids[2], ids[0], ids[1], ids[3]];
        expect((await db.read()).query.rows.map((row) => row.page.pageId)).toEqual(expected);
        await history.executeOperations({
          model,
          operations: [await db.edit(ids[2]!, "status", statusValue("review"))],
          commitOperations: commit,
        });
        expect(await history.undoLast()).toBe(true);
        expect((await db.read()).query.rows.map((row) => row.page.pageId)).toEqual(expected);
        expect(
          (await db.read()).query.rows.find((row) => row.page.pageId === ids[2])?.values.status
            ?.value,
        ).toBe("build");
        expect(await history.undoLast()).toBe(true);
        expect((await db.read()).query.rows.map((row) => row.page.pageId)).toEqual(ids);
      }
      const beforeBatch = await db.read();
      const beforeIds = beforeBatch.query.rows.map((row) => row.page.pageId);
      const affected = beforeIds[2]!;
      const combined = db.recipe(
        await db.apply([
          ...buildDatabaseViewMoveOperations({
            model: beforeBatch,
            pageId: affected,
            direction: "top",
            groupComplete: true,
          }),
          await db.edit(affected, "status", statusValue("review")),
        ]),
      );
      expect(combined.propertyStates).toHaveLength(1);
      expect(combined.positionStates).toHaveLength(1);
      const later = db.recipe(
        await db.apply(
          buildDatabaseViewMoveOperations({
            model: await db.read(),
            pageId: affected,
            direction: "bottom",
            groupComplete: true,
          }),
        ),
      );
      await expect(db.reverse(combined)).rejects.toThrow(/order|changed/);
      expect(
        (await db.read()).query.rows.find((row) => row.page.pageId === affected)?.values.status
          ?.value,
      ).toBe("review");
      await db.reverse(later);
      const redoCombined = db.recipe(await db.reverse(combined));
      expect((await db.read()).query.rows.map((row) => row.page.pageId)).toEqual(beforeIds);
      expect(
        (await db.read()).query.rows.find((row) => row.page.pageId === affected)?.values.status
          ?.value,
      ).toBe("build");
      await db.reverse(redoCombined);
      expect((await db.read()).query.rows[0]?.page.pageId).toBe(affected);
      const beforeDirection = (await db.read()).query.view;
      await db.apply([
        {
          kind: "put_view",
          databaseId: beforeDirection.databaseId,
          dataSourceId: beforeDirection.dataSourceId,
          viewId: beforeDirection.viewId,
          expectedRevision: beforeDirection.revision,
          name: beforeDirection.name,
          layout: beforeDirection.layout,
          isDefault: beforeDirection.isDefault,
          config: {
            ...beforeDirection.config,
            rules: {
              ...beforeDirection.config.rules,
              sorts: [
                {
                  field: { kind: "manual" },
                  direction: direction === "asc" ? "desc" : "asc",
                  nulls: "last",
                },
              ],
            },
          },
        },
      ]);
      await expect(db.reverse(combined)).rejects.toThrow(/View changed/);
    });
  },
);

test("scalar codecs, set patches, option/schema guards and authority all survive canonical replay", async () => {
  await withCoreScenario(scenario, async (ctx) => {
    const db = database(ctx);
    const pageId = ctx.manifest.pageIdsByKey.source!;
    const optionId = createCustomOptionId();
    const cases: readonly {
      schema: DatabasePropertySchemaV2;
      value: DatabasePropertyValueInputV2;
    }[] = [
      { schema: { kind: "text" }, value: { kind: "text", value: "  原文\n\t尾部  " } },
      {
        schema: { kind: "number", format: { kind: "plain" } },
        value: { kind: "number", value: -12.5 },
      },
      { schema: { kind: "checkbox" }, value: { kind: "checkbox", value: false } },
      { schema: { kind: "select" }, value: { kind: "select", optionId } },
      { schema: { kind: "multi_select" }, value: { kind: "multi_select", optionIds: [optionId] } },
      {
        schema: { kind: "date", dateFormat: "year_month_day" },
        value: { kind: "date", value: "2026-09-05" },
      },
      {
        schema: { kind: "datetime", dateFormat: "year_month_day", timeFormat: "twenty_four_hour" },
        value: { kind: "datetime", value: "2026-09-05T00:00:00.000Z" },
      },
    ];
    const properties: Array<
      (typeof cases)[number] & { readonly propertyId: ReturnType<typeof createCustomPropertyId> }
    > = [];
    for (const entry of cases) {
      const model = await db.read();
      const propertyId = createCustomPropertyId();
      await db.apply([
        {
          kind: "put_property",
          dataSourceId: model.dataSourceId,
          propertyId,
          expectedDataSourceRevision: model.query.dataSource.schemaRevision,
          expectedPropertyRevision: 0,
          name: entry.schema.kind,
          schema: entry.schema,
        },
      ]);
      if (entry.schema.kind === "select" || entry.schema.kind === "multi_select") {
        await db.apply([
          {
            kind: "put_option",
            dataSourceId: model.dataSourceId,
            propertyId,
            optionId,
            name: "Alpha",
            expectedPropertyRevision: 1,
          },
        ]);
      }
      properties.push({ ...entry, propertyId });
    }
    const initial = await db.read();
    const visible = initial.query.view;
    // Row summaries intentionally project visible fields, including their CAS revisions.
    await db.apply([
      {
        kind: "put_view",
        databaseId: visible.databaseId,
        dataSourceId: visible.dataSourceId,
        viewId: visible.viewId,
        expectedRevision: visible.revision,
        name: visible.name,
        layout: visible.layout,
        isDefault: visible.isDefault,
        config: {
          ...visible.config,
          presentation: {
            ...visible.config.presentation,
            display: {
              ...visible.config.presentation.display,
              fields: [
                ...visible.config.presentation.display.fields,
                ...properties.map(({ propertyId }) => ({ kind: "property" as const, propertyId })),
              ],
            },
          },
        },
      },
    ]);
    const edits = await Promise.all(
      properties.map((entry) => db.edit(pageId, entry.propertyId, entry.value)),
    );
    const gesture = db.recipe(await db.apply(edits));
    expect(gesture.propertyStates).toHaveLength(7);
    const readValues = async () => {
      const row = await db.readRow(pageId);
      return properties.map(({ propertyId }) => row.database_values[propertyId] ?? null);
    };
    const after = await readValues();
    expect(after).toEqual([
      "  原文\n\t尾部  ",
      -12.5,
      false,
      optionId,
      [optionId],
      "2026-09-05",
      "2026-09-05T00:00:00.000Z",
    ]);
    const redo = db.recipe(await db.reverse(gesture));
    expect(await readValues()).toEqual(Array(7).fill(null));
    await db.reverse(redo);
    expect(await readValues()).toEqual(after);
    const multi = properties.find((entry) => entry.schema.kind === "multi_select")!;
    const patch = db.recipe(
      await db.apply([
        {
          kind: "edit_property_values",
          edits: [
            {
              pageId,
              dataSourceId: initial.dataSourceId,
              propertyId: multi.propertyId,
              edit: {
                kind: "patch_set",
                delta: { kind: "multi_select", addOptionIds: [], removeOptionIds: [optionId] },
              },
            },
          ],
        },
      ]),
    );
    await db.reverse(patch);
    expect(await readValues()).toEqual(after);
    const empty = db.recipe(
      await db.apply([
        await db.edit(pageId, properties[0]!.propertyId, { kind: "text", value: "" }),
      ]),
    );
    await db.reverse(empty);
    expect(await readValues()).toEqual(after);
    const foreign = await ctx.seed.createProject({
      name: "Other authority",
      sources: [ctx.profile.initialProjectsDirectory],
    });
    const otherAdapter = createCoreDatabaseModuleAdapter({
      ...ctx.runtime.identity,
      projectId: foreign.id,
      client: ctx.runtime.clientForProject(foreign.id),
    });
    const denied = await otherAdapter.apply({
      operationId: createUuidV7(),
      projectId: foreign.id,
      storeEpoch: initial.storeEpoch,
      actor: { kind: "test" },
      operations: [{ kind: "reverse_data_edit", recipe: gesture }],
    });
    expect(denied.ok).toBe(false);
    expect(await readValues()).toEqual(after);
    const select = properties.find((entry) => entry.schema.kind === "select")!;
    const clearing = db.recipe(
      await db.apply([
        await db.edit(pageId, select.propertyId, { kind: "empty" }),
        await db.edit(pageId, properties[0]!.propertyId, { kind: "text", value: "newer" }),
      ]),
    );
    const beforeDelete = await db.read();
    await db.apply([
      {
        kind: "delete_option",
        dataSourceId: initial.dataSourceId,
        propertyId: select.propertyId,
        optionId,
        expectedPropertyRevision: beforeDelete.query.properties.find(
          (entry) => entry.propertyId === select.propertyId,
        )!.revision,
      },
    ]);
    const preserved = await readValues();
    await expect(db.reverse(clearing)).rejects.toThrow(/option/i);
    expect(await readValues()).toEqual(preserved);
    const beforeTypeInverse = db.recipe(
      await db.apply([await db.edit(pageId, multi.propertyId, { kind: "empty" })]),
    );
    const beforeType = await db.read();
    const property = beforeType.query.properties.find(
      (entry) => entry.propertyId === multi.propertyId,
    )!;
    await db.apply([
      {
        kind: "change_property_type",
        dataSourceId: initial.dataSourceId,
        propertyId: multi.propertyId,
        expectedDataSourceRevision: beforeType.query.dataSource.schemaRevision,
        expectedPropertyRevision: property.revision,
        schema: { kind: "text" },
      },
    ]);
    await expect(db.reverse(beforeTypeInverse)).rejects.toThrow(/changed/);
  });
});
