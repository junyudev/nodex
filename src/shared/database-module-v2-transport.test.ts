import { describe, expect, test } from "vite-plus/test";
import { noOpLocalCommit } from "./testing/local-commit";
import {
  bindDatabaseApplyV2,
  bindDatabaseModuleReadV2,
  bindLibraryDatabaseApplyV2,
  bindLibraryDatabaseModuleReadV2,
  databaseModuleFailureV2,
  databaseModuleHttpStatusV2,
  parseDatabaseApplyResultV2,
  parseDatabaseModuleReadResultV2,
  parseLibraryDatabaseApplyResultV2,
  parseLibraryDatabaseModuleReadResultV2,
  parseDataSourcePropertyRecordV2,
} from "./database-module-v2-transport";

const CUSTOM_PROPERTY_ID = "p_abcdefgh";
const CUSTOM_OPTION_ID = "o_abcdefgh";

const applyRequest = () => ({
  operationId: "module-operation-2",
  projectId: "project-1",
  storeEpoch: "epoch-1",
  actor: { kind: "spoofed-renderer" },
  operations: [
    {
      kind: "put_property",
      dataSourceId: "source-1",
      propertyId: CUSTOM_PROPERTY_ID,
      expectedDataSourceRevision: 1,
      expectedPropertyRevision: 0,
      name: "Teams",
      schema: { kind: "multi_select" },
    },
    {
      kind: "put_option",
      dataSourceId: "source-1",
      propertyId: CUSTOM_PROPERTY_ID,
      optionId: CUSTOM_OPTION_ID,
      name: "Platform",
      color: "blue",
      expectedPropertyRevision: 0,
    },
    {
      kind: "edit_property_values",
      edits: [
        {
          pageId: "page-1",
          dataSourceId: "source-1",
          propertyId: CUSTOM_PROPERTY_ID,
          edit: {
            kind: "patch_set",
            delta: {
              kind: "multi_select",
              addOptionIds: [CUSTOM_OPTION_ID],
              removeOptionIds: [],
            },
          },
        },
      ],
    },
  ],
});

const dataSourceRecord = () => ({
  dataSourceId: "source-1",
  libraryId: "library-1",
  homeDatabaseId: "database-1",
  name: "Tasks",
  schemaKey: "tasks",
  schemaRevision: 2,
  lifecycle: "active",
  rankKey: "a",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
});

const propertyRecord = () => ({
  propertyId: CUSTOM_PROPERTY_ID,
  dataSourceId: "source-1",
  name: "Teams",
  schema: { kind: "multi_select" },
  capabilities: {
    filterOperators: [
      "multi_select_contains",
      "multi_select_does_not_contain",
      "multi_select_contains_all",
      "is_empty",
      "is_not_empty",
    ],
    sortable: true,
    groupable: true,
  },
  systemRole: null,
  nonEmptyValueCount: 0,
  referencedViewIds: [],
  managementPolicy: {
    canRename: true,
    canReorder: true,
    canChangeType: true,
    canDuplicate: true,
    canDelete: true,
    canRestore: false,
    canPermanentlyDelete: false,
    canManageOptions: true,
    allowedTypes: [
      "text",
      "number",
      "checkbox",
      "select",
      "multi_select",
      "date",
      "datetime",
      "relation",
    ],
    blockedReasons: [],
  },
  valueType: "multi_select",
  config: {},
  optionCount: 1,
  rankKey: "a",
  lifecycle: "active",
  revision: 2,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
});

describe("Database Module v2 transport boundary", () => {
  test("history codecs preserve content and reject partial or unbounded inverse scopes", () => {
    const recipe = {
      propertyStates: [
        {
          address: { pageId: "page-1", dataSourceId: "source-1", propertyId: CUSTOM_PROPERTY_ID },
          propertyType: "text",
          beforeValue: { kind: "text", value: "" },
          afterValue: { kind: "text", value: "  一\n二  " },
        },
      ],
      positionStates: [
        {
          viewId: "view-1",
          dataSourceId: "source-1",
          direction: "desc",
          beforeRuns: [{ pageIds: ["page-1"], beforePageId: "page-2" }],
          afterRuns: [{ pageIds: ["page-1"], beforePageId: null }],
        },
      ],
    };
    const bind = (value: unknown) =>
      bindDatabaseApplyV2(
        { ...applyRequest(), operations: [{ kind: "reverse_data_edit", recipe: value }] },
        "project-1",
        { actor: { kind: "test" } },
      );
    expect(bind(recipe).operations).toEqual([{ kind: "reverse_data_edit", recipe }]);
    expect(() =>
      bind({ ...recipe, propertyStates: [...recipe.propertyStates, ...recipe.propertyStates] }),
    ).toThrow(/repeats/);
    expect(() =>
      bind({
        ...recipe,
        positionStates: [
          {
            ...recipe.positionStates[0],
            afterRuns: [{ pageIds: ["other-page"], beforePageId: null }],
          },
        ],
      }),
    ).toThrow(/Page set/);
    expect(() =>
      bind({
        ...recipe,
        positionStates: [
          {
            ...recipe.positionStates[0],
            beforeRuns: [{ pageIds: ["page-1"], beforePageId: "page-1" }],
          },
        ],
      }),
    ).toThrow(/internal anchor/);
    expect(() => bind({ propertyStates: [], positionStates: [] })).toThrow(/identity budget/);
    expect(() =>
      bind({
        ...recipe,
        propertyStates: [
          {
            ...recipe.propertyStates[0],
            afterValue: { kind: "text", value: "x".repeat(8 * 1024 * 1024) },
          },
        ],
      }),
    ).toThrow(/history budget/);
    const receipt = {
      ok: true,
      localCommit: noOpLocalCommit("epoch-1", 5),
      value: {
        operationId: "operation-1",
        projectId: "project-1",
        libraryId: "library-1",
        storeEpoch: "epoch-1",
        duplicate: false,
        operationKinds: ["edit_property_values", "position_pages"],
        operationOutcomes: [
          { kind: "data_edit", operationIndex: 0, operationCount: 2, undoRecipe: recipe },
        ],
        affectedDatabaseIds: [],
        affectedDataSourceIds: ["source-1"],
        affectedPageIds: ["page-1"],
        affectedViewIds: ["view-1"],
        committedRevisions: {},
        commitSeq: 5,
        committedAt: "2026-09-05T00:00:00.000Z",
      },
    };
    expect(parseDatabaseApplyResultV2(receipt)).toEqual(receipt);
    expect(() =>
      parseDatabaseApplyResultV2({
        ...receipt,
        value: { ...receipt.value, operationKinds: ["put_option", "edit_property_values"] },
      }),
    ).toThrow(/whole-gesture/);
    expect(() =>
      parseDatabaseApplyResultV2({
        ...receipt,
        value: {
          ...receipt.value,
          operationOutcomes: [{ ...receipt.value.operationOutcomes[0], operationCount: 1 }],
        },
      }),
    ).toThrow(/whole-gesture/);
  });
  test("binds Page-key namespace reads and rename as Database authority", () => {
    expect(
      bindDatabaseModuleReadV2(
        {
          projectId: "project-1",
          read: {
            target: { kind: "page_key_namespace", databaseId: "database-1" },
            mode: "page_key_prefix_preview",
            nameHint: "Lab",
            requestedPrefix: "lab",
          },
        },
        "project-1",
      ),
    ).toMatchObject({
      read: {
        target: { kind: "page_key_namespace", databaseId: "database-1" },
        mode: "page_key_prefix_preview",
      },
    });
    expect(
      bindDatabaseModuleReadV2(
        {
          projectId: "project-1",
          read: {
            target: { kind: "database", databaseId: "database-1" },
            mode: "page_key_namespace",
          },
        },
        "project-1",
      ),
    ).toMatchObject({
      read: {
        target: { kind: "database", databaseId: "database-1" },
        mode: "page_key_namespace",
      },
    });
    expect(
      bindDatabaseApplyV2(
        {
          operationId: "operation:rename-key",
          projectId: "project-1",
          storeEpoch: "epoch-1",
          actor: {},
          operations: [
            {
              kind: "rename_page_key_prefix",
              databaseId: "database-1",
              expectedRevision: 2,
              prefix: "RND",
            },
          ],
        },
        "project-1",
        { actor: { kind: "electron_renderer" } },
      ),
    ).toMatchObject({
      operations: [
        {
          kind: "rename_page_key_prefix",
          databaseId: "database-1",
          expectedRevision: 2,
          prefix: "RND",
        },
      ],
    });
  });

  test("rejects Property option counts outside the canonical schema bound", () => {
    expect(() =>
      parseDataSourcePropertyRecordV2({
        ...propertyRecord(),
        optionCount: 101,
      }),
    ).toThrow("optionCount diverges from its Property schema");
    expect(() =>
      parseDataSourcePropertyRecordV2({
        ...propertyRecord(),
        schema: { kind: "text" },
        valueType: "text",
        capabilities: {
          ...propertyRecord().capabilities,
          filterOperators: [
            "text_is",
            "text_is_not",
            "text_contains",
            "text_does_not_contain",
            "text_starts_with",
            "text_ends_with",
            "is_empty",
            "is_not_empty",
          ],
        },
        optionCount: 1,
      }),
    ).toThrow("optionCount diverges from its Property schema");
  });

  test("binds ordered option creation and value writes under one apply", () => {
    const bound = bindDatabaseApplyV2(applyRequest(), "project-1", {
      actor: { kind: "electron_renderer", clientId: "window-1" },
    });

    expect(bound.actor).toEqual({
      kind: "electron_renderer",
      clientId: "window-1",
    });
    expect(bound.operations.map((operation) => operation.kind)).toEqual([
      "put_property",
      "put_option",
      "edit_property_values",
    ]);
    expect(bound.operations[1]).toMatchObject({
      propertyId: CUSTOM_PROPERTY_ID,
      optionId: CUSTOM_OPTION_ID,
      expectedPropertyRevision: 0,
    });
  });

  test("represents select creation and updates without carrying option membership", () => {
    const request = applyRequest();
    const bound = bindDatabaseApplyV2(
      {
        ...request,
        operations: [
          {
            kind: "put_property",
            dataSourceId: "source-1",
            propertyId: "status",
            expectedDataSourceRevision: 2,
            expectedPropertyRevision: 3,
            name: "Workflow",
            schema: { kind: "select" },
          },
        ],
      },
      "project-1",
      { actor: { kind: "test" } },
    );

    expect(bound.operations[0]).toMatchObject({
      kind: "put_property",
      propertyId: "status",
      expectedPropertyRevision: 3,
      schema: { kind: "select" },
    });
  });

  test("rejects a reserved Property with a non-canonical value type", () => {
    const request = applyRequest();
    expect(() =>
      bindDatabaseApplyV2(
        {
          ...request,
          operations: [
            {
              kind: "put_property",
              dataSourceId: "source-1",
              propertyId: "status",
              expectedDataSourceRevision: 2,
              expectedPropertyRevision: 3,
              name: "Workflow",
              schema: { kind: "multi_select" },
            },
          ],
        },
        "project-1",
        { actor: { kind: "test" } },
      ),
    ).toThrow("reserved Property status must use select");
  });

  test("rejects legacy inline config and the removed Property key", () => {
    const request = applyRequest();
    const property = request.operations[0];

    expect(() =>
      bindDatabaseApplyV2(
        {
          ...request,
          operations: [
            {
              ...property,
              config: {
                options: [{ id: CUSTOM_OPTION_ID, name: "Platform" }],
              },
            },
          ],
        },
        "project-1",
        { actor: { kind: "test" } },
      ),
    ).toThrow(".config is not supported");

    expect(() =>
      bindDatabaseApplyV2(
        {
          ...request,
          operations: [{ ...property, key: "teams" }],
        },
        "project-1",
        { actor: { kind: "test" } },
      ),
    ).toThrow(".key is not supported");
  });

  test("enforces compact Property IDs and owner-scoped option IDs", () => {
    const request = applyRequest();

    expect(() =>
      bindDatabaseApplyV2(
        {
          ...request,
          operations: [
            {
              ...request.operations[1],
              propertyId: "status",
              optionId: CUSTOM_OPTION_ID,
            },
          ],
        },
        "project-1",
        { actor: { kind: "test" } },
      ),
    ).toThrow("invalid for Property status");

    expect(() =>
      bindDatabaseApplyV2(
        {
          ...request,
          operations: [
            {
              ...request.operations[0],
              propertyId: "database:db:primary:property:database:db:primary:property:tags",
            },
          ],
        },
        "project-1",
        { actor: { kind: "test" } },
      ),
    ).toThrow("propertyId is invalid");
  });

  test("attests route scope and exact request fields", () => {
    const request = applyRequest();
    expect(() =>
      bindDatabaseApplyV2(request, "project-2", {
        actor: { kind: "test" },
      }),
    ).toThrow("does not match its Project route scope");
    expect(() =>
      bindDatabaseApplyV2({ ...request, version: 1 }, "project-1", { actor: { kind: "test" } }),
    ).toThrow("databaseApplyV2.version is not supported");
    expect(() =>
      bindDatabaseApplyV2({ ...request, databaseBlockId: "block-1" }, "project-1", {
        actor: { kind: "test" },
      }),
    ).toThrow("databaseApplyV2.databaseBlockId is not supported");
  });

  test("keeps presentation conflicts separate from per-occurrence disclosure", () => {
    const bound = bindDatabaseApplyV2(
      {
        operationId: "personal-view-state",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        actor: {},
        operations: [
          {
            kind: "put_view_personal_preferences",
            viewId: "view-1",
            expectedRevision: 4,
            rulesOverride: {},
            presentationOverride: {},
          },
          {
            kind: "set_view_occurrence_disclosure",
            viewId: "view-1",
            target: { kind: "page", occurrenceKey: "ITEM_parent/child" },
            collapsed: true,
          },
        ],
      },
      "project-1",
      { actor: { kind: "test" } },
    );
    expect(bound.operations).toEqual([
      {
        kind: "put_view_personal_preferences",
        viewId: "view-1",
        expectedRevision: 4,
        rulesOverride: {},
        presentationOverride: {},
      },
      {
        kind: "set_view_occurrence_disclosure",
        viewId: "view-1",
        target: { kind: "page", occurrenceKey: "ITEM_parent/child" },
        collapsed: true,
      },
    ]);

    for (const mode of ["view_personal_preferences", "view_collapsed_occurrences"] as const) {
      expect(
        bindDatabaseModuleReadV2(
          {
            projectId: "project-1",
            read: {
              target: { kind: "view", viewId: "view-1" },
              mode,
            },
          },
          "project-1",
        ).read.mode,
      ).toBe(mode);
    }

    expect(() =>
      bindDatabaseApplyV2(
        {
          operationId: "bad-disclosure-target",
          projectId: "project-1",
          storeEpoch: "epoch-1",
          actor: {},
          operations: [
            {
              kind: "set_view_occurrence_disclosure",
              viewId: "view-1",
              target: { kind: "group", occurrenceKey: "ITEM_parent/child" },
              collapsed: true,
            },
          ],
        },
        "project-1",
        { actor: { kind: "test" } },
      ),
    ).toThrow("does not match its occurrence kind");
  });

  test("rejects removed ad hoc query reads at the transport boundary", () => {
    expect(() =>
      bindDatabaseModuleReadV2(
        {
          projectId: "project-1",
          read: {
            target: { kind: "data_source", dataSourceId: "source-1" },
            mode: "query",
            filter: {
              kind: "clause",
              propertyId: CUSTOM_PROPERTY_ID,
              operator: "equals",
              value: CUSTOM_OPTION_ID,
            },
          },
        },
        "project-1",
      ),
    ).toThrow("target and mode are incompatible");

    expect(() =>
      bindDatabaseModuleReadV2(
        {
          projectId: "project-1",
          read: {
            target: { kind: "data_source", dataSourceId: "source-1" },
            mode: "query",
            sort: [
              {
                field: {
                  kind: "property",
                  propertyId: "database:db:primary:property:tags",
                },
                direction: "asc",
                nulls: "last",
              },
            ],
          },
        },
        "project-1",
      ),
    ).toThrow("target and mode are incompatible");
  });

  test("binds catalog and source-scoped Relation candidate windows", () => {
    expect(
      bindDatabaseModuleReadV2(
        {
          projectId: "project-1",
          read: {
            target: { kind: "project_default" },
            mode: "catalog_window",
            window: { first: 100 },
            minimumCommitSeq: 7,
          },
        },
        "project-1",
      ).read,
    ).toMatchObject({
      mode: "catalog_window",
      minimumCommitSeq: 7,
    });

    expect(
      bindDatabaseModuleReadV2(
        {
          projectId: "project-1",
          read: {
            target: { kind: "data_source", dataSourceId: "source-1" },
            mode: "relation_candidate_window",
            query: "blocked",
            window: { first: 25 },
          },
        },
        "project-1",
      ).read,
    ).toMatchObject({
      mode: "relation_candidate_window",
      query: "blocked",
      window: { first: 25 },
    });

    const unfiltered = bindDatabaseModuleReadV2(
      {
        projectId: "project-1",
        read: {
          target: { kind: "data_source", dataSourceId: "source-1" },
          mode: "relation_candidate_window",
          window: { first: 25 },
        },
      },
      "project-1",
    ).read;
    expect(unfiltered.mode).toBe("relation_candidate_window");
    expect("query" in unfiltered).toBe(false);
    expect(() =>
      bindDatabaseModuleReadV2(
        {
          projectId: "project-1",
          read: {
            target: { kind: "data_source", dataSourceId: "source-1" },
            mode: "relation_candidate_window",
            query: "",
          },
        },
        "project-1",
      ),
    ).toThrow("databaseModuleReadV2.read.query must be a canonical non-empty string");
    expect(() =>
      bindDatabaseModuleReadV2(
        {
          projectId: "project-1",
          read: {
            target: { kind: "data_source", dataSourceId: "source-1" },
            mode: "relation_candidate_window",
            query: "€".repeat(171),
          },
        },
        "project-1",
      ),
    ).toThrow("databaseModuleReadV2.read.query must be at most 512 UTF-8 bytes");
  });

  test("rejects Relation replacement and matches patch cardinality limits", () => {
    const replacementIds = Array.from({ length: 101 }, (_, index) => `page-${index}`);
    expect(() =>
      bindDatabaseApplyV2(
        {
          operationId: "relation-replace",
          projectId: "project-1",
          storeEpoch: "epoch-1",
          actor: {},
          operations: [
            {
              kind: "edit_property_values",
              edits: [
                {
                  pageId: "page-source",
                  dataSourceId: "source-1",
                  propertyId: CUSTOM_PROPERTY_ID,
                  edit: {
                    kind: "replace",
                    expectedValueRevision: 1,
                    value: { kind: "relation", pageIds: replacementIds },
                  },
                },
              ],
            },
          ],
        },
        "project-1",
        { actor: { kind: "test" } },
      ),
    ).toThrow("databaseApplyV2.operations[0].edits[0].edit.value.kind is unsupported");

    const replaceOne = bindDatabaseApplyV2(
      {
        operationId: "relation-clear",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        actor: {},
        operations: [
          {
            kind: "edit_property_values",
            edits: [
              {
                pageId: "page-source",
                dataSourceId: "source-1",
                propertyId: CUSTOM_PROPERTY_ID,
                edit: {
                  kind: "replace_one_relation",
                  expectedValueRevision: 7,
                  targetPageId: "page:parent",
                },
              },
            ],
          },
        ],
      },
      "project-1",
      { actor: { kind: "test" } },
    );
    expect(
      replaceOne.operations[0]?.kind === "edit_property_values"
        ? replaceOne.operations[0].edits[0]?.edit
        : null,
    ).toEqual({
      kind: "replace_one_relation",
      expectedValueRevision: 7,
      targetPageId: "page:parent",
    });

    const clearMany = bindDatabaseApplyV2(
      {
        operationId: "relation-clear-many",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        actor: {},
        operations: [
          {
            kind: "edit_property_values",
            edits: [
              {
                pageId: "page-source",
                dataSourceId: "source-1",
                propertyId: CUSTOM_PROPERTY_ID,
                edit: {
                  kind: "clear_many_relation",
                  expectedValueRevision: 8,
                },
              },
            ],
          },
        ],
      },
      "project-1",
      { actor: { kind: "test" } },
    );
    expect(
      clearMany.operations[0]?.kind === "edit_property_values"
        ? clearMany.operations[0].edits[0]?.edit
        : null,
    ).toEqual({ kind: "clear_many_relation", expectedValueRevision: 8 });

    expect(() =>
      bindDatabaseApplyV2(
        {
          operationId: "relation-patch",
          projectId: "project-1",
          storeEpoch: "epoch-1",
          actor: {},
          operations: [
            {
              kind: "edit_property_values",
              edits: [
                {
                  pageId: "page-source",
                  dataSourceId: "source-1",
                  propertyId: CUSTOM_PROPERTY_ID,
                  edit: {
                    kind: "patch_set",
                    delta: {
                      kind: "relation",
                      addPageIds: Array.from({ length: 60 }, (_, index) => `add-${index}`),
                      removeEdgeIds: Array.from({ length: 41 }, (_, index) =>
                        index.toString(16).padStart(64, "0"),
                      ),
                    },
                  },
                },
              ],
            },
          ],
        },
        "project-1",
        { actor: { kind: "test" } },
      ),
    ).toThrow("may change at most 100 Relation targets");
  });

  test("binds task-parent runs to Relation value revisions", () => {
    const request = bindDatabaseApplyV2(
      {
        operationId: "task-parent-run",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        actor: {},
        operations: [
          {
            kind: "set_task_parent",
            dataSourceId: "source-1",
            pages: [{ pageId: "page:child", expectedValueRevision: 4 }],
            parentPageId: "page:parent",
          },
        ],
      },
      "project-1",
      { actor: { kind: "test" } },
    );

    expect(request.operations[0]).toEqual({
      kind: "set_task_parent",
      dataSourceId: "source-1",
      pages: [{ pageId: "page:child", expectedValueRevision: 4 }],
      parentPageId: "page:parent",
    });
  });

  test("parses typed Property descriptors while rejecting the removed key field", () => {
    const result = {
      ok: true,
      value: {
        projectId: "project-1",
        libraryId: "library-1",
        storeEpoch: "epoch-1",
        commitSeq: 4,
        authorization: null,
        value: {
          kind: "data_source",
          value: {
            dataSource: dataSourceRecord(),
            properties: [propertyRecord()],
          },
        },
      },
    };

    expect(parseDatabaseModuleReadResultV2(result)).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "data_source",
          value: {
            properties: [{ propertyId: CUSTOM_PROPERTY_ID }],
          },
        },
      },
    });
    expect(() =>
      parseDatabaseModuleReadResultV2({
        ...result,
        value: {
          ...result.value,
          value: {
            kind: "data_source",
            value: {
              dataSource: dataSourceRecord(),
              properties: [{ ...propertyRecord(), key: "teams" }],
            },
          },
        },
      }),
    ).toThrow(".key is not supported");

    expect(() =>
      parseDatabaseModuleReadResultV2({
        ...result,
        value: {
          ...result.value,
          value: {
            kind: "data_source",
            value: {
              dataSource: dataSourceRecord(),
              properties: [{ ...propertyRecord(), lifecycle: "archived" }],
            },
          },
        },
      }),
    ).toThrow(".lifecycle is unsupported");
  });

  test("parses independently versioned presentation and sparse disclosure reads", () => {
    const envelope = (value: unknown) => ({
      ok: true,
      value: {
        projectId: "project-1",
        libraryId: "library-1",
        storeEpoch: "epoch-1",
        commitSeq: 4,
        authorization: null,
        value,
      },
    });
    expect(
      parseDatabaseModuleReadResultV2(
        envelope({
          kind: "view_personal_preferences",
          value: { rulesOverride: {}, presentationOverride: {}, revision: 5 },
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "view_personal_preferences",
          value: { revision: 5 },
        },
      },
    });
    expect(
      parseDatabaseModuleReadResultV2(
        envelope({
          kind: "view_collapsed_occurrences",
          value: {
            targets: [
              { kind: "group", occurrenceKey: 'GROUP_"ship"' },
              { kind: "page", occurrenceKey: "ITEM_parent/child" },
            ],
          },
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "view_collapsed_occurrences",
          value: { targets: [{ kind: "group" }, { kind: "page" }] },
        },
      },
    });
    expect(() =>
      parseDatabaseModuleReadResultV2(
        envelope({
          kind: "view_collapsed_occurrences",
          value: {
            targets: [
              { kind: "page", occurrenceKey: "ITEM_parent/child" },
              { kind: "page", occurrenceKey: "ITEM_parent/child" },
            ],
          },
        }),
      ),
    ).toThrow("must contain unique targets");
  });

  test("admits only unique opaque handles in Relation target windows", () => {
    const edgeId = "a".repeat(64);
    const result = {
      ok: true,
      value: {
        projectId: "project-1",
        libraryId: "library-1",
        storeEpoch: "epoch-1",
        commitSeq: 4,
        authorization: null,
        value: {
          kind: "relation_target_window",
          value: {
            valueRevision: 3,
            totalCount: 1,
            targets: [{ kind: "restricted", edgeId }],
            nextCursor: null,
            projectionRevision: 4,
          },
        },
      },
    };

    expect(parseDatabaseModuleReadResultV2(result)).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "relation_target_window",
          value: { targets: [{ kind: "restricted", edgeId }] },
        },
      },
    });
    expect(() =>
      parseDatabaseModuleReadResultV2({
        ...result,
        value: {
          ...result.value,
          value: {
            ...result.value.value,
            value: {
              ...result.value.value.value,
              targets: [{ kind: "restricted", edgeId: "page-hidden" }],
            },
          },
        },
      }),
    ).toThrow("must be an opaque Relation edge handle");
    expect(() =>
      parseDatabaseModuleReadResultV2({
        ...result,
        value: {
          ...result.value,
          value: {
            ...result.value.value,
            value: {
              ...result.value.value.value,
              totalCount: 2,
              targets: [
                { kind: "restricted", edgeId },
                { kind: "restricted", edgeId },
              ],
            },
          },
        },
      }),
    ).toThrow("contains duplicate edge handles");
  });

  test("round-trips identity conflicts and validates strict apply receipts", () => {
    const conflict = databaseModuleFailureV2(
      "identity_conflict",
      "Property identity is already owned",
      "operation-1",
    );
    expect(databaseModuleHttpStatusV2(conflict)).toBe(409);
    expect(parseDatabaseApplyResultV2({ ok: false, error: conflict })).toEqual({
      ok: false,
      error: conflict,
    });

    const receipt = {
      ok: true,
      localCommit: noOpLocalCommit("epoch-1", 5),
      value: {
        operationId: "operation-1",
        projectId: "project-1",
        libraryId: "library-1",
        storeEpoch: "epoch-1",
        duplicate: false,
        operationKinds: ["put_option", "edit_property_values"],
        operationOutcomes: [],
        affectedDatabaseIds: ["database-1"],
        affectedDataSourceIds: ["source-1"],
        affectedPageIds: ["page-1"],
        affectedViewIds: ["view-1"],
        committedRevisions: { [`property:${CUSTOM_PROPERTY_ID}`]: 2 },
        commitSeq: 5,
        committedAt: "2026-07-18T00:00:00.000Z",
      },
    };
    expect(parseDatabaseApplyResultV2(receipt)).toMatchObject({ ok: true });
    expect(() =>
      parseDatabaseApplyResultV2({
        ...receipt,
        value: {
          ...receipt.value,
          affectedDataSourceIds: ["source-1", "source-1"],
        },
      }),
    ).toThrow("must contain unique identities");
  });

  test("binds and parses Library reads and writes without a Project coordinate", () => {
    const boundRead = bindLibraryDatabaseModuleReadV2({
      read: {
        target: { kind: "data_source", dataSourceId: "source-1" },
        mode: "data_source",
        minimumCommitSeq: 4,
      },
    });
    expect(boundRead).toEqual({
      read: {
        target: { kind: "data_source", dataSourceId: "source-1" },
        mode: "data_source",
        minimumCommitSeq: 4,
      },
    });
    expect(() =>
      bindLibraryDatabaseModuleReadV2({
        read: { target: { kind: "project_default" }, mode: "database" },
      }),
    ).toThrow("require a concrete Database");

    expect(
      bindLibraryDatabaseApplyV2({
        operationId: "library-operation-1",
        storeEpoch: "epoch-1",
        operations: [
          {
            kind: "put_option",
            dataSourceId: "source-1",
            propertyId: CUSTOM_PROPERTY_ID,
            optionId: CUSTOM_OPTION_ID,
            name: "Platform",
            expectedPropertyRevision: 2,
          },
        ],
      }),
    ).toEqual({
      operationId: "library-operation-1",
      storeEpoch: "epoch-1",
      operations: [
        {
          kind: "put_option",
          dataSourceId: "source-1",
          propertyId: CUSTOM_PROPERTY_ID,
          optionId: CUSTOM_OPTION_ID,
          name: "Platform",
          expectedPropertyRevision: 2,
        },
      ],
    });

    const read = parseLibraryDatabaseModuleReadResultV2({
      ok: true,
      value: {
        accessContext: { kind: "library" },
        libraryId: "library-1",
        storeEpoch: "epoch-1",
        commitSeq: 4,
        authorization: null,
        value: {
          kind: "data_source",
          value: {
            dataSource: dataSourceRecord(),
            properties: [propertyRecord()],
          },
        },
      },
    });
    expect(read).toMatchObject({
      ok: true,
      value: { accessContext: { kind: "library" } },
    });
    if (read.ok) expect("projectId" in read.value).toBe(false);

    const apply = parseLibraryDatabaseApplyResultV2({
      ok: true,
      localCommit: noOpLocalCommit("epoch-1", 5),
      value: {
        operationId: "operation-1",
        accessContext: { kind: "library" },
        libraryId: "library-1",
        storeEpoch: "epoch-1",
        duplicate: false,
        operationKinds: ["put_option"],
        operationOutcomes: [],
        affectedDatabaseIds: ["database-1"],
        affectedDataSourceIds: ["source-1"],
        affectedPageIds: [],
        affectedViewIds: [],
        committedRevisions: {},
        commitSeq: 5,
        committedAt: "2026-07-18T00:00:00.000Z",
      },
    });
    expect(apply).toMatchObject({
      ok: true,
      value: { accessContext: { kind: "library" } },
    });
    if (apply.ok) expect("projectId" in apply.value).toBe(false);
  });
});
