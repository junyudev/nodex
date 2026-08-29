import { describe, expect, test } from "vite-plus/test";
import { authorizedReadStampFixture } from "../../shared/testing/authorized-read-stamp-fixture";
import { testPropertyManagement } from "../../shared/testing/database-property-record";

import { plainTextToPortableRichText } from "../../shared/block-documents/portable-rich-text";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../shared/database-identities";
import type {
  DatabaseViewQueryResultV2,
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import {
  DatabasePageProjectionError,
  projectCoreDatabaseRowSummary,
  projectDatabasePage,
  projectDatabaseViewReference,
} from "../../shared/database-page-projection";
import { projectCoreDatabaseQueryRow } from "../../shared/core-database-row-projection";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import type { CoreDatabaseRowSummary } from "./types";

const dataSourceId = parseDataSourceId("source:test");
const databaseId = parseDatabaseId("database:test");
const viewId = parseDatabaseViewId("view:test");

const property = (
  propertyId: string,
  valueType: DataSourcePropertyRecordV2["valueType"],
  config: DataSourcePropertyRecordV2["config"] = {},
): DataSourcePropertyRecordV2 => ({
  propertyId: parseDataSourcePropertyId(propertyId),
  dataSourceId,
  name: propertyId,
  schema: { kind: valueType } as DataSourcePropertyRecordV2["schema"],
  capabilities: {
    filterOperators: [
      "equals",
      "not_equals",
      "contains",
      "not_contains",
      "is_empty",
      "is_not_empty",
    ],
    sortable: true,
    groupable: true,
  },
  ...testPropertyManagement(),
  valueType,
  config,
  optionCount: Array.isArray(config.options) ? config.options.length : 0,
  rankKey: propertyId,
  lifecycle: "active",
  revision: 1,
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
});

const properties: readonly DataSourcePropertyRecordV2[] = [
  property("status", "select"),
  property("priority", "select"),
  property("estimate", "select"),
  property("tags", "multi_select"),
  property("due_date", "date"),
  property("scheduled_start", "datetime"),
  property("scheduled_end", "datetime"),
  property("assignee", "text"),
];

const databaseValue = (
  propertyId: string,
  valueType: DataSourcePageRowV2["values"][string]["valueType"],
  value: DataSourcePageRowV2["values"][string]["value"],
) => ({
  propertyId: parseDataSourcePropertyId(propertyId),
  valueType,
  value,
  revision: 1,
});

const makeRow = (pageId: string, status: "triage" | "build" = "build"): DataSourcePageRowV2 => ({
  pageKey: null,
  page: {
    pageId,
    libraryId: "library:test",
    parent: { kind: "data_source", dataSourceId },
    lifecycle: "active",
    parentRevision: 2,
    metadataRevision: 7,
    documentId: `document:${pageId}`,
    documentGeneration: 1,
    documentHeadSeq: 4,
    title: `Title ${pageId}`,
    richTitle: plainTextToPortableRichText(`Title ${pageId}`),
    preview: "Projection preview",
    plainText: "Projection plain text",
    createdAt: "2026-07-20T01:00:00.000Z",
    updatedAt: "2026-07-20T02:00:00.000Z",
  },
  membership: {
    membershipId: `membership:${pageId}`,
    dataSourceId,
    revision: 1,
    createdAt: "2026-07-20T00:30:00.000Z",
  },
  values: {
    status: databaseValue("status", "select", status),
    priority: databaseValue("priority", "select", "p1-high"),
    estimate: databaseValue("estimate", "select", "m"),
    tags: databaseValue("tags", "multi_select", ["o_BBBBBBBB", "o_AAAAAAAA"]),
    due_date: databaseValue("due_date", "date", "2026-07-25"),
    scheduled_start: databaseValue("scheduled_start", "datetime", "2026-07-25T08:00:00.000Z"),
    scheduled_end: databaseValue("scheduled_end", "datetime", "2026-07-25T09:00:00.000Z"),
    assignee: databaseValue("assignee", "text", "Ada"),
  },
  bodyNfm: "# Detail\n\nA body with **structure**.",
  intrinsicProperties: [
    { key: "run.target", valueType: "string", value: "newWorktree", revision: 1 },
    { key: "run.localPath", valueType: "string", value: "/repo/nodex", revision: 1 },
    { key: "run.baseBranch", valueType: "string", value: "main", revision: 1 },
    { key: "run.worktreePath", valueType: "string", value: null, revision: 1 },
    { key: "run.environmentPath", valueType: "string", value: null, revision: 1 },
    { key: "schedule.isAllDay", valueType: "boolean", value: false, revision: 1 },
    { key: "schedule.timezone", valueType: "string", value: "UTC", revision: 1 },
    {
      key: "recurrence.config",
      valueType: "json",
      value: { frequency: "weekly", interval: 1, byWeekdays: [1, 3] },
      revision: 1,
    },
    {
      key: "reminders.config",
      valueType: "json",
      value: [{ offsetMinutes: 30 }],
      revision: 1,
    },
  ],
  taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
  position: {
    rankKey: `rank:${pageId}`,
    revision: 1,
  },
  effectiveGroupKey: status,
  effectiveSubgroupKey: null,
});

const makeQuery = (rows: readonly DataSourcePageRowV2[]): DatabaseViewQueryResultV2 => ({
  database: {
    databaseId,
    libraryId: "library:test",
    name: "Tasks",
    lifecycle: "active",
    defaultViewId: viewId,
    accessRevision: 1,
    metadataRevision: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  },
  dataSource: {
    dataSourceId,
    libraryId: "library:test",
    homeDatabaseId: databaseId,
    name: "Tasks",
    schemaKey: "nodex.database",
    schemaRevision: 1,
    lifecycle: "active",
    rankKey: "rank:source",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  },
  view: {
    viewId,
    databaseId,
    dataSourceId,
    name: "Board",
    layout: "board",
    config: upgradeDatabaseViewConfigV2({
      schemaKey: "nodex.database-view",
      schemaVersion: 2,
      filter: { kind: "group", operator: "and", children: [] },
      sort: [
        {
          field: { kind: "manual" },
          direction: "asc",
          nulls: "last",
        },
      ],
      group: { propertyId: "status" },
      display: { propertyIds: ["status"], showTitle: true },
    }),
    isDefault: true,
    revision: 1,
    rankKey: "rank:view",
    lifecycle: "active",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  },
  properties,
  rows,
});

describe("native Database Page projections", () => {
  test("keeps canonical option identities in the shared Board projection", () => {
    const row: CoreDatabaseRowSummary = {
      page_id: "page:defaults",
      lifecycle: "active",
      title: "Defaults",
      rich_title: plainTextToPortableRichText("Defaults"),
      description_preview: "",
      description_length: 0,
      has_description: false,
      database_values: { status: "triage", tags: ["o_AAAAAAAA"] },
      intrinsic_properties: {
        "run.target": "localProject",
        "run.localPath": null,
        "run.baseBranch": null,
        "run.worktreePath": null,
        "run.environmentPath": null,
        "schedule.isAllDay": false,
        "schedule.timezone": null,
        "recurrence.config": null,
        "reminders.config": [],
      },
      database_value_revisions: { status: 1, tags: 1 },
      task_parent_page_id: null,
      task_sibling_rank: null,
      task_parent_value_revision: 1,
      metadata_revision: 1,
      parent_revision: 1,
      document_id: "document:defaults",
      document_generation: 1,
      document_head_seq: 1,
      membership_id: "membership:defaults",
      membership_revision: 1,
      membership_created_at: "2026-07-25T00:00:00.000Z",
      created_at: "2026-07-25T00:00:00.000Z",
      updated_at: "2026-07-25T00:00:00.000Z",
    };

    expect(projectCoreDatabaseRowSummary(row)).toMatchObject({
      id: "page:defaults",
      status: "triage",
      tags: ["o_AAAAAAAA"],
      priority: undefined,
      estimate: undefined,
      dueDate: undefined,
      scheduledStart: undefined,
      scheduledEnd: undefined,
      assignee: undefined,
    });
    expect(
      projectCoreDatabaseQueryRow(row, {
        libraryId: "library:test",
        dataSourceId,
        properties,
      }).values.tags?.value,
    ).toEqual(["o_AAAAAAAA"]);
  });

  test("builds the complete renderer Page from one native query row", () => {
    const page = projectDatabasePage(makeRow("page:one"), 3);

    expect(page).toMatchObject({
      id: "page:one",
      status: "build",
      title: "Title page:one",
      description: "# Detail\n\nA body with **structure**.",
      priority: "p1-high",
      estimate: "m",
      tags: ["o_AAAAAAAA", "o_BBBBBBBB"],
      isAllDay: false,
      recurrence: { frequency: "weekly", interval: 1, byWeekdays: [1, 3] },
      reminders: [{ offsetMinutes: 30 }],
      scheduleTimezone: "UTC",
      assignee: "Ada",
      runInTarget: "newWorktree",
      runInLocalPath: "/repo/nodex",
      runInBaseBranch: "main",
      revision: 7,
      order: 3,
    });
    expect(page.dueDate?.toISOString()).toBe("2026-07-25T00:00:00.000Z");
    expect(page.scheduledStart?.toISOString()).toBe("2026-07-25T08:00:00.000Z");
    expect(page.created.toISOString()).toBe("2026-07-20T01:00:00.000Z");
  });

  test("fails closed when native exact-head or intrinsic evidence is absent", () => {
    const row = makeRow("page:missing");
    const withoutBody = { ...row, bodyNfm: undefined };
    const withoutIntrinsic = { ...row, intrinsicProperties: undefined };

    expect(() => projectDatabasePage(withoutBody)).toThrowError(DatabasePageProjectionError);
    expect(() => projectDatabasePage(withoutIntrinsic)).toThrow(
      "missing intrinsic Property evidence",
    );
  });

  test("rejects relational metadata that violates Page scheduling contracts", () => {
    const row = makeRow("page:invalid");
    const intrinsicProperties = row.intrinsicProperties?.map((propertyValue) =>
      propertyValue.key === "recurrence.config"
        ? {
            ...propertyValue,
            value: { frequency: "weekly", interval: 1 },
          }
        : propertyValue,
    );

    expect(() => projectDatabasePage({ ...row, intrinsicProperties })).toThrow(
      "invalid relational metadata",
    );
  });

  test("projects View identity and excludes an inline host without another read", () => {
    const model = projectDatabaseViewReference(
      makeQuery([makeRow("page:host"), makeRow("page:visible")]),
      {
        accessContext: {
          kind: "project",
          projectId: "project:reader",
        },
        databaseViewId: viewId,
        hostBlockId: "page:host",
      },
      {
        libraryId: "library:test",
        storeEpoch: "epoch:test",
        commitSeq: 1,
        authorization: authorizedReadStampFixture({
          deliveryAddress: {
            kind: "project",
            library_id: "library:test",
            project_id: "project:reader",
          },
          subject: { kind: "view", view_id: viewId },
          storeEpoch: "epoch:test",
        }),
      },
    );

    expect(model.view).toMatchObject({
      id: viewId,
      databaseBlockId: databaseId,
      projectId: "project:reader",
      isPrimary: true,
    });
    expect(model.rows.map((row) => row.page.id)).toEqual(["page:visible"]);
    expect(model.rows[0]?.rankKey).toBe("rank:page:visible");
  });
});
