import { plainTextToPortableRichText } from "../../../../shared/block-documents";
import type { BlockPropertyJsonValue } from "../../../../shared/block-property-mutations";
import type {
  DatabaseJsonValue,
  DatabasePropertyValueType,
} from "../../../../shared/database-kernel";
import type {
  DataSourcePageValueV2,
  DataSourcePropertyRecordV2,
} from "../../../../shared/database-module-v2";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../../../shared/database-identities";
import type { PageDetailResult, PageIntrinsicProperty } from "../../../../shared/page-detail";
import type { DatabasePage } from "@/lib/types";
import { testPropertySemantics } from "../../../../shared/testing/database-property-record";
import { authorizedReadStampFixture } from "../../../../shared/testing/authorized-read-stamp-fixture";

/** Storybook-only bridge from visual Board fixtures to canonical Page Detail. */
export const buildPageDetailStoryResult = (
  projectId: string,
  page: DatabasePage | null,
  authority: {
    readonly libraryId?: string;
    readonly storeEpoch?: string;
    readonly commitSeq?: number;
  } = {},
): PageDetailResult => {
  if (!page) {
    return {
      ok: false,
      error: {
        code: "page_not_found",
        message: "Story Page was not found",
        retryable: false,
      },
    };
  }
  const libraryId = authority.libraryId ?? "library:storybook";
  const storeEpoch = authority.storeEpoch ?? "store-epoch:storybook";
  const commitSeq = authority.commitSeq ?? 1;
  const databaseId = parseDatabaseId("019f714b-0000-7000-8000-000000000011");
  const dataSourceId = parseDataSourceId("019f714b-0000-7000-8000-000000000012");
  const viewId = parseDatabaseViewId("019f714b-0000-7000-8000-000000000013");
  const intrinsic = (key: string, value: unknown): PageIntrinsicProperty => ({
    key,
    valueType:
      value && typeof value === "object"
        ? "json"
        : value === null
          ? "null"
          : (typeof value as "boolean" | "number" | "string"),
    revision: 1,
    value: value as BlockPropertyJsonValue,
  });
  const property = (
    key: string,
    valueType: DatabasePropertyValueType,
    config: Readonly<Record<string, DatabaseJsonValue>> = {},
    name: string = key,
  ): DataSourcePropertyRecordV2 => ({
    propertyId: parseDataSourcePropertyId(key),
    dataSourceId,
    name,
    ...testPropertySemantics(valueType, Array.isArray(config.options) ? config.options.length : 0),
    valueType,
    config,
    rankKey: key,
    lifecycle: "active",
    revision: 1,
    createdAt: page.created.toISOString(),
    updatedAt: page.created.toISOString(),
  });
  const properties = [
    property("status", "select", {
      options: [
        { id: "triage", name: "Triage" },
        { id: "plan", name: "Plan" },
        { id: "build", name: "Build" },
        { id: "review", name: "Review" },
        { id: "ship", name: "Ship" },
      ],
    }),
    property("priority", "select", {
      options: [
        { id: "p0-critical", name: "Critical" },
        { id: "p1-high", name: "High" },
        { id: "p2-medium", name: "Medium" },
        { id: "p3-low", name: "Low" },
      ],
    }),
    property("estimate", "select", {
      options: [
        { id: "xs", name: "XS" },
        { id: "s", name: "S" },
        { id: "m", name: "M" },
        { id: "l", name: "L" },
        { id: "xl", name: "XL" },
      ],
    }),
    property("tags", "multi_select", {
      options: page.tags.map((tag) => ({
        id: tag,
        name: tag,
      })),
    }),
    property("due_date", "date"),
    property("scheduled_start", "datetime"),
    property("scheduled_end", "datetime"),
    property("assignee", "text"),
    property("p_C0nf1d3n", "number", {}, "Confidence"),
    property("p_Appr0v3d", "checkbox", {}, "Approved"),
    property("p_N0t3sxxx", "text", {}, "Notes"),
  ];
  const values: Record<string, DataSourcePageValueV2> = {};
  const putValue = (key: string, value: DatabaseJsonValue): void => {
    const definition = properties.find((candidate) => candidate.propertyId === key);
    if (!definition) return;
    values[definition.propertyId] = {
      propertyId: definition.propertyId,
      valueType: definition.valueType,
      value,
      revision: 1,
    };
  };
  putValue("status", page.status);
  putValue("priority", page.priority ?? null);
  putValue("estimate", page.estimate ?? null);
  putValue("tags", page.tags);
  putValue("due_date", page.dueDate?.toISOString().slice(0, 10) ?? null);
  putValue("scheduled_start", page.scheduledStart?.toISOString() ?? null);
  putValue("scheduled_end", page.scheduledEnd?.toISOString() ?? null);
  putValue("assignee", page.assignee ?? null);
  putValue("p_C0nf1d3n", 0.82);
  putValue("p_Appr0v3d", true);
  putValue("p_N0t3sxxx", "Ready for design review");
  const timestamp = page.created.toISOString();
  return {
    ok: true,
    value: {
      projectId,
      libraryId,
      storeEpoch,
      commitSeq,
      authorization: authorizedReadStampFixture({
        deliveryAddress: {
          kind: "project",
          library_id: libraryId,
          project_id: projectId,
        },
        subject: { kind: "page", page_id: page.id },
        storeEpoch,
        commitSeq,
      }),
      page: {
        pageId: page.id,
        libraryId,
        parent: { kind: "data_source", dataSourceId },
        lifecycle: page.archived ? "archived" : "active",
        parentRevision: 1,
        metadataRevision: page.revision ?? 1,
        documentId: `document:${page.id}`,
        documentGeneration: 1,
        documentHeadSeq: 1,
        title: page.title,
        richTitle: page.richTitle ?? plainTextToPortableRichText(page.title),
        preview: page.description.slice(0, 240),
        plainText: page.description,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      document: {
        readiness: "ready",
        schemaKey: "nodex.page",
        schemaVersion: 3,
      },
      intrinsicProperties: [
        intrinsic("schedule.isAllDay", Boolean(page.isAllDay)),
        intrinsic("recurrence.config", page.recurrence ?? null),
        intrinsic("reminders.config", page.reminders ?? []),
        intrinsic("schedule.timezone", page.scheduleTimezone ?? null),
        intrinsic("run.target", page.runInTarget ?? "localProject"),
        intrinsic("run.localPath", page.runInLocalPath ?? null),
        intrinsic("run.baseBranch", page.runInBaseBranch ?? null),
        intrinsic("run.worktreePath", page.runInWorktreePath ?? null),
        intrinsic("run.environmentPath", page.runInEnvironmentPath ?? null),
      ],
      dataSourceContext: {
        kind: "member",
        pageKey: page.pageKey ?? null,
        membership: {
          membershipId: `membership:${page.id}`,
          dataSourceId,
          revision: 1,
          createdAt: timestamp,
        },
        database: {
          databaseId,
          libraryId,
          name: "Story Database",
          lifecycle: "active",
          defaultViewId: viewId,
          accessRevision: 1,
          metadataRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        dataSource: {
          dataSourceId,
          libraryId,
          homeDatabaseId: databaseId,
          name: "Pages",
          schemaKey: "nodex.data-source",
          schemaRevision: 1,
          lifecycle: "active",
          rankKey: "a0",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        properties,
        pageLayout: {
          dataSourceId,
          revision: 1,
          entries: properties.map((property) => ({
            propertyId: property.propertyId,
            rankKey: property.rankKey,
            visibility: "always_show" as const,
          })),
        },
        values,
      },
    },
  };
};
