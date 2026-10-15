import {
  type DataSourcePropertyRecordV2,
  type LibraryDatabaseReadV2,
} from "../../shared/database-module-v2";
import { readDatabaseModule, readLibraryDatabaseModule } from "./api";
import type { DatabaseViewRoutingContext } from "./database-view-render-model";

const readInContext = async (
  routingContext: DatabaseViewRoutingContext,
  read: LibraryDatabaseReadV2,
) =>
  routingContext.kind === "project"
    ? await readDatabaseModule(routingContext.projectId, {
        projectId: routingContext.projectId,
        read,
      })
    : await readLibraryDatabaseModule({
        read,
      });

export const foldDataSourceRelationSearchText = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase());

export const buildDataSourceRelationCandidateRead = (input: {
  readonly property: DataSourcePropertyRecordV2;
  readonly query: string;
  readonly after?: string | null;
}): LibraryDatabaseReadV2 | null => {
  if (input.property.schema.kind !== "relation") return null;
  const query = foldDataSourceRelationSearchText(input.query.trim());
  return {
    target: {
      kind: "data_source",
      dataSourceId: input.property.schema.targetDataSourceId,
    },
    mode: "relation_candidate_window",
    ...(query ? { query } : {}),
    window: { after: input.after ?? null, first: 100 },
  };
};

export const readDataSourceRelationTargets = async (input: {
  readonly routingContext: DatabaseViewRoutingContext;
  readonly pageId: string;
  readonly property: DataSourcePropertyRecordV2;
  readonly after: string | null;
}) => {
  const read = {
    target: {
      kind: "page_property" as const,
      pageId: input.pageId,
      dataSourceId: input.property.dataSourceId,
      propertyId: input.property.propertyId,
    },
    mode: "relation_target_window" as const,
    window: { after: input.after, first: 100 },
  };
  const result = await readInContext(input.routingContext, read);
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.value.kind !== "relation_target_window") {
    throw new Error("Database returned a non-Relation window");
  }
  return result.value.value.value;
};

export const searchDataSourceRelationCandidates = async (input: {
  readonly routingContext: DatabaseViewRoutingContext;
  readonly property: DataSourcePropertyRecordV2;
  readonly query: string;
  readonly after?: string | null;
}) => {
  const read = buildDataSourceRelationCandidateRead(input);
  if (!read) {
    return { candidates: [], nextCursor: null, projectionRevision: 0 };
  }
  const result = await readInContext(input.routingContext, read);
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.value.kind !== "relation_candidate_window") {
    throw new Error("Database returned a non-candidate Relation window");
  }
  return result.value.value.value;
};

export const readDataSourceRelationTargetDescriptor = async (input: {
  readonly routingContext: DatabaseViewRoutingContext;
  readonly property: DataSourcePropertyRecordV2;
}): Promise<{ readonly name: string } | null> => {
  if (input.property.schema.kind !== "relation") return null;
  const result = await readInContext(input.routingContext, {
    target: {
      kind: "data_source",
      dataSourceId: input.property.schema.targetDataSourceId,
    },
    mode: "data_source",
  });
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.value.kind !== "data_source") {
    throw new Error("Database returned a non-Data Source descriptor");
  }
  return { name: result.value.value.value.dataSource.name };
};
