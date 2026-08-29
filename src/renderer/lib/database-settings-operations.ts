import type {
  DatabaseViewFilterGroup,
  DatabaseViewFilterNode,
  DatabaseViewConfigV6,
  DatabaseViewField,
  DatabaseViewLayout,
} from "../../shared/database-kernel";
import type {
  DatabaseApplyOperationV2,
  DatabasePropertySchemaV2,
  DatabaseViewRecordV2,
  DataSourceDescriptorV2,
  DataSourcePropertyRecordV2,
} from "../../shared/database-module-v2";
import {
  createCustomOptionId,
  createCustomPropertyId,
  parseDatabaseViewId,
  parseDataSourceOptionId,
  type DatabaseViewId,
  type DataSourceId,
} from "../../shared/database-identities";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  databaseViewMoveBeforeId,
  databaseViewReorderBeforeId,
  emptyDatabaseViewConfig,
} from "./database-view-authoring";

const filterWithoutProperty = (
  node: DatabaseViewFilterNode,
  propertyId: string,
): DatabaseViewFilterNode | null => {
  if (node.kind === "clause") return node.propertyId === propertyId ? null : node;
  return {
    ...node,
    children: node.children.flatMap((child) => {
      const next = filterWithoutProperty(child, propertyId);
      return next ? [next] : [];
    }),
  };
};

const filterGroupWithoutProperty = (
  group: DatabaseViewFilterGroup,
  propertyId: string,
): DatabaseViewFilterGroup => ({
  ...group,
  children: group.children.flatMap((child) => {
    const next = filterWithoutProperty(child, propertyId);
    return next ? [next] : [];
  }),
});

const fieldReferencesProperty = (field: DatabaseViewField, propertyId: string): boolean =>
  field.kind === "property" && field.propertyId === propertyId;

/** Removes every currently supported View reference to one Source Property. */
export const databaseViewConfigWithoutProperty = (
  config: DatabaseViewConfigV6,
  propertyId: string,
): DatabaseViewConfigV6 => ({
  ...config,
  rules: {
    propertyFilters: config.rules.propertyFilters.filter(
      (filter) => filter.clause.propertyId !== propertyId,
    ),
    advancedFilter: config.rules.advancedFilter
      ? filterGroupWithoutProperty(config.rules.advancedFilter, propertyId)
      : null,
    sorts: config.rules.sorts.filter(
      (sort) => sort.field.kind !== "property" || sort.field.propertyId !== propertyId,
    ),
  },
  presentation: {
    ...config.presentation,
    group: config.presentation.group?.propertyId === propertyId ? null : config.presentation.group,
    subgroup:
      config.presentation.subgroup?.propertyId === propertyId ? null : config.presentation.subgroup,
    display: {
      ...config.presentation.display,
      fields: config.presentation.display.fields.filter(
        (field) => !fieldReferencesProperty(field, propertyId),
      ),
      propertyOrder: config.presentation.display.propertyOrder.filter(
        (candidate) => candidate !== propertyId,
      ),
    },
    conditionalColors: config.presentation.conditionalColors.filter(
      (rule) => rule.propertyId !== propertyId,
    ),
  },
});

export const putDatabaseViewOperation = (
  view: DatabaseViewRecordV2,
  patch: {
    readonly name?: string;
    readonly layout?: DatabaseViewLayout;
    readonly config?: DatabaseViewConfigV6;
    readonly isDefault?: boolean;
    readonly beforeViewId?: DatabaseViewId | null;
  } = {},
): DatabaseApplyOperationV2 => ({
  kind: "put_view",
  databaseId: view.databaseId,
  dataSourceId: view.dataSourceId,
  viewId: view.viewId,
  expectedRevision: view.revision,
  name: patch.name ?? view.name,
  layout: patch.layout ?? view.layout,
  config: patch.config ?? view.config,
  isDefault: patch.isDefault ?? view.isDefault,
  ...(patch.beforeViewId === undefined ? {} : { beforeViewId: patch.beforeViewId }),
});

export const createDatabaseViewOperation = (input: {
  readonly databaseId: DatabaseViewRecordV2["databaseId"];
  readonly dataSourceId: DataSourceId;
  readonly name: string;
  readonly layout: DatabaseViewLayout;
  readonly viewId?: DatabaseViewId;
}): DatabaseApplyOperationV2 => ({
  kind: "put_view",
  databaseId: input.databaseId,
  dataSourceId: input.dataSourceId,
  viewId: input.viewId ?? parseDatabaseViewId(createUuidV7()),
  expectedRevision: 0,
  name: input.name,
  layout: input.layout,
  config: emptyDatabaseViewConfig(),
  isDefault: false,
  beforeViewId: null,
});

export const duplicateDatabaseViewOperation = (input: {
  readonly view: DatabaseViewRecordV2;
  readonly viewId?: DatabaseViewId;
}): DatabaseApplyOperationV2 => ({
  kind: "duplicate_view",
  databaseId: input.view.databaseId,
  sourceViewId: input.view.viewId,
  expectedRevision: input.view.revision,
  newViewId: input.viewId ?? parseDatabaseViewId(createUuidV7()),
});

export const changeDatabaseViewLayoutOperation = (
  view: DatabaseViewRecordV2,
  layout: DatabaseViewLayout,
): DatabaseApplyOperationV2 => ({
  kind: "change_view_layout",
  databaseId: view.databaseId,
  viewId: view.viewId,
  expectedRevision: view.revision,
  layout,
});

export const moveDatabaseViewOperation = (
  views: readonly DatabaseViewRecordV2[],
  view: DatabaseViewRecordV2,
  direction: "up" | "down",
): DatabaseApplyOperationV2 | null => {
  const beforeViewId = databaseViewMoveBeforeId(views, view.viewId, direction);
  if (beforeViewId === undefined) return null;
  return {
    kind: "move_view",
    databaseId: view.databaseId,
    viewId: view.viewId,
    expectedRevision: view.revision,
    placement:
      beforeViewId === null
        ? { kind: "end" }
        : { kind: "before", viewId: parseDatabaseViewId(beforeViewId) },
  };
};

export const reorderDatabaseViewOperation = (
  views: readonly DatabaseViewRecordV2[],
  viewId: string,
  requestedOrder: readonly string[],
): DatabaseApplyOperationV2 | null => {
  const view = views.find(
    (candidate) => candidate.lifecycle === "active" && candidate.viewId === viewId,
  );
  if (!view) return null;
  const beforeViewId = databaseViewReorderBeforeId(views, viewId, requestedOrder);
  if (beforeViewId === undefined) return null;
  return {
    kind: "move_view",
    databaseId: view.databaseId,
    viewId: view.viewId,
    expectedRevision: view.revision,
    placement:
      beforeViewId === null
        ? { kind: "end" }
        : { kind: "before", viewId: parseDatabaseViewId(beforeViewId) },
  };
};

export const createDataSourcePropertyOperation = (input: {
  readonly source: DataSourceDescriptorV2;
  readonly name: string;
  readonly schema: DatabasePropertySchemaV2;
}): DatabaseApplyOperationV2 => ({
  kind: "put_property",
  dataSourceId: input.source.dataSource.dataSourceId,
  propertyId: createCustomPropertyId(),
  expectedDataSourceRevision: input.source.dataSource.schemaRevision,
  expectedPropertyRevision: 0,
  name: input.name,
  schema: input.schema,
});

export const putDataSourcePropertyOperation = (
  source: DataSourceDescriptorV2,
  property: DataSourcePropertyRecordV2,
  patch: {
    readonly name?: string;
    readonly schema?: DatabasePropertySchemaV2;
    readonly beforePropertyId?: DataSourcePropertyRecordV2["propertyId"];
  } = {},
): DatabaseApplyOperationV2 => ({
  kind: "put_property",
  dataSourceId: source.dataSource.dataSourceId,
  propertyId: property.propertyId,
  expectedDataSourceRevision: source.dataSource.schemaRevision,
  expectedPropertyRevision: property.revision,
  name: patch.name ?? property.name,
  schema: patch.schema ?? property.schema,
  ...(patch.beforePropertyId === undefined ? {} : { beforePropertyId: patch.beforePropertyId }),
});

export const moveDataSourcePropertyOperation = (
  source: DataSourceDescriptorV2,
  property: DataSourcePropertyRecordV2,
  direction: "up" | "down",
): DatabaseApplyOperationV2 | null => {
  const ordered = source.properties.filter((candidate) => candidate.lifecycle === "active");
  const index = ordered.findIndex((candidate) => candidate.propertyId === property.propertyId);
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) return null;
  const remaining = ordered.filter((candidate) => candidate.propertyId !== property.propertyId);
  const beforePropertyId = remaining[targetIndex]?.propertyId;
  return {
    kind: "move_property",
    dataSourceId: source.dataSource.dataSourceId,
    propertyId: property.propertyId,
    expectedDataSourceRevision: source.dataSource.schemaRevision,
    expectedPropertyRevision: property.revision,
    placement: beforePropertyId
      ? { kind: "before", propertyId: beforePropertyId }
      : { kind: "end" },
  };
};

export const changeDataSourcePropertyTypeOperation = (input: {
  readonly source: DataSourceDescriptorV2;
  readonly property: DataSourcePropertyRecordV2;
  readonly schema: DatabasePropertySchemaV2;
}): DatabaseApplyOperationV2 => ({
  kind: "change_property_type",
  dataSourceId: input.source.dataSource.dataSourceId,
  propertyId: input.property.propertyId,
  expectedDataSourceRevision: input.source.dataSource.schemaRevision,
  expectedPropertyRevision: input.property.revision,
  schema: input.schema,
});

export const duplicateDataSourcePropertyOperation = (input: {
  readonly source: DataSourceDescriptorV2;
  readonly property: DataSourcePropertyRecordV2;
  readonly options: readonly { readonly id: string }[];
}): DatabaseApplyOperationV2 => {
  const newPropertyId = createCustomPropertyId();
  return {
    kind: "duplicate_property",
    dataSourceId: input.source.dataSource.dataSourceId,
    propertyId: input.property.propertyId,
    expectedDataSourceRevision: input.source.dataSource.schemaRevision,
    expectedPropertyRevision: input.property.revision,
    newPropertyId,
    name: `${input.property.name} copy`,
    optionIds: input.options.map((option) => ({
      sourceOptionId: parseDataSourceOptionId({
        propertyId: input.property.propertyId,
        value: option.id,
      }),
      newOptionId: parseDataSourceOptionId({
        propertyId: newPropertyId,
        value: createCustomOptionId(),
      }),
    })),
  };
};

export const restoreDataSourcePropertyOperation = (input: {
  readonly source: DataSourceDescriptorV2;
  readonly property: DataSourcePropertyRecordV2;
}): DatabaseApplyOperationV2 => ({
  kind: "restore_property",
  dataSourceId: input.source.dataSource.dataSourceId,
  propertyId: input.property.propertyId,
  expectedDataSourceRevision: input.source.dataSource.schemaRevision,
  expectedPropertyRevision: input.property.revision,
});

export const permanentlyDeleteDataSourcePropertyOperation = (input: {
  readonly source: DataSourceDescriptorV2;
  readonly property: DataSourcePropertyRecordV2;
}): DatabaseApplyOperationV2 => ({
  kind: "permanently_delete_property",
  dataSourceId: input.source.dataSource.dataSourceId,
  propertyId: input.property.propertyId,
  expectedDataSourceRevision: input.source.dataSource.schemaRevision,
  expectedPropertyRevision: input.property.revision,
});

/** Repairs all active View references and soft-deletes the Property atomically. */
export const deleteDataSourcePropertyOperations = (input: {
  readonly source: DataSourceDescriptorV2;
  readonly views: readonly DatabaseViewRecordV2[];
  readonly property: DataSourcePropertyRecordV2;
}): readonly DatabaseApplyOperationV2[] => {
  const viewRepairs = input.views.flatMap((view) => {
    if (view.lifecycle !== "active" || view.dataSourceId !== input.source.dataSource.dataSourceId) {
      return [];
    }
    const nextConfig = databaseViewConfigWithoutProperty(view.config, input.property.propertyId);
    if (JSON.stringify(nextConfig) === JSON.stringify(view.config)) return [];
    return [putDatabaseViewOperation(view, { config: nextConfig })];
  });
  return [
    ...viewRepairs,
    {
      kind: "delete_property",
      dataSourceId: input.source.dataSource.dataSourceId,
      propertyId: input.property.propertyId,
      expectedDataSourceRevision: input.source.dataSource.schemaRevision,
      expectedPropertyRevision: input.property.revision,
    },
  ];
};
