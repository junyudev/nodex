import type {
  BlockPropertyFieldMutationV2,
  BlockPropertyJsonValueV2,
  BlockPropertyMutationCommandResultV2,
  BlockPropertyMutationRequestV2,
  LibraryBlockPropertyMutationCommandResultV2,
  LibraryBlockPropertyMutationRequestV2,
} from "../../shared/block-property-mutations-v2";
import { stableStringifyBlockPropertyJsonV2 } from "../../shared/block-property-mutations-v2";
import {
  parseDataSourceId,
  parseDataSourceOptionId,
  parseDataSourcePropertyId,
  type DataSourceOptionId,
} from "../../shared/database-identities";
import { BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS } from "../../shared/data-source-built-ins";
import {
  type DatabaseApplyOperationV2,
  type DatabaseApplyResultV2,
  type DatabaseApplyV2,
  type DatabasePropertyValueInputV2,
  type LibraryDatabaseApplyResultV2,
  type LibraryDatabaseApplyV2,
} from "../../shared/database-module-v2";
import {
  type LibraryModuleApplyRequest,
  type LibraryModuleApplyResult,
} from "../../shared/library-module";
import { libraryContentRoute, projectContentRoute } from "../../shared/content-routing-context";
import { isWorkflowStatus } from "../../shared/workflow-status";
import type { DatabaseJsonValue, DatabasePropertyValueType } from "../../shared/database-kernel";
import type { LibraryPageDetail, PageDetail } from "../../shared/page-detail";
import type { PageInput, PageRunInTarget, Estimate, Priority } from "../../shared/types";
import { isPriority } from "../../shared/priority";
import {
  applyDatabaseModule,
  applyLibraryModule,
  applyLibraryDatabaseModule,
  mutateBlockProperties,
  mutateLibraryBlockProperties,
  readLibraryPageDetail,
} from "./api";
import { fetchPageDetail } from "./page-detail-store";
import type { PageStageMetadataMutationResult } from "./page-stage-page";
import {
  buildDataSourceCreateOptionAndSelectOperations,
  buildDataSourceMultiSelectPatchOperations,
  buildDataSourcePropertyValueOperations,
  buildDataSourceRelationPatchOperations,
  buildDataSourceRelationReplacementOperations,
} from "./data-source-property-value-operations";
import type { PageStagePropertyEdit } from "./page-stage-properties";

type MetadataPatch = Partial<PageInput>;
type PageDetailMetadataSource = PageDetail | LibraryPageDetail;
type DataSourceProperty = Extract<
  PageDetailMetadataSource["dataSourceContext"],
  { readonly kind: "member" }
>["properties"][number];

export interface PageDetailMetadataRuntimeDependencies {
  readonly readDetail: (projectId: string, pageId: string) => Promise<PageDetail | null>;
  readonly mutateProperties: (
    projectId: string,
    request: BlockPropertyMutationRequestV2,
  ) => Promise<BlockPropertyMutationCommandResultV2>;
  readonly applyDatabase: (
    projectId: string,
    request: DatabaseApplyV2,
  ) => Promise<DatabaseApplyResultV2>;
  readonly applyMetadataProperties: (
    projectId: string,
    request: LibraryModuleApplyRequest,
  ) => Promise<LibraryModuleApplyResult>;
  readonly refreshDetail: (projectId: string, pageId: string) => Promise<unknown>;
}

export interface PageMetadataCommitCursor {
  readonly storeEpoch: string;
  readonly commitSeq: number;
}

export interface PageDetailMetadataMutationEnvelope {
  readonly result: PageStageMetadataMutationResult;
  readonly commitCursor: PageMetadataCommitCursor | null;
}

const DEFAULT_DEPENDENCIES: PageDetailMetadataRuntimeDependencies = {
  readDetail: fetchPageDetail,
  mutateProperties: mutateBlockProperties,
  applyDatabase: applyDatabaseModule,
  applyMetadataProperties: (projectId, request) =>
    applyLibraryModule(projectContentRoute(projectId), request),
  refreshDetail: fetchPageDetail,
};

export interface LibraryPageDetailMetadataRuntimeDependencies {
  readonly readDetail: (pageId: string) => Promise<LibraryPageDetail | null>;
  readonly mutateProperties: (
    request: LibraryBlockPropertyMutationRequestV2,
  ) => Promise<LibraryBlockPropertyMutationCommandResultV2>;
  readonly applyDatabase: (
    request: LibraryDatabaseApplyV2,
  ) => Promise<LibraryDatabaseApplyResultV2>;
  readonly applyMetadataProperties: (
    request: LibraryModuleApplyRequest,
  ) => Promise<LibraryModuleApplyResult>;
  readonly refreshDetail: (pageId: string) => Promise<unknown>;
}

const readLibraryDetail = async (pageId: string): Promise<LibraryPageDetail | null> => {
  const result = await readLibraryPageDetail(pageId);
  return result.ok ? result.value : null;
};

const DEFAULT_LIBRARY_DEPENDENCIES: LibraryPageDetailMetadataRuntimeDependencies = {
  readDetail: readLibraryDetail,
  mutateProperties: mutateLibraryBlockProperties,
  applyDatabase: applyLibraryDatabaseModule,
  applyMetadataProperties: (request) => applyLibraryModule(libraryContentRoute, request),
  refreshDetail: readLibraryDetail,
};

const DATABASE_FIELDS = {
  status: { key: "status", ...BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS.status },
  priority: { key: "priority", ...BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS.priority },
  estimate: { key: "estimate", ...BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS.estimate },
  tags: { key: "tags", ...BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS.tags },
  dueDate: { key: "due_date", ...BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS.due_date },
  scheduledStart: {
    key: "scheduled_start",
    ...BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS.scheduled_start,
  },
  scheduledEnd: {
    key: "scheduled_end",
    ...BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS.scheduled_end,
  },
  assignee: { key: "assignee", ...BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS.assignee },
} as const satisfies Partial<
  Record<keyof PageInput, { readonly key: string; readonly valueType: DatabasePropertyValueType }>
>;

const INTRINSIC_FIELDS = {
  isAllDay: "schedule.isAllDay",
  recurrence: "recurrence.config",
  reminders: "reminders.config",
  scheduleTimezone: "schedule.timezone",
  runInTarget: "run.target",
  runInLocalPath: "run.localPath",
  runInBaseBranch: "run.baseBranch",
  runInWorktreePath: "run.worktreePath",
  runInEnvironmentPath: "run.environmentPath",
} as const satisfies Partial<Record<keyof PageInput, string>>;

const hasOwn = <Key extends PropertyKey>(value: object, key: Key): value is Record<Key, unknown> =>
  Object.hasOwn(value, key);

const DATABASE_FIELD_NAMES = new Set<string>(Object.keys(DATABASE_FIELDS));
const INTRINSIC_FIELD_NAMES = new Set<string>(Object.keys(INTRINSIC_FIELDS));
const PROJECT_EXECUTION_FIELD_NAMES = new Set<string>([
  "runInTarget",
  "runInLocalPath",
  "runInBaseBranch",
  "runInWorktreePath",
  "runInEnvironmentPath",
]);
const ESTIMATES = new Set<Estimate>(["xs", "s", "m", "l", "xl"]);
const RUN_TARGETS = new Set<PageRunInTarget>(["localProject", "newWorktree", "cloud"]);

const portableValue = (value: unknown, label: string): BlockPropertyJsonValueV2 => {
  try {
    return JSON.parse(stableStringifyBlockPropertyJsonV2(value)) as BlockPropertyJsonValueV2;
  } catch (error) {
    throw new TypeError(`${label} must be bounded portable JSON`, {
      cause: error,
    });
  }
};

const stableEqual = (left: unknown, right: unknown): boolean =>
  stableStringifyBlockPropertyJsonV2(left) === stableStringifyBlockPropertyJsonV2(right);

export const isPageMetadataPatch = (patch: Partial<PageInput>): boolean => {
  const fields = Object.keys(patch);
  return (
    fields.length > 0 &&
    fields.every((field) => DATABASE_FIELD_NAMES.has(field) || INTRINSIC_FIELD_NAMES.has(field))
  );
};

const databaseValue = (field: keyof typeof DATABASE_FIELDS, value: unknown): DatabaseJsonValue => {
  if (value === undefined) {
    throw new TypeError(`Page ${field} must be omitted instead of undefined`);
  }
  if (field === "dueDate") {
    if (value === null) return null;
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    throw new TypeError("Page dueDate must be a valid Date or null");
  }
  if (field === "scheduledStart" || field === "scheduledEnd") {
    if (value === null) return null;
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value.toISOString();
    }
    throw new TypeError(`Page ${field} must be a valid Date or null`);
  }
  if (field === "status") {
    if (isWorkflowStatus(value)) return value;
    throw new TypeError("Page status must be a canonical status");
  }
  if (field === "priority") {
    if (value === null || isPriority(value)) {
      return value as Priority | null;
    }
    throw new TypeError("Page priority is invalid");
  }
  if (field === "estimate") {
    if (value === null || ESTIMATES.has(value as Estimate)) {
      return value as Estimate | null;
    }
    throw new TypeError("Page estimate is invalid");
  }
  if (field === "tags") {
    if (!Array.isArray(value)) throw new TypeError("Page tags must be an array");
    const tags = value.map((tag, index) => {
      if (typeof tag === "string" && tag.length > 0 && tag.length <= 512 && tag === tag.trim()) {
        return tag;
      }
      throw new TypeError(`Page tags[${index}] must be a canonical tag`);
    });
    return [...new Set(tags)].sort();
  }
  if (field === "assignee") {
    if (typeof value === "string") return value.trim() || null;
    throw new TypeError("Page assignee must be a string");
  }
  return portableValue(value, `Page ${field}`);
};

const intrinsicValue = (
  field: keyof typeof INTRINSIC_FIELDS,
  value: unknown,
): BlockPropertyJsonValueV2 => {
  if (value === undefined) {
    throw new TypeError(`Page ${field} must be omitted instead of undefined`);
  }
  if (field === "isAllDay") {
    if (typeof value === "boolean") return value;
    if (value === null) return false;
    throw new TypeError("Page isAllDay must be a boolean or null");
  }
  if (field === "reminders") {
    if (Array.isArray(value)) return portableValue(value, "Page reminders");
    throw new TypeError("Page reminders must be an array");
  }
  if (field === "recurrence") {
    if (value === null) return null;
    return portableValue(value, "Page recurrence");
  }
  if (field === "runInTarget") {
    if (RUN_TARGETS.has(value as PageRunInTarget)) {
      return value as PageRunInTarget;
    }
    throw new TypeError("Page runInTarget is invalid");
  }
  if (value === null) return null;
  if (typeof value === "string") return value.trim() || null;
  throw new TypeError(`Page ${field} must be a string or null`);
};

const resolveTagOptionIds = (
  property: DataSourceProperty,
  requestedOptionIds: readonly string[],
): readonly DataSourceOptionId[] => {
  const propertyId = parseDataSourcePropertyId(property.propertyId);
  try {
    return [
      ...new Set(
        requestedOptionIds.map((optionId) =>
          parseDataSourceOptionId({ propertyId, value: optionId }),
        ),
      ),
    ].sort();
  } catch (cause) {
    throw new Error(`Data Source Property ${property.propertyId} requires canonical option IDs`, {
      cause,
    });
  }
};

type PagePropertyValueOperation = Extract<
  DatabaseApplyOperationV2,
  { readonly kind: "edit_property_values" }
>;

const compileDataSourceFields = (
  detail: PageDetailMetadataSource,
  patch: MetadataPatch,
): readonly PagePropertyValueOperation[] => {
  const entries = Object.entries(DATABASE_FIELDS) as Array<
    [
      keyof typeof DATABASE_FIELDS,
      { readonly key: string; readonly valueType: DatabasePropertyValueType },
    ]
  >;
  const requested = entries.filter(([field]) => hasOwn(patch, field));
  if (requested.length === 0) return [];
  if (detail.dataSourceContext.kind !== "member") {
    throw new Error("This Page has no Data Source properties");
  }
  const context = detail.dataSourceContext;
  const edits: Extract<
    DatabaseApplyOperationV2,
    {
      readonly kind: "edit_property_values";
    }
  >["edits"][number][] = [];
  for (const [field, definition] of requested) {
    const property = context.properties.find(
      (candidate) => candidate.propertyId === definition.key,
    );
    if (!property) {
      throw new Error(
        `Data Source ${context.dataSource.dataSourceId} has no ${definition.key} property`,
      );
    }
    if (property.valueType !== definition.valueType) {
      throw new Error(
        `Data Source property ${property.propertyId} has incompatible type ${property.valueType}`,
      );
    }
    const requestedValue = databaseValue(field, patch[field]);
    const current = context.values[property.propertyId];
    const currentValue = current?.value ?? (property.valueType === "multi_select" ? [] : null);
    const propertyId = parseDataSourcePropertyId(property.propertyId);
    const dataSourceId = parseDataSourceId(context.dataSource.dataSourceId);
    if (property.valueType === "multi_select") {
      if (!Array.isArray(requestedValue)) {
        throw new Error(`Data Source Property ${property.propertyId} requires option IDs`);
      }
      const value = resolveTagOptionIds(property, requestedValue);
      if (
        !Array.isArray(currentValue) ||
        !currentValue.every((entry) => typeof entry === "string")
      ) {
        throw new Error(`Data Source Property ${property.propertyId} has a corrupt value`);
      }
      const currentIds = currentValue.map((optionId) =>
        parseDataSourceOptionId({ propertyId, value: optionId }),
      );
      const currentSet = new Set(currentIds);
      const nextSet = new Set(value);
      const add = value.filter((optionId) => !currentSet.has(optionId));
      const remove = currentIds.filter((optionId) => !nextSet.has(optionId));
      if (add.length === 0 && remove.length === 0) continue;
      edits.push({
        pageId: detail.page.pageId,
        dataSourceId,
        propertyId,
        edit: {
          kind: "patch_set",
          delta: {
            kind: "multi_select",
            addOptionIds: add,
            removeOptionIds: remove,
          },
        },
      });
      continue;
    }
    if (typeof requestedValue !== "string" && requestedValue !== null) {
      throw new Error(`Data Source Property ${property.propertyId} requires a scalar value`);
    }
    if (stableEqual(currentValue, requestedValue)) continue;
    let value: DatabasePropertyValueInputV2;
    if (requestedValue === null) {
      value = { kind: "empty" };
    } else if (property.valueType === "select") {
      value = {
        kind: "select",
        optionId: parseDataSourceOptionId({ propertyId, value: requestedValue }),
      };
    } else if (property.valueType === "date") {
      value = { kind: "date", value: requestedValue };
    } else if (property.valueType === "datetime") {
      value = { kind: "datetime", value: requestedValue };
    } else if (property.valueType === "text") {
      value = { kind: "text", value: requestedValue };
    } else {
      throw new Error(
        `Page Detail cannot edit ${property.valueType} Property ${property.propertyId}`,
      );
    }
    edits.push({
      pageId: detail.page.pageId,
      dataSourceId,
      propertyId,
      edit: {
        kind: "replace",
        expectedValueRevision: current?.revision ?? 0,
        value,
      },
    });
  }
  return edits.length === 0 ? [] : [{ kind: "edit_property_values", edits }];
};

const compileIntrinsicFields = (
  detail: PageDetailMetadataSource,
  patch: MetadataPatch,
): readonly BlockPropertyFieldMutationV2[] => {
  const entries = Object.entries(INTRINSIC_FIELDS) as Array<
    [keyof typeof INTRINSIC_FIELDS, string]
  >;
  return entries.flatMap(([field, propertyKey]) => {
    if (!hasOwn(patch, field)) return [];
    const current = detail.intrinsicProperties.find((property) => property.key === propertyKey);
    const value = intrinsicValue(field, patch[field]);
    if (current && stableEqual(current.value, value)) return [];
    return [
      {
        scope: "intrinsic" as const,
        blockId: detail.page.pageId,
        propertyKey,
        operation: "set" as const,
        expectedRevision: current?.revision ?? 0,
        value,
      },
    ];
  });
};

const retryPropertyMutation = async (
  projectId: string,
  request: BlockPropertyMutationRequestV2,
  dependencies: PageDetailMetadataRuntimeDependencies,
): Promise<BlockPropertyMutationCommandResultV2> => {
  try {
    const result = await dependencies.mutateProperties(projectId, request);
    if (result.ok || !result.error.retryable) return result;
  } catch {
    // Durable mutation identity makes one exact retry transport-safe.
  }
  return await dependencies.mutateProperties(projectId, request);
};

const retryDatabaseMutation = async (
  projectId: string,
  request: DatabaseApplyV2,
  dependencies: PageDetailMetadataRuntimeDependencies,
): Promise<DatabaseApplyResultV2> => {
  try {
    const result = await dependencies.applyDatabase(projectId, request);
    if (result.ok || !result.error.retryable) return result;
  } catch {
    // Database operation identity makes one exact retry transport-safe.
  }
  return await dependencies.applyDatabase(projectId, request);
};

const retryMetadataPropertiesMutation = async (
  projectId: string,
  request: LibraryModuleApplyRequest,
  dependencies: PageDetailMetadataRuntimeDependencies,
): Promise<LibraryModuleApplyResult> => {
  try {
    const result = await dependencies.applyMetadataProperties(projectId, request);
    if (result.ok || !result.error.retryable) return result;
  } catch {
    // The Library operation identity makes one exact retry transport-safe.
  }
  return await dependencies.applyMetadataProperties(projectId, request);
};

const refreshPageDetailBestEffort = async (
  projectId: string,
  pageId: string,
  dependencies: PageDetailMetadataRuntimeDependencies,
): Promise<void> => {
  try {
    await dependencies.refreshDetail(projectId, pageId);
  } catch {
    // Projection refresh is a visual follow-up, not part of the durable command.
  }
};

const mutationEnvelope = (
  result: PageStageMetadataMutationResult,
  commitCursor: PageMetadataCommitCursor | null = null,
): PageDetailMetadataMutationEnvelope => ({ result, commitCursor });

export const commitPageDetailMetadataPatchWithReceipt = async (input: {
  readonly projectId: string;
  readonly pageId: string;
  readonly operationId: string;
  readonly clientSessionId?: string;
  readonly patch: MetadataPatch;
  readonly dependencies?: PageDetailMetadataRuntimeDependencies;
}): Promise<PageDetailMetadataMutationEnvelope> => {
  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  if (!isPageMetadataPatch(input.patch)) {
    throw new TypeError("Page metadata patch contains unsupported fields");
  }
  const detail = await dependencies.readDetail(input.projectId, input.pageId);
  if (!detail) return mutationEnvelope({ status: "not_found" });
  const dataSourceOperations = compileDataSourceFields(detail, input.patch);
  const intrinsicFields = compileIntrinsicFields(detail, input.patch);
  if (dataSourceOperations.length === 0 && intrinsicFields.length === 0) {
    await refreshPageDetailBestEffort(input.projectId, input.pageId, dependencies);
    return mutationEnvelope(
      { status: "updated", didMutate: false },
      { storeEpoch: detail.storeEpoch, commitSeq: detail.commitSeq },
    );
  }

  if (dataSourceOperations.length > 0 && intrinsicFields.length > 0) {
    const result = await retryMetadataPropertiesMutation(
      input.projectId,
      {
        operationId: input.operationId,
        storeEpoch: detail.storeEpoch,
        operation: {
          kind: "apply_page_metadata_properties",
          ...(input.clientSessionId ? { clientSessionId: input.clientSessionId } : {}),
          databaseOperations: dataSourceOperations,
          intrinsicFields,
        },
      },
      dependencies,
    );
    if (!result.ok) {
      if (result.error.code === "revision_conflict") {
        await refreshPageDetailBestEffort(input.projectId, input.pageId, dependencies);
        return mutationEnvelope({ status: "conflict" });
      }
      if (result.error.code === "resource_not_found") {
        return mutationEnvelope({ status: "not_found" });
      }
      return mutationEnvelope({ status: "error", error: result.error.message });
    }
    await refreshPageDetailBestEffort(input.projectId, input.pageId, dependencies);
    return mutationEnvelope(
      { status: "updated", didMutate: result.value.didMutate },
      {
        storeEpoch: result.value.storeEpoch,
        commitSeq: result.value.commitSeq,
      },
    );
  }

  let commitCursor: PageMetadataCommitCursor | null = null;
  if (dataSourceOperations.length > 0) {
    const databaseResult = await retryDatabaseMutation(
      input.projectId,
      {
        operationId: input.operationId,
        projectId: input.projectId,
        storeEpoch: detail.storeEpoch,
        actor: { kind: "page_stage" },
        operations: dataSourceOperations,
      },
      dependencies,
    );
    if (!databaseResult.ok) {
      if (databaseResult.error.code === "revision_conflict") {
        await refreshPageDetailBestEffort(input.projectId, input.pageId, dependencies);
        return mutationEnvelope({ status: "conflict" });
      }
      if (databaseResult.error.code === "resource_not_found") {
        return mutationEnvelope({ status: "not_found" });
      }
      return mutationEnvelope({ status: "error", error: databaseResult.error.message });
    }
    commitCursor = {
      storeEpoch: databaseResult.value.storeEpoch,
      commitSeq: databaseResult.value.commitSeq,
    };
  }

  if (intrinsicFields.length > 0) {
    const result = await retryPropertyMutation(
      input.projectId,
      {
        mutationId: input.operationId,
        projectId: input.projectId,
        storeEpoch: detail.storeEpoch,
        ...(input.clientSessionId ? { clientSessionId: input.clientSessionId } : {}),
        actor: { kind: "page_stage" },
        fields: intrinsicFields,
      },
      dependencies,
    );
    if (!result.ok) {
      if (result.error.code === "property_conflict") {
        await refreshPageDetailBestEffort(input.projectId, input.pageId, dependencies);
        return mutationEnvelope({ status: "conflict" });
      }
      if (result.error.code === "block_not_found" || result.error.code === "project_not_found") {
        return mutationEnvelope({ status: "not_found" });
      }
      return mutationEnvelope({ status: "error", error: result.error.message });
    }
    commitCursor = {
      storeEpoch: result.value.storeEpoch,
      commitSeq: result.value.commitSeq,
    };
  }

  await refreshPageDetailBestEffort(input.projectId, input.pageId, dependencies);
  return mutationEnvelope({ status: "updated", didMutate: true }, commitCursor);
};

export const commitPageDetailMetadataPatch = async (input: {
  readonly projectId: string;
  readonly pageId: string;
  readonly operationId: string;
  readonly clientSessionId?: string;
  readonly patch: MetadataPatch;
  readonly dependencies?: PageDetailMetadataRuntimeDependencies;
}): Promise<PageStageMetadataMutationResult> => {
  const envelope = await commitPageDetailMetadataPatchWithReceipt(input);
  return envelope.result;
};

const compileDirectPropertyEdit = (
  detail: PageDetailMetadataSource,
  propertyId: string,
  edit: PageStagePropertyEdit,
): readonly DatabaseApplyOperationV2[] => {
  if (detail.dataSourceContext.kind !== "member") {
    throw new Error("This Page has no Data Source properties");
  }
  const context = detail.dataSourceContext;
  const property = context.properties.find((candidate) => candidate.propertyId === propertyId);
  if (!property) {
    throw new Error(
      `Property ${propertyId} is no longer active in Data Source ${context.dataSource.dataSourceId}`,
    );
  }
  if (edit.kind === "patch_relation") {
    return buildDataSourceRelationPatchOperations({
      pageId: detail.page.pageId,
      dataSourceId: context.dataSource.dataSourceId,
      property,
      addPageIds: edit.addPageIds,
      removeEdgeIds: edit.removeEdgeIds,
    });
  }
  if (edit.kind === "replace_one_relation") {
    return buildDataSourceRelationReplacementOperations({
      pageId: detail.page.pageId,
      dataSourceId: context.dataSource.dataSourceId,
      property,
      expectedValueRevision: edit.expectedValueRevision,
      targetPageId: edit.targetPageId,
    });
  }
  if (edit.kind === "patch_multi_select") {
    return buildDataSourceMultiSelectPatchOperations({
      pageId: detail.page.pageId,
      dataSourceId: context.dataSource.dataSourceId,
      property,
      addOptionIds: edit.addOptionIds,
      removeOptionIds: edit.removeOptionIds,
    });
  }
  if (edit.kind === "create_option_and_select") {
    return buildDataSourceCreateOptionAndSelectOperations({
      pageId: detail.page.pageId,
      dataSourceId: context.dataSource.dataSourceId,
      property: { ...property, revision: edit.expectedPropertyRevision },
      current: {
        propertyId: property.propertyId,
        valueType: property.valueType,
        revision: edit.expectedValueRevision,
        value: context.values[property.propertyId]?.value ?? null,
      },
      option: {
        id: edit.optionId,
        name: edit.name,
        ...(edit.color === undefined ? {} : { color: edit.color }),
      },
    });
  }
  return buildDataSourcePropertyValueOperations({
    pageId: detail.page.pageId,
    dataSourceId: context.dataSource.dataSourceId,
    property,
    current: {
      propertyId: property.propertyId,
      valueType: property.valueType,
      revision: edit.expectedValueRevision,
      value: context.values[property.propertyId]?.value ?? null,
    },
    value: edit.value,
  });
};

const propertyMutationResult = async (
  result: DatabaseApplyResultV2 | LibraryDatabaseApplyResultV2,
  refresh: () => Promise<unknown>,
): Promise<PageStageMetadataMutationResult> => {
  if (!result.ok) {
    if (result.error.code === "revision_conflict") {
      await refresh();
      return { status: "conflict" };
    }
    if (result.error.code === "resource_not_found") {
      await refresh();
      return { status: "not_found" };
    }
    return { status: "error", error: result.error.message };
  }
  await refresh();
  return { status: "updated", didMutate: true };
};

export const commitPageDetailPropertyEdit = async (input: {
  readonly projectId: string;
  readonly pageId: string;
  readonly propertyId: string;
  readonly operationId: string;
  readonly clientSessionId?: string;
  readonly edit: PageStagePropertyEdit;
  readonly dependencies?: PageDetailMetadataRuntimeDependencies;
}): Promise<PageStageMetadataMutationResult> => {
  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const detail = await dependencies.readDetail(input.projectId, input.pageId);
  if (!detail) return { status: "not_found" };
  const operations = compileDirectPropertyEdit(detail, input.propertyId, input.edit);
  const refresh = () => dependencies.refreshDetail(input.projectId, input.pageId);
  if (operations.length === 0) {
    await refresh();
    return { status: "updated", didMutate: false };
  }
  const result = await retryDatabaseMutation(
    input.projectId,
    {
      operationId: input.operationId,
      projectId: input.projectId,
      storeEpoch: detail.storeEpoch,
      actor: { kind: "page_stage" },
      operations,
    },
    dependencies,
  );
  return await propertyMutationResult(result, refresh);
};

const retryLibraryPropertyMutation = async (
  request: LibraryBlockPropertyMutationRequestV2,
  dependencies: LibraryPageDetailMetadataRuntimeDependencies,
): Promise<LibraryBlockPropertyMutationCommandResultV2> => {
  try {
    const result = await dependencies.mutateProperties(request);
    if (result.ok || !result.error.retryable) return result;
  } catch {
    // Durable mutation identity makes one exact retry transport-safe.
  }
  return await dependencies.mutateProperties(request);
};

const retryLibraryDatabaseMutation = async (
  request: LibraryDatabaseApplyV2,
  dependencies: LibraryPageDetailMetadataRuntimeDependencies,
): Promise<LibraryDatabaseApplyResultV2> => {
  try {
    const result = await dependencies.applyDatabase(request);
    if (result.ok || !result.error.retryable) return result;
  } catch {
    // Database operation identity makes one exact retry transport-safe.
  }
  return await dependencies.applyDatabase(request);
};

const retryLibraryMetadataPropertiesMutation = async (
  request: LibraryModuleApplyRequest,
  dependencies: LibraryPageDetailMetadataRuntimeDependencies,
): Promise<LibraryModuleApplyResult> => {
  try {
    const result = await dependencies.applyMetadataProperties(request);
    if (result.ok || !result.error.retryable) return result;
  } catch {
    // The Library operation identity makes one exact retry transport-safe.
  }
  return await dependencies.applyMetadataProperties(request);
};

export const commitLibraryPageDetailMetadataPatch = async (input: {
  readonly pageId: string;
  readonly operationId: string;
  readonly clientSessionId?: string;
  readonly patch: MetadataPatch;
  readonly dependencies?: LibraryPageDetailMetadataRuntimeDependencies;
}): Promise<PageStageMetadataMutationResult> => {
  const dependencies = input.dependencies ?? DEFAULT_LIBRARY_DEPENDENCIES;
  if (!isPageMetadataPatch(input.patch)) {
    throw new TypeError("Page metadata patch contains unsupported fields");
  }
  if (Object.keys(input.patch).some((field) => PROJECT_EXECUTION_FIELD_NAMES.has(field))) {
    throw new TypeError("Page execution settings require an explicit Project context");
  }
  const detail = await dependencies.readDetail(input.pageId);
  if (!detail) return { status: "not_found" };
  const dataSourceOperations = compileDataSourceFields(detail, input.patch);
  const intrinsicFields = compileIntrinsicFields(detail, input.patch);
  if (dataSourceOperations.length === 0 && intrinsicFields.length === 0) {
    await dependencies.refreshDetail(input.pageId);
    return { status: "updated", didMutate: false };
  }

  if (dataSourceOperations.length > 0 && intrinsicFields.length > 0) {
    const result = await retryLibraryMetadataPropertiesMutation(
      {
        operationId: input.operationId,
        storeEpoch: detail.storeEpoch,
        operation: {
          kind: "apply_page_metadata_properties",
          ...(input.clientSessionId ? { clientSessionId: input.clientSessionId } : {}),
          databaseOperations: dataSourceOperations,
          intrinsicFields,
        },
      },
      dependencies,
    );
    if (!result.ok) {
      if (result.error.code === "revision_conflict") {
        await dependencies.refreshDetail(input.pageId);
        return { status: "conflict" };
      }
      if (result.error.code === "resource_not_found") {
        return { status: "not_found" };
      }
      return { status: "error", error: result.error.message };
    }
    await dependencies.refreshDetail(input.pageId);
    return { status: "updated", didMutate: result.value.didMutate };
  }

  if (dataSourceOperations.length > 0) {
    const databaseResult = await retryLibraryDatabaseMutation(
      {
        operationId: input.operationId,
        storeEpoch: detail.storeEpoch,
        operations: dataSourceOperations,
      },
      dependencies,
    );
    if (!databaseResult.ok) {
      if (databaseResult.error.code === "revision_conflict") {
        await dependencies.refreshDetail(input.pageId);
        return { status: "conflict" };
      }
      if (databaseResult.error.code === "resource_not_found") return { status: "not_found" };
      return { status: "error", error: databaseResult.error.message };
    }
  }

  if (intrinsicFields.length > 0) {
    const result = await retryLibraryPropertyMutation(
      {
        mutationId: input.operationId,
        storeEpoch: detail.storeEpoch,
        ...(input.clientSessionId ? { clientSessionId: input.clientSessionId } : {}),
        fields: intrinsicFields,
      },
      dependencies,
    );
    if (!result.ok) {
      if (result.error.code === "property_conflict") {
        await dependencies.refreshDetail(input.pageId);
        return { status: "conflict" };
      }
      if (result.error.code === "block_not_found") return { status: "not_found" };
      return { status: "error", error: result.error.message };
    }
  }

  await dependencies.refreshDetail(input.pageId);
  return { status: "updated", didMutate: true };
};

export const commitLibraryPageDetailPropertyEdit = async (input: {
  readonly pageId: string;
  readonly propertyId: string;
  readonly operationId: string;
  readonly clientSessionId?: string;
  readonly edit: PageStagePropertyEdit;
  readonly dependencies?: LibraryPageDetailMetadataRuntimeDependencies;
}): Promise<PageStageMetadataMutationResult> => {
  const dependencies = input.dependencies ?? DEFAULT_LIBRARY_DEPENDENCIES;
  const detail = await dependencies.readDetail(input.pageId);
  if (!detail) return { status: "not_found" };
  const operations = compileDirectPropertyEdit(detail, input.propertyId, input.edit);
  const refresh = () => dependencies.refreshDetail(input.pageId);
  if (operations.length === 0) {
    await refresh();
    return { status: "updated", didMutate: false };
  }
  const result = await retryLibraryDatabaseMutation(
    {
      operationId: input.operationId,
      storeEpoch: detail.storeEpoch,
      operations,
    },
    dependencies,
  );
  return await propertyMutationResult(result, refresh);
};
