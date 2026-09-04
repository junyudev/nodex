import { describe, expect, test } from "vite-plus/test";

import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import { committedLocalCommit } from "../../shared/testing/local-commit";
import { authorizedReadStampFixture } from "../../shared/testing/authorized-read-stamp-fixture";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourceOptionId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import {
  createCoreDatabaseModuleAdapter,
  createCoreLibraryDatabaseModuleAdapter,
  mapCoreDatabaseModuleError,
  mapCorePropertyDescriptor,
  toCoreDatabaseIntent,
} from "./database-module-adapter";
import { FakeCoreClient } from "./testing/fake-core-client";

const identity = {
  projectId: "project:test",
  libraryId: "library:test",
  profileId: "profile:test",
  storeEpoch: "epoch:test",
} as const;

test("maps bounded Page-key failures without losing their typed recovery", () => {
  expect(
    mapCoreDatabaseModuleError({
      code: "idempotency_window_expired",
      message: "Receipt expired",
      recovery: { kind: "none" },
      retryable: false,
    }).code,
  ).toBe("recovery_required");
  expect(
    mapCoreDatabaseModuleError({
      code: "conflict",
      message: "Prefix was claimed",
      recovery: { kind: "none" },
      retryable: false,
    }).code,
  ).toBe("identity_conflict");
  expect(
    mapCoreDatabaseModuleError({
      code: "resource_exhausted",
      message: "Automatic prefix family is exhausted",
      recovery: { kind: "none" },
      retryable: false,
    }).code,
  ).toBe("resource_exhausted");
});

const databaseRecord = () => ({
  databaseId: "database:test",
  libraryId: identity.libraryId,
  name: "Tasks",
  lifecycle: "active",
  defaultViewId: null,
  accessRevision: 1,
  metadataRevision: 1,
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
});

const coreDatabaseRecord = () => ({
  database_id: "database:test",
  library_id: identity.libraryId,
  name: "Tasks",
  lifecycle: "active",
  default_view_id: null,
  access_revision: 1,
  metadata_revision: 1,
  created_at: "2026-07-25T00:00:00.000Z",
  updated_at: "2026-07-25T00:00:00.000Z",
});

const coreDataSourceRecord = (schemaRevision = 1) => ({
  data_source_id: "source:test",
  library_id: identity.libraryId,
  home_database_id: "database:test",
  name: "Tasks",
  schema_key: "nodex.database",
  schema_revision: schemaRevision,
  lifecycle: "active",
  rank_key: "a",
  created_at: "2026-07-25T00:00:00.000Z",
  updated_at: "2026-07-25T00:00:00.000Z",
});

const viewAuthorization = (commitSeq: number, storeEpoch: string = identity.storeEpoch) =>
  authorizedReadStampFixture({
    deliveryAddress: {
      kind: "project",
      library_id: identity.libraryId,
      project_id: identity.projectId,
    },
    subject: { kind: "view", view_id: "view:test" },
    commitSeq,
    storeEpoch,
  });

const databaseSnapshot = () => ({
  contract_version: 4 as const,
  store_epoch: identity.storeEpoch,
  commit_head: 17,
  authorization: null,
  value: {
    kind: "database" as const,
    value: { database: coreDatabaseRecord() },
  },
});

const emptyDataSourceWindowSnapshot = () => ({
  contract_version: 4 as const,
  store_epoch: identity.storeEpoch,
  commit_head: 17,
  authorization: null,
  value: {
    kind: "data_source_window" as const,
    data_sources: {
      items: [],
      next_cursor: null,
      authority: { projection_revision: 17 },
    },
  },
});

const emptyViewDescriptorWindowSnapshot = () => ({
  contract_version: 4 as const,
  store_epoch: identity.storeEpoch,
  commit_head: 17,
  authorization: null,
  value: {
    kind: "view_descriptor_window" as const,
    views: {
      items: [],
      next_cursor: null,
      authority: { projection_revision: 17 },
    },
  },
});

describe("Core Database Module Adapter", () => {
  test("maps the Project-bound read and validates the shared v2 snapshot", async () => {
    const client = new FakeCoreClient();
    client.enqueueDatabaseRead(databaseSnapshot());
    client.enqueueDatabaseRead(emptyDataSourceWindowSnapshot());
    client.enqueueDatabaseRead(emptyViewDescriptorWindowSnapshot());
    const adapter = createCoreDatabaseModuleAdapter({ client, ...identity });

    await expect(
      adapter.read({
        projectId: identity.projectId,
        read: { target: { kind: "project_default" }, mode: "database" },
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        projectId: identity.projectId,
        libraryId: identity.libraryId,
        storeEpoch: identity.storeEpoch,
        commitSeq: 17,
        authorization: null,
        value: {
          kind: "database",
          value: {
            database: databaseRecord(),
            dataSources: [],
            views: [],
          },
        },
      },
    });
    expect(client.databaseReads).toEqual([
      {
        kind: "database",
        target: { kind: "project_default" },
      },
      {
        kind: "data_source_window",
        database_id: "database:test",
        window: { after: null, first: 200 },
      },
      {
        kind: "view_descriptor_window",
        database_id: "database:test",
        window: { after: null, first: 200 },
      },
    ]);
  });

  test("maps Database-owned Page-key reads and rename without Workspace coordinates", async () => {
    const client = new FakeCoreClient();
    client.enqueueDatabaseRead({
      contract_version: 18,
      store_epoch: identity.storeEpoch,
      commit_head: 24,
      authorization: null,
      value: {
        kind: "page_key_prefix_preview",
        value: {
          prefix: "LAB",
          availability: "reserved",
          alternative_prefix: "LAB2",
          next_number: 8,
          example_keys: ["LAB-8", "LAB-9", "LAB-10"],
        },
      },
    });
    client.enqueueDatabaseRead({
      contract_version: 18,
      store_epoch: identity.storeEpoch,
      commit_head: 24,
      authorization: null,
      value: {
        kind: "page_key_namespace",
        value: {
          database_id: "database:test",
          current_prefix: "RND",
          next_number: 8,
          assigned_page_count: 7,
          revision: 3,
          retired_prefixes: [{ prefix: "LAB", last_number: 7 }],
        },
      },
    });
    client.enqueueDatabaseApply({
      value: { operation_count: 1 },
      receipt: {
        operation_id: "operation:rename-page-key",
        duplicate: false,
        affected_database_ids: ["database:test"],
        affected_data_source_ids: [],
        affected_page_ids: [],
        affected_view_ids: [],
        operation_kinds: ["rename_page_key_prefix"],
        committed_revisions: { "page_key_namespace:database:test": 4 },
        commit_seq: 25,
        committed_at: "2026-08-14T00:00:00.000Z",
      },
      event_sequence: 25,
      store_epoch: identity.storeEpoch,
    });
    const adapter = createCoreDatabaseModuleAdapter({ client, ...identity });
    const databaseId = parseDatabaseId("database:test");

    await expect(
      adapter.read({
        projectId: identity.projectId,
        read: {
          target: { kind: "page_key_namespace", databaseId },
          mode: "page_key_prefix_preview",
          nameHint: "Lab",
          requestedPrefix: "LAB",
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "page_key_prefix_preview",
          value: {
            prefix: "LAB",
            alternativePrefix: "LAB2",
            exampleKeys: ["LAB-8", "LAB-9", "LAB-10"],
          },
        },
      },
    });
    await expect(
      adapter.read({
        projectId: identity.projectId,
        read: {
          target: { kind: "database", databaseId },
          mode: "page_key_namespace",
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "page_key_namespace",
          value: {
            databaseId,
            currentPrefix: "RND",
            revision: 3,
          },
        },
      },
    });
    await expect(
      adapter.apply({
        operationId: "operation:rename-page-key",
        projectId: identity.projectId,
        storeEpoch: identity.storeEpoch,
        actor: {},
        operations: [
          {
            kind: "rename_page_key_prefix",
            databaseId,
            expectedRevision: 3,
            prefix: "OPS",
          },
        ],
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        operationKinds: ["rename_page_key_prefix"],
        affectedPageIds: [],
      },
    });
    expect(client.databaseReads).toEqual([
      {
        kind: "page_key_prefix_preview",
        database_id: databaseId,
        name_hint: "Lab",
        requested_prefix: "LAB",
      },
      { kind: "page_key_namespace", database_id: databaseId },
    ]);
    expect(client.databaseApplies[0]).toMatchObject({
      intent: [
        {
          kind: "rename_page_key_prefix",
          database_id: databaseId,
          expected_revision: 3,
          prefix: "OPS",
        },
      ],
    });
  });

  test("maps the Core View descriptor into the renderer contract", async () => {
    const client = new FakeCoreClient();
    const config = upgradeDatabaseViewConfigV2({
      schemaKey: "nodex.database-view" as const,
      schemaVersion: 2 as const,
      filter: { kind: "group" as const, operator: "and" as const, children: [] },
      sort: [
        {
          field: { kind: "manual" as const },
          direction: "asc" as const,
          nulls: "last" as const,
        },
      ],
      group: null,
      display: { propertyIds: [], showTitle: true },
    });
    client.enqueueDatabaseRead({
      contract_version: 10,
      store_epoch: identity.storeEpoch,
      commit_head: 23,
      authorization: viewAuthorization(23),
      value: {
        kind: "view",
        value: {
          view_id: "view:test",
          database_id: "database:test",
          data_source_id: "source:test",
          name: "All tasks",
          layout: "list",
          definition: {
            rules: config.rules,
            presentation: config.presentation,
          },
          is_default: true,
          revision: 2,
          rank_key: "a",
          lifecycle: "active",
          created_at: "2026-07-25T00:00:00.000Z",
          updated_at: "2026-07-25T00:00:00.000Z",
        },
      },
    });
    const adapter = createCoreDatabaseModuleAdapter({ client, ...identity });

    await expect(
      adapter.read({
        projectId: identity.projectId,
        read: {
          target: { kind: "view", viewId: parseDatabaseViewId("view:test") },
          mode: "view",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        projectId: identity.projectId,
        libraryId: identity.libraryId,
        storeEpoch: identity.storeEpoch,
        commitSeq: 23,
        authorization: viewAuthorization(23),
        value: {
          kind: "view",
          value: {
            viewId: "view:test",
            databaseId: "database:test",
            dataSourceId: "source:test",
            name: "All tasks",
            layout: "list",
            config,
            isDefault: true,
            revision: 2,
            rankKey: "a",
            lifecycle: "active",
            createdAt: "2026-07-25T00:00:00.000Z",
            updatedAt: "2026-07-25T00:00:00.000Z",
          },
        },
      },
    });
  });

  test("hydrates authorized catalog entries and maps Relation candidates", async () => {
    const catalogClient = new FakeCoreClient();
    catalogClient.enqueueDatabaseRead({
      contract_version: 7,
      store_epoch: identity.storeEpoch,
      commit_head: 21,
      authorization: viewAuthorization(21),
      value: {
        kind: "catalog_window",
        databases: {
          items: [{ database: coreDatabaseRecord() }],
          next_cursor: null,
          authority: { projection_revision: 21 },
        },
      },
    });
    catalogClient.enqueueDatabaseRead({
      ...emptyDataSourceWindowSnapshot(),
      commit_head: 21,
      authorization: null,
      value: {
        ...emptyDataSourceWindowSnapshot().value,
        data_sources: {
          ...emptyDataSourceWindowSnapshot().value.data_sources,
          authority: { projection_revision: 21 },
        },
      },
    });
    catalogClient.enqueueDatabaseRead({
      ...emptyViewDescriptorWindowSnapshot(),
      commit_head: 21,
      authorization: null,
      value: {
        ...emptyViewDescriptorWindowSnapshot().value,
        views: {
          ...emptyViewDescriptorWindowSnapshot().value.views,
          authority: { projection_revision: 21 },
        },
      },
    });
    const catalogAdapter = createCoreDatabaseModuleAdapter({
      client: catalogClient,
      ...identity,
    });
    const catalog = await catalogAdapter.read({
      projectId: identity.projectId,
      read: {
        target: { kind: "project_default" },
        mode: "catalog_window",
        window: { first: 100 },
      },
    });
    expect(catalog).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "catalog_window",
          value: {
            databases: [{ database: { databaseId: "database:test" } }],
            nextCursor: null,
          },
        },
      },
    });

    const candidateClient = new FakeCoreClient();
    candidateClient.enqueueDatabaseRead({
      contract_version: 7,
      store_epoch: identity.storeEpoch,
      commit_head: 22,
      authorization: null,
      value: {
        kind: "relation_candidate_window",
        candidates: {
          items: [{ page_id: "page:one", title: "Blocked task" }],
          next_cursor: null,
          authority: { projection_revision: 22 },
        },
      },
    });
    const candidateAdapter = createCoreDatabaseModuleAdapter({
      client: candidateClient,
      ...identity,
    });
    await expect(
      candidateAdapter.read({
        projectId: identity.projectId,
        read: {
          target: {
            kind: "data_source",
            dataSourceId: parseDataSourceId("source:test"),
          },
          mode: "relation_candidate_window",
          query: "blocked",
          window: { first: 25 },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "relation_candidate_window",
          value: {
            candidates: [{ pageId: "page:one", title: "Blocked task" }],
          },
        },
      },
    });
    expect(candidateClient.databaseReads[0]).toMatchObject({
      kind: "relation_candidate_window",
      data_source_id: "source:test",
      query: "blocked",
      window: { first: 25 },
    });
  });

  test("maps an omitted Relation query to an unfiltered Core window", async () => {
    const client = new FakeCoreClient();
    client.enqueueDatabaseRead({
      contract_version: 7,
      store_epoch: identity.storeEpoch,
      commit_head: 22,
      authorization: null,
      value: {
        kind: "relation_candidate_window",
        candidates: {
          items: [],
          next_cursor: null,
          authority: { projection_revision: 22 },
        },
      },
    });
    const adapter = createCoreDatabaseModuleAdapter({ client, ...identity });
    await adapter.read({
      projectId: identity.projectId,
      read: {
        target: {
          kind: "data_source",
          dataSourceId: parseDataSourceId("source:test"),
        },
        mode: "relation_candidate_window",
        window: { first: 25 },
      },
    });
    expect(client.databaseReads[0]).toMatchObject({
      kind: "relation_candidate_window",
      query: null,
      window: { first: 25 },
    });
  });

  test("maps typed Property descriptors without option-window N+1 reads", async () => {
    const client = new FakeCoreClient();
    const base = {
      contract_version: 4 as const,
      store_epoch: identity.storeEpoch,
      commit_head: 19,
      authorization: null,
    };
    client.enqueueDatabaseRead({
      ...base,
      value: {
        kind: "data_source" as const,
        value: {
          data_source: coreDataSourceRecord(2),
        },
      },
    });
    client.enqueueDatabaseRead({
      ...base,
      value: {
        kind: "property_window" as const,
        properties: {
          items: [
            {
              property_id: "status",
              data_source_id: "source:test",
              name: "Status",
              schema: { kind: "select" },
              capabilities: {
                filter_operators: ["select_is", "select_is_not", "is_empty", "is_not_empty"],
                sortable: true,
                groupable: true,
              },
              management_policy: {
                can_rename: true,
                can_reorder: true,
                can_change_type: false,
                can_duplicate: true,
                can_delete: false,
                can_restore: false,
                can_permanently_delete: false,
                can_manage_options: true,
                allowed_types: [],
                blocked_reasons: ["required_system_property"],
              },
              non_empty_value_count: 1,
              referenced_view_ids: [],
              option_count: 1,
              rank_key: "a",
              lifecycle: "active",
              revision: 2,
              created_at: "2026-07-25T00:00:00.000Z",
              updated_at: "2026-07-25T00:00:00.000Z",
            },
          ],
          next_cursor: "property:next",
          authority: { projection_revision: 19 },
        },
      },
    });
    client.enqueueDatabaseRead({
      ...base,
      value: {
        kind: "property_window" as const,
        properties: {
          items: [
            {
              property_id: "p_abcdefgh",
              data_source_id: "source:test",
              name: "Notes",
              schema: { kind: "text" },
              capabilities: {
                filter_operators: [
                  "text_is",
                  "text_is_not",
                  "text_contains",
                  "text_does_not_contain",
                  "text_starts_with",
                  "text_ends_with",
                  "is_empty",
                  "is_not_empty",
                ],
                sortable: true,
                groupable: true,
              },
              management_policy: {
                can_rename: true,
                can_reorder: true,
                can_change_type: true,
                can_duplicate: true,
                can_delete: true,
                can_restore: false,
                can_permanently_delete: false,
                can_manage_options: false,
                allowed_types: [
                  "text",
                  "number",
                  "checkbox",
                  "select",
                  "multi_select",
                  "date",
                  "datetime",
                  "relation",
                ],
                blocked_reasons: [],
              },
              non_empty_value_count: 0,
              referenced_view_ids: [],
              option_count: 0,
              rank_key: "b",
              lifecycle: "active",
              revision: 1,
              created_at: "2026-07-25T00:00:00.000Z",
              updated_at: "2026-07-25T00:00:00.000Z",
            },
          ],
          next_cursor: null,
          authority: { projection_revision: 19 },
        },
      },
    });
    const adapter = createCoreDatabaseModuleAdapter({ client, ...identity });

    const result = await adapter.read({
      projectId: identity.projectId,
      read: {
        target: {
          kind: "data_source",
          dataSourceId: parseDataSourceId("source:test"),
        },
        mode: "data_source",
      },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result).toMatchObject({
      ok: true,
      value: {
        value: {
          kind: "data_source",
          value: {
            properties: [
              {
                propertyId: "status",
                schema: { kind: "select" },
                config: {},
              },
              { propertyId: "p_abcdefgh", config: {} },
            ],
          },
        },
      },
    });
    expect(client.databaseReads.map((read) => read.kind)).toEqual([
      "data_source",
      "property_window",
      "property_window",
    ]);
  });

  test("rejects a noncanonical Core Property identity at the adapter boundary", () => {
    expect(() =>
      mapCorePropertyDescriptor({
        property_id: "risk",
        data_source_id: "source:test",
        name: "Risk",
        schema: { kind: "select" },
        capabilities: {
          filter_operators: ["select_is", "select_is_not", "is_empty", "is_not_empty"],
          sortable: true,
          groupable: true,
        },
        system_role: null,
        non_empty_value_count: 0,
        referenced_view_ids: [],
        management_policy: {
          can_rename: true,
          can_reorder: true,
          can_change_type: true,
          can_duplicate: true,
          can_delete: true,
          can_restore: false,
          can_permanently_delete: false,
          can_manage_options: true,
          allowed_types: ["select"],
          blocked_reasons: [],
        },
        option_count: 0,
        rank_key: "a",
        lifecycle: "active",
        revision: 1,
        created_at: "2026-07-25T00:00:00.000Z",
        updated_at: "2026-07-25T00:00:00.000Z",
      }),
    ).toThrow(/propertyId is invalid/u);
  });

  test("maps ordered mutation semantics and validates the atomic Core receipt", async () => {
    const client = new FakeCoreClient();
    const databaseId = parseDatabaseId("database:test");
    const dataSourceId = parseDataSourceId("source:test");
    const propertyId = parseDataSourcePropertyId("p_abcdefgh");
    const optionId = parseDataSourceOptionId({
      propertyId,
      value: "o_abcdefgh",
    });
    const viewId = parseDatabaseViewId("view:test");
    const config = upgradeDatabaseViewConfigV2({
      schemaKey: "nodex.database-view" as const,
      schemaVersion: 2 as const,
      filter: { kind: "group" as const, operator: "and" as const, children: [] },
      sort: [
        {
          field: { kind: "manual" as const },
          direction: "asc" as const,
          nulls: "last" as const,
        },
      ],
      group: null,
      display: { propertyIds: [propertyId], showTitle: true },
    });
    const operationKinds = [
      "put_property",
      "delete_property",
      "put_option",
      "delete_option",
      "edit_property_values",
      "transfer_page",
      "put_view",
      "delete_view",
      "position_page",
      "position_pages",
    ] as const;
    client.enqueueDatabaseApply({
      value: { operation_count: operationKinds.length },
      receipt: {
        operation_id: "operation:test",
        duplicate: false,
        affected_database_ids: [databaseId],
        affected_data_source_ids: [dataSourceId],
        affected_page_ids: ["page:test"],
        affected_view_ids: [viewId],
        operation_kinds: operationKinds,
        committed_revisions: { [`source:${dataSourceId}`]: 2 },
        commit_seq: 41,
        committed_at: "2026-07-20T00:00:00.000Z",
      },
      // The physical effect cursor is independent from the semantic
      // LocalCommit cursor once one mutation can contain multiple effects.
      event_sequence: 42,
      store_epoch: identity.storeEpoch,
    });
    const adapter = createCoreDatabaseModuleAdapter({ client, ...identity });

    await expect(
      adapter.apply({
        operationId: "operation:test",
        projectId: identity.projectId,
        storeEpoch: identity.storeEpoch,
        actor: { kind: "electron_renderer", clientId: "renderer:test" },
        operations: [
          {
            kind: "put_property",
            dataSourceId,
            propertyId,
            expectedDataSourceRevision: 1,
            expectedPropertyRevision: 0,
            name: "Priority",
            schema: { kind: "text" },
            beforePropertyId: propertyId,
          },
          {
            kind: "delete_property",
            dataSourceId,
            propertyId,
            expectedDataSourceRevision: 2,
            expectedPropertyRevision: 1,
          },
          {
            kind: "put_option",
            dataSourceId,
            propertyId,
            optionId,
            name: "High",
            color: "red",
            expectedPropertyRevision: 1,
          },
          {
            kind: "delete_option",
            dataSourceId,
            propertyId,
            optionId,
            expectedPropertyRevision: 2,
          },
          {
            kind: "edit_property_values",
            edits: [
              {
                pageId: "page:test",
                dataSourceId,
                propertyId,
                edit: {
                  kind: "patch_set",
                  delta: {
                    kind: "multi_select",
                    addOptionIds: [optionId],
                    removeOptionIds: [],
                  },
                },
              },
            ],
          },
          {
            kind: "transfer_page",
            pageId: "page:test",
            expectedParentRevision: 1,
            expectedActiveMembershipRevision: 1,
            target: { kind: "data_source", dataSourceId },
          },
          {
            kind: "put_view",
            databaseId,
            dataSourceId,
            viewId,
            expectedRevision: 0,
            name: "Priority",
            layout: "list",
            config,
            isDefault: true,
            beforeViewId: null,
          },
          {
            kind: "delete_view",
            databaseId,
            viewId,
            expectedRevision: 1,
          },
          {
            kind: "position_page",
            viewId,
            pageId: "page:test",
            expectedPositionRevision: 0,
            beforePageId: "page:anchor",
          },
          {
            kind: "position_pages",
            viewId,
            pages: [{ pageId: "page:test", expectedPositionRevision: 1 }],
          },
        ],
      }),
    ).resolves.toEqual({
      ok: true,
      localCommit: committedLocalCommit(identity.storeEpoch, 41),
      value: {
        operationId: "operation:test",
        projectId: identity.projectId,
        libraryId: identity.libraryId,
        storeEpoch: identity.storeEpoch,
        duplicate: false,
        operationKinds,
        operationOutcomes: [],
        affectedDatabaseIds: [databaseId],
        affectedDataSourceIds: [dataSourceId],
        affectedPageIds: ["page:test"],
        affectedViewIds: [viewId],
        committedRevisions: { [`source:${dataSourceId}`]: 2 },
        commitSeq: 41,
        committedAt: "2026-07-20T00:00:00.000Z",
      },
    });
    expect(client.databaseApplies).toEqual([
      {
        operationId: "operation:test",
        intent: [
          {
            kind: "put_property",
            data_source_id: dataSourceId,
            property_id: propertyId,
            expected_data_source_revision: 1,
            expected_property_revision: 0,
            name: "Priority",
            schema: { kind: "text" },
            before_property_id: propertyId,
          },
          {
            kind: "delete_property",
            data_source_id: dataSourceId,
            property_id: propertyId,
            expected_data_source_revision: 2,
            expected_property_revision: 1,
          },
          {
            kind: "put_option",
            data_source_id: dataSourceId,
            property_id: propertyId,
            option_id: optionId,
            name: "High",
            color: "red",
            expected_property_revision: 1,
          },
          {
            kind: "delete_option",
            data_source_id: dataSourceId,
            property_id: propertyId,
            option_id: optionId,
            expected_property_revision: 2,
          },
          {
            kind: "edit_property_values",
            edits: [
              {
                address: {
                  page_id: "page:test",
                  data_source_id: dataSourceId,
                  property_id: propertyId,
                },
                edit: {
                  kind: "patch_set",
                  delta: {
                    kind: "multi_select",
                    add_option_ids: [optionId],
                    remove_option_ids: [],
                  },
                },
              },
            ],
          },
          {
            kind: "transfer_page",
            page_id: "page:test",
            expected_parent_revision: 1,
            expected_active_membership_revision: 1,
            target: { kind: "data_source", data_source_id: dataSourceId },
          },
          {
            kind: "put_view",
            database_id: databaseId,
            data_source_id: dataSourceId,
            view_id: viewId,
            expected_revision: 0,
            name: "Priority",
            layout: "list",
            definition: {
              rules: config.rules,
              presentation: config.presentation,
            },
            is_default: true,
            before_view_id: null,
          },
          {
            kind: "delete_view",
            database_id: databaseId,
            view_id: viewId,
            expected_revision: 1,
          },
          {
            kind: "position_page",
            view_id: viewId,
            page_id: "page:test",
            expected_position_revision: 0,
            before_page_id: "page:anchor",
          },
          {
            kind: "position_pages",
            view_id: viewId,
            pages: [{ page_id: "page:test", expected_position_revision: 1 }],
            before_page_id: null,
          },
        ],
      },
    ]);
  });

  test("preserves semantic List subtree moves and their logical Undo receipt", async () => {
    const client = new FakeCoreClient();
    const dataSourceId = parseDataSourceId("source:test");
    const viewId = parseDatabaseViewId("view:test");
    const preferencesOverride = {
      rulesOverride: {},
      presentationOverride: {
        hierarchy: { showSubPages: true, nestedSubPages: true },
        display: { propertyOrder: ["status"] },
      },
    };
    const expectedProjection = {
      scopeKey: "view:view:test:list",
      schemaVersion: 1,
      revision: 7,
      coveredCommitSeq: 40,
      effectHash: null,
    };
    const undoRecipe = {
      viewId,
      dataSourceId,
      propertyStates: [],
      postParentGuards: [{ pageId: "page:parent", parentPageId: null }],
      postOrderRuns: [
        { pageIds: ["page:parent"], parentPageId: null, beforePageId: "page:target" },
      ],
      restoreRuns: [
        {
          pageIds: ["page:parent"],
          parentPageId: null,
          beforePageId: "page:source-next",
        },
      ],
    } as const;

    const moveOperation = {
      kind: "move_list_occurrences" as const,
      viewId,
      preferencesOverride,
      expectedProjection,
      initiatorOccurrenceKey: "page:parent@root",
      selection: {
        kind: "explicit" as const,
        occurrenceKeys: ["page:parent@root", "page:child@parent"],
      },
      target: {
        kind: "page" as const,
        occurrenceKey: "page:target@root",
        edge: "before" as const,
      },
    };
    const undoOperation = {
      kind: "undo_list_occurrence_move" as const,
      recipe: undoRecipe,
    };

    expect(toCoreDatabaseIntent(moveOperation)).toEqual({
      kind: "move_list_occurrences",
      view_id: viewId,
      preferences_override: {
        rules_override: {},
        presentation_override: {
          hierarchy: { show_sub_pages: true, nested_sub_pages: true },
          display: { property_order: ["status"] },
        },
      },
      expected_projection: {
        scope_key: expectedProjection.scopeKey,
        schema_version: expectedProjection.schemaVersion,
        revision: expectedProjection.revision,
        covered_commit_seq: expectedProjection.coveredCommitSeq,
        effect_hash: null,
      },
      initiator_occurrence_key: "page:parent@root",
      selection: {
        kind: "explicit",
        occurrence_keys: ["page:parent@root", "page:child@parent"],
      },
      target: {
        kind: "page",
        occurrence_key: "page:target@root",
        edge: "before",
      },
    });
    expect(toCoreDatabaseIntent(undoOperation)).toEqual({
      kind: "undo_list_occurrence_move",
      recipe: {
        view_id: viewId,
        data_source_id: dataSourceId,
        property_states: [],
        post_parent_guards: [
          {
            page_id: "page:parent",
            parent_page_id: null,
          },
        ],
        post_order_runs: [
          { page_ids: ["page:parent"], parent_page_id: null, before_page_id: "page:target" },
        ],
        restore_runs: [
          {
            page_ids: ["page:parent"],
            parent_page_id: null,
            before_page_id: "page:source-next",
          },
        ],
      },
    });

    client.enqueueDatabaseApply({
      value: { operation_count: 2 },
      receipt: {
        operation_id: "operation:list-subtree",
        duplicate: false,
        affected_database_ids: ["database:test"],
        affected_data_source_ids: [dataSourceId],
        affected_page_ids: ["page:parent", "page:child"],
        affected_view_ids: [viewId],
        operation_kinds: ["move_list_occurrences", "undo_list_occurrence_move"],
        operation_outcomes: [
          {
            kind: "list_occurrence_move",
            operation_index: 0,
            moved_page_ids: ["page:parent", "page:child"],
            move_root_page_ids: ["page:parent"],
            normalized_target: {
              target_occurrence_key: "page:target@root",
              target_page_id: "page:target",
              parent_page_id: null,
              before_page_id: "page:target",
              group_key: "status:build",
              subgroup_key: null,
              depth: 0,
              edge: "before",
            },
            undo_recipe: {
              view_id: viewId,
              data_source_id: dataSourceId,
              property_states: [],
              post_parent_guards: [
                {
                  page_id: "page:parent",
                  parent_page_id: null,
                },
              ],
              post_order_runs: [
                { page_ids: ["page:parent"], parent_page_id: null, before_page_id: "page:target" },
              ],
              restore_runs: [
                {
                  page_ids: ["page:parent"],
                  parent_page_id: null,
                  before_page_id: "page:source-next",
                },
              ],
            },
          },
          {
            kind: "list_occurrence_move_undo",
            operation_index: 1,
            restored_page_ids: ["page:parent", "page:child"],
            undo_recipe: {
              view_id: viewId,
              data_source_id: dataSourceId,
              property_states: [],
              post_parent_guards: [
                {
                  page_id: "page:parent",
                  parent_page_id: null,
                },
              ],
              post_order_runs: [
                { page_ids: ["page:parent"], parent_page_id: null, before_page_id: "page:target" },
              ],
              restore_runs: [
                {
                  page_ids: ["page:parent"],
                  parent_page_id: null,
                  before_page_id: "page:source-next",
                },
              ],
            },
          },
        ],
        committed_revisions: { [`view:${viewId}`]: 8 },
        commit_seq: 41,
        committed_at: "2026-08-14T00:00:00.000Z",
      },
      event_sequence: 41,
      store_epoch: identity.storeEpoch,
    });
    const adapter = createCoreDatabaseModuleAdapter({ client, ...identity });

    await expect(
      adapter.apply({
        operationId: "operation:list-subtree",
        projectId: identity.projectId,
        storeEpoch: identity.storeEpoch,
        actor: { kind: "electron_renderer", clientId: "renderer:test" },
        operations: [moveOperation, undoOperation],
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        operationKinds: ["move_list_occurrences", "undo_list_occurrence_move"],
        operationOutcomes: [
          {
            kind: "list_occurrence_move",
            operationIndex: 0,
            movedPageIds: ["page:parent", "page:child"],
            moveRootPageIds: ["page:parent"],
            normalizedTarget: {
              targetOccurrenceKey: "page:target@root",
              targetPageId: "page:target",
              parentPageId: null,
              beforePageId: "page:target",
              groupKey: "status:build",
              subgroupKey: null,
              depth: 0,
              edge: "before",
            },
            undoRecipe,
          },
          {
            kind: "list_occurrence_move_undo",
            operationIndex: 1,
            restoredPageIds: ["page:parent", "page:child"],
            undoRecipe,
          },
        ],
      },
    });
  });

  test("maps trusted Library writes without exposing a storage Project", async () => {
    const client = new FakeCoreClient();
    const dataSourceId = parseDataSourceId("source:library");
    const propertyId = parseDataSourcePropertyId("p_library1");
    client.enqueueDatabaseApply({
      value: { operation_count: 1 },
      receipt: {
        operation_id: "operation:library",
        duplicate: false,
        affected_database_ids: [],
        affected_data_source_ids: [dataSourceId],
        affected_page_ids: [],
        affected_view_ids: [],
        operation_kinds: ["put_property"],
        committed_revisions: {
          [`property:${dataSourceId}:${propertyId}`]: 1,
        },
        commit_seq: 52,
        committed_at: "2026-07-20T00:10:00.000Z",
      },
      event_sequence: 52,
      store_epoch: identity.storeEpoch,
    });
    const adapter = createCoreLibraryDatabaseModuleAdapter({
      client,
      libraryId: identity.libraryId,
      storeEpoch: identity.storeEpoch,
    });

    await expect(
      adapter.apply({
        operationId: "operation:library",
        storeEpoch: identity.storeEpoch,
        operations: [
          {
            kind: "put_property",
            dataSourceId,
            propertyId,
            expectedDataSourceRevision: 1,
            expectedPropertyRevision: 0,
            name: "Library",
            schema: { kind: "text" },
          },
        ],
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        accessContext: { kind: "library" },
        libraryId: identity.libraryId,
        operationId: "operation:library",
        operationKinds: ["put_property"],
      },
    });
    const [result] = client.databaseApplies;
    expect(result).toMatchObject({
      operationId: "operation:library",
      intent: [
        {
          kind: "put_property",
          data_source_id: dataSourceId,
          property_id: propertyId,
        },
      ],
    });
    expect(result && "projectId" in result).toBe(false);
  });
});
