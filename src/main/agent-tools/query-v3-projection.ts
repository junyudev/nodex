import type {
  DatabaseViewQueryResultV2,
  DataSourceQueryResultV2,
} from "../../shared/database-module-v2";
import { parseDataSourcePropertyId } from "../../shared/database-identities";
import { NodexAgentReadError } from "./read-support";

type QueryValue =
  | { readonly kind: "query"; readonly value: DatabaseViewQueryResultV2 }
  | { readonly kind: "data_source_query"; readonly value: DataSourceQueryResultV2 };

interface QuerySelect {
  readonly propertyIds?: readonly string[];
  readonly documentSummary?: boolean;
}

export const projectNodexAgentQueryV3Data = (
  result: QueryValue,
  select: QuerySelect | undefined,
) => {
  const query = result.value;
  const selectedPropertyIds = select?.propertyIds?.map(parseDataSourcePropertyId);
  const activeProperties = query.properties.filter((property) => property.lifecycle === "active");
  const propertyById = new Map(
    activeProperties.map((property) => [property.propertyId, property] as const),
  );
  const properties = selectedPropertyIds
    ? selectedPropertyIds.map((propertyId) => {
        const property = propertyById.get(propertyId);
        if (property) return property;
        throw new NodexAgentReadError(
          "not_found",
          `Data Source property ${propertyId} was not found`,
          false,
          "none",
          { resourceId: propertyId, domainCode: "property_not_found" },
        );
      })
    : activeProperties;
  const selected = new Set<string>(properties.map((property) => property.propertyId));
  return {
    database: {
      databaseId: query.database.databaseId,
      name: query.database.name,
    },
    dataSource: {
      dataSourceId: query.dataSource.dataSourceId,
      name: query.dataSource.name,
      properties: properties.map((property) => ({
        propertyId: property.propertyId,
        name: property.name,
        valueType: property.valueType,
        config: property.config,
      })),
    },
    ...(result.kind === "query"
      ? {
          view: {
            viewId: result.value.view.viewId,
            dataSourceId: result.value.view.dataSourceId,
            name: result.value.view.name,
            layout: result.value.view.layout,
          },
        }
      : {}),
    rows: query.rows.map((row) => ({
      pageId: row.page.pageId,
      pageKey: row.pageKey,
      title: row.page.title,
      values: Object.fromEntries(
        Object.entries(row.values)
          .filter(([propertyId]) => selected.has(propertyId))
          .map(([propertyId, value]) => [propertyId, value.value]),
      ),
      ...(result.kind === "query" && row.position
        ? {
            placement: {
              viewId: result.value.view.viewId,
              groupKey: row.effectiveGroupKey,
            },
          }
        : {}),
      ...(select?.documentSummary ? { documentSummary: row.page.preview } : {}),
    })),
  };
};
