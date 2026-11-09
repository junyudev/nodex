import { projectCoreWorkSummary } from "./work-graph";
import type { components } from "@nodex/core-protocol";
import type { DataSourcePageRowV2, DataSourcePropertyRecordV2 } from "./database-module-v2";
import type { DataSourceId } from "./database-identities";
import type { DatabaseJsonValue } from "./database-kernel";

type CoreDatabaseRowSummary = components["schemas"]["DatabaseRowSummary"];

/**
 * Losslessly projects one exact-head Core row into the renderer query model.
 * Canonical reads and direct local projection effects share this function so
 * a fast-path row has the same shape as its later read-repair replacement.
 */
export const projectCoreDatabaseQueryRow = (
  row: CoreDatabaseRowSummary,
  input: {
    readonly libraryId: string;
    readonly dataSourceId: DataSourceId;
    readonly properties: readonly DataSourcePropertyRecordV2[];
  },
): DataSourcePageRowV2 => {
  const propertiesById = new Map(
    input.properties.map((property) => [property.propertyId, property] as const),
  );
  return {
    work: projectCoreWorkSummary(row.work),
    pageKey: row.page_key ?? null,
    page: {
      pageId: row.page_id,
      libraryId: input.libraryId,
      parent: {
        kind: "data_source",
        dataSourceId: input.dataSourceId,
      },
      lifecycle:
        row.lifecycle === "archived" || row.lifecycle === "deleted" ? row.lifecycle : "active",
      parentRevision: row.parent_revision,
      metadataRevision: row.metadata_revision,
      documentId: row.document_id,
      documentGeneration: row.document_generation,
      documentHeadSeq: row.document_head_seq,
      title: row.title,
      richTitle: Array.isArray(row.rich_title) ? row.rich_title : [],
      preview: row.description_preview,
      plainText: row.description_preview,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    membership: {
      membershipId: row.membership_id,
      dataSourceId: input.dataSourceId,
      revision: row.membership_revision,
      createdAt: row.membership_created_at,
    },
    values: Object.fromEntries(
      Object.entries(row.database_values).map(([propertyId, propertyValue]) => {
        const property = propertiesById.get(propertyId as never);
        return [
          propertyId,
          {
            propertyId: propertyId as never,
            valueType: property?.valueType ?? "text",
            value: propertyValue as DatabaseJsonValue,
            revision: row.database_value_revisions[propertyId] ?? 0,
          },
        ];
      }),
    ),
    position: row.rank_key
      ? {
          rankKey: row.rank_key,
          revision: row.position_revision ?? 0,
        }
      : null,
    effectiveGroupKey: row.effective_group_key ?? null,
    effectiveSubgroupKey: row.effective_subgroup_key ?? null,
    taskParent: {
      parentPageId: row.task_parent_page_id ?? null,
      siblingRank: row.task_sibling_rank ?? null,
      valueRevision: row.task_parent_value_revision,
    },
    intrinsicProperties: Object.entries(row.intrinsic_properties).map(([key, propertyValue]) => ({
      key,
      valueType: "json",
      value: propertyValue as DatabaseJsonValue,
      revision: 0,
    })),
  };
};
