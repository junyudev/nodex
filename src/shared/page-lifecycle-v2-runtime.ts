import {
  canonicalizeTagName,
  parseDataSourceId,
  parseDataSourceOptionId,
  type DataSourceOptionId,
} from "./database-identities";
import {
  parsePageLifecycleMutationRequestV2,
  PageLifecycleV2ContractError,
  type CreatePageOperationV2,
  type CreatePageTagOptionV2,
  type PageLifecycleDocumentHeadV2,
  type PageLifecycleMutationCommandErrorV2,
  type PageLifecycleMutationCommandResultV2,
  type PageLifecycleMutationReceiptV2,
  type PageLifecycleMutationRequestV2,
  type PageLifecycleOperationV2,
} from "./page-lifecycle-v2";
import type { DatabaseViewQueryResultV2 } from "./database-module-v2";
import type { PageParent } from "./page";
import type { DatabasePage, PageCreateInput, PageCreatePlacement } from "./types";
import type { ProjectionCursor } from "./projection-stream";
import type { WorkflowStatus } from "./workflow-status";
import type { BlockPropertyJsonValue } from "./block-property-mutations";
import { MAX_PAGE_TAG_LENGTH } from "./page-limits";

export interface PageLifecycleTagsPropertySnapshotV2 {
  readonly propertyId: string;
  readonly dataSourceId: string;
  readonly valueType: string;
  readonly lifecycle: string;
  readonly revision: number;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface CompilePageLifecycleCreateRequestV2Input {
  /** Version-neutral create intent with preallocated option identities. */
  readonly request: PageLifecycleCreateDisplayIntent;
  readonly tagsProperty: PageLifecycleTagsPropertySnapshotV2;
}

type PageLifecycleCreateDisplayOptionalFields = Omit<
  CreatePageOperationV2,
  | "kind"
  | "pageId"
  | "title"
  | "nfm"
  | "status"
  | "viewPlacement"
  | "dataSourceId"
  | "tagOptionIds"
  | "newTagOptions"
  | "expectedTagsPropertyRevision"
>;

export type PageLifecycleCreateDisplayOperation = Readonly<{
  kind: "create_page";
  pageId: string;
  title: string;
  nfm: string;
  status: WorkflowStatus;
  viewPlacement: CreatePageOperationV2["viewPlacement"];
  tagOptions?: NonNullable<PageCreateInput["tagOptions"]>;
}> &
  Partial<PageLifecycleCreateDisplayOptionalFields>;

export interface PageLifecycleCreateDisplayIntent {
  readonly operationId: string;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly clientSessionId?: string;
  readonly actor: Readonly<Record<string, BlockPropertyJsonValue>>;
  readonly operation: PageLifecycleCreateDisplayOperation;
}

export type PageLifecycleCreateMutationRequestV2 = PageLifecycleMutationRequestV2 & {
  readonly operation: CreatePageOperationV2;
};

interface ExistingTagOption {
  readonly optionId: DataSourceOptionId;
  readonly name: string;
  readonly nameKey: string;
}

const fail = (message: string): never => {
  throw new PageLifecycleV2ContractError(message);
};

const canonicalName = (value: unknown, label: string): string => {
  try {
    return canonicalizeTagName(value, { maxLength: MAX_PAGE_TAG_LENGTH });
  } catch (error) {
    return fail(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const parseExistingOptions = (
  property: PageLifecycleTagsPropertySnapshotV2,
): readonly ExistingTagOption[] => {
  const rawOptions = property.config.options;
  if (!Array.isArray(rawOptions)) {
    return fail("The tags Property must define an option registry");
  }
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  return rawOptions.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return fail(`The tags Property option at index ${index} must be an object`);
    }
    const option = candidate as Readonly<Record<string, unknown>>;
    let optionId: DataSourceOptionId;
    try {
      optionId = parseDataSourceOptionId({
        propertyId: "tags",
        value: option.id,
      });
    } catch (error) {
      return fail(
        `The tags Property option at index ${index} has an invalid identity: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (seenIds.has(optionId)) {
      return fail(`The tags Property repeats option identity ${optionId}`);
    }
    seenIds.add(optionId);
    const name = canonicalName(option.name, `The tags Property option ${optionId} name`);
    if (seenNames.has(name)) {
      return fail(`The tags Property repeats canonical option name ${JSON.stringify(name)}`);
    }
    seenNames.add(name);
    return { optionId, name, nameKey: name };
  });
};

const validateTagsProperty = (property: PageLifecycleTagsPropertySnapshotV2): void => {
  if (property.propertyId !== "tags") {
    return fail("Page creation requires the reserved tags Property");
  }
  if (property.valueType !== "multi_select" || property.lifecycle !== "active") {
    return fail("Page creation requires one active multi-select tags Property");
  }
  if (!Number.isSafeInteger(property.revision) || property.revision < 0) {
    return fail("The tags Property revision must be a non-negative safe integer");
  }
  try {
    parseDataSourceId(property.dataSourceId);
  } catch (error) {
    return fail(
      `The tags Property Data Source is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const compileCreateOperation = (input: {
  readonly operation: PageLifecycleCreateDisplayOperation;
  readonly tagsProperty: PageLifecycleTagsPropertySnapshotV2;
}): CreatePageOperationV2 => {
  validateTagsProperty(input.tagsProperty);
  const dataSourceId = parseDataSourceId(input.tagsProperty.dataSourceId);
  const existingOptions = parseExistingOptions(input.tagsProperty);
  const optionsById = new Map(existingOptions.map((option) => [option.optionId, option] as const));
  const optionsByName = new Map<string, ExistingTagOption[]>();
  for (const option of existingOptions) {
    const matches = optionsByName.get(option.nameKey);
    if (matches) {
      matches.push(option);
    } else {
      optionsByName.set(option.nameKey, [option]);
    }
  }

  const requestedById = new Map<DataSourceOptionId, string>();
  const requestedByName = new Map<string, DataSourceOptionId>();
  for (const requested of input.operation.tagOptions ?? []) {
    let optionId: DataSourceOptionId;
    try {
      optionId = parseDataSourceOptionId({
        propertyId: "tags",
        value: requested.optionId,
      });
    } catch (error) {
      return fail(
        `Page tag option identity is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const name = canonicalName(requested.name, "Page tag option name");
    const priorName = requestedById.get(optionId);
    if (priorName && priorName !== name) {
      return fail(`Page tag option ${optionId} has conflicting names`);
    }
    const priorId = requestedByName.get(name);
    if (priorId && priorId !== optionId) {
      return fail(`Page tag name ${JSON.stringify(name)} has conflicting identities`);
    }
    requestedById.set(optionId, name);
    requestedByName.set(name, optionId);
  }

  const tagOptionIds: DataSourceOptionId[] = [];
  const newTagOptions: CreatePageTagOptionV2[] = [];
  const sortedRequestedOptions = [...requestedById.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [optionId, name] of sortedRequestedOptions) {
    const existingOption = optionsById.get(optionId);
    if (existingOption) {
      tagOptionIds.push(existingOption.optionId);
      continue;
    }
    const existingWithName = optionsByName.get(name) ?? [];
    if (existingWithName.length > 0) {
      return fail(`Tag name ${JSON.stringify(name)} already belongs to another option identity`);
    }
    tagOptionIds.push(optionId);
    newTagOptions.push({ optionId, name });
  }

  return {
    kind: "create_page",
    pageId: input.operation.pageId,
    title: input.operation.title,
    ...(input.operation.richTitle === undefined ? {} : { richTitle: input.operation.richTitle }),
    nfm: input.operation.nfm,
    status: input.operation.status,
    priority: input.operation.priority ?? null,
    estimate: input.operation.estimate ?? null,
    dueDate: input.operation.dueDate ?? null,
    scheduledStart: input.operation.scheduledStart ?? null,
    scheduledEnd: input.operation.scheduledEnd ?? null,
    isAllDay: input.operation.isAllDay ?? false,
    recurrence: input.operation.recurrence ?? null,
    reminders: input.operation.reminders ?? [],
    scheduleTimezone: input.operation.scheduleTimezone ?? null,
    assignee: input.operation.assignee ?? null,
    runInTarget: input.operation.runInTarget ?? "localProject",
    runInLocalPath: input.operation.runInLocalPath ?? null,
    runInBaseBranch: input.operation.runInBaseBranch ?? null,
    runInWorktreePath: input.operation.runInWorktreePath ?? null,
    runInEnvironmentPath: input.operation.runInEnvironmentPath ?? null,
    ...(input.operation.beforeBlockId === undefined
      ? {}
      : { beforeBlockId: input.operation.beforeBlockId }),
    viewPlacement: input.operation.viewPlacement,
    dataSourceId,
    tagOptionIds,
    newTagOptions,
    expectedTagsPropertyRevision: input.tagsProperty.revision,
  };
};

/**
 * Compile preallocated identity intent into one self-contained exact-retry request.
 * The authority boundary validates and persists these preallocated identities;
 * it never allocates or substitutes an option identity itself.
 */
export const compilePageLifecycleCreateRequestV2 = (
  input: CompilePageLifecycleCreateRequestV2Input,
): PageLifecycleCreateMutationRequestV2 => {
  const request = input.request;
  if (request.operation.kind !== "create_page") {
    return fail("Page Lifecycle v2 compilation requires a create_page intent");
  }
  const operation = compileCreateOperation({
    operation: request.operation,
    tagsProperty: input.tagsProperty,
  });
  const compiled = parsePageLifecycleMutationRequestV2({
    operationId: request.operationId,
    projectId: request.projectId,
    storeEpoch: request.storeEpoch,
    ...(request.clientSessionId ? { clientSessionId: request.clientSessionId } : {}),
    actor: request.actor,
    operation,
  });
  if (compiled.operation.kind !== "create_page") {
    return fail("Compiled Page Lifecycle v2 request lost its create_page intent");
  }
  return compiled as PageLifecycleCreateMutationRequestV2;
};

export interface PageLifecycleDocumentCoordinateV2 {
  readonly documentId: string;
  readonly generation: number;
  readonly headSeq: number;
  readonly readiness: "pending_genesis" | "ready" | "failed";
  readonly authority: "legacy_shadow" | "ydoc_primary";
  readonly schemaKey: string;
  readonly schemaVersion: number;
}

export interface PageLifecycleMembershipCoordinateV2 {
  readonly membershipId: string;
  readonly databaseId: string;
  readonly dataSourceId: string;
  readonly membershipRevision: number;
  readonly viewId: string;
  readonly viewRevision: number;
  readonly statusPropertyId: string;
  readonly statusValueRevision: number;
  readonly status: WorkflowStatus;
  readonly position: Readonly<{
    rankKey: string;
    revision: number;
  }> | null;
}

export interface PageLifecycleRestoreEvidenceV2 {
  readonly deleteOperationId: string;
  readonly previousLifecycle: "active" | "archived";
  readonly membership: null | Readonly<{
    membershipId: string;
    databaseId: string;
    dataSourceId: string;
    status: WorkflowStatus;
    position: null | Readonly<{ viewId: string }>;
  }>;
  readonly nestedParent: null | Readonly<{
    documentId: string;
    parentBlockId: string | null;
    beforeBlockId: string | null;
  }>;
}

export interface PageLifecycleOwnedBlockAuthorityV2 {
  readonly pageId: string;
  readonly lifecycle: "active" | "archived" | "deleted";
  readonly parent: PageParent;
  readonly libraryRankKey: string | null;
  readonly metadataRevision: number;
  readonly parentRevision: number;
  readonly document: PageLifecycleDocumentCoordinateV2;
  readonly membership: PageLifecycleMembershipCoordinateV2 | null;
  readonly restoreEvidence: PageLifecycleRestoreEvidenceV2 | null;
}

export interface PageLifecyclePreflightV2 {
  readonly defaultView: DatabaseViewQueryResultV2;
  readonly tagsProperty: PageLifecycleTagsPropertySnapshotV2;
  readonly reservedBlockType: string | null;
  readonly page: PageLifecycleOwnedBlockAuthorityV2 | null;
}

export interface PageLifecyclePreflightSnapshotV2 {
  readonly projectId: string;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly value: PageLifecyclePreflightV2;
}

export type PageLifecyclePreflightErrorCodeV2 =
  | "invalid_request"
  | "store_not_initialized"
  | "project_not_found"
  | "page_not_found"
  | "authorization_denied"
  | "state_corrupt"
  | "unknown";

export type PageLifecyclePreflightResultV2 =
  | { readonly ok: true; readonly value: PageLifecyclePreflightSnapshotV2 }
  | {
      readonly ok: false;
      readonly error: Readonly<{
        code: PageLifecyclePreflightErrorCodeV2;
        message: string;
        retryable: boolean;
      }>;
    };

interface PageLifecycleIntentBaseV2 {
  readonly projectId: string;
  readonly operationId: string;
  readonly clientSessionId?: string;
}

export type PageLifecycleIntentV2 =
  | (PageLifecycleIntentBaseV2 & {
      readonly kind: "create";
      readonly pageId: string;
      readonly status: WorkflowStatus;
      readonly input: PageCreateInput;
      readonly placement?: PageCreatePlacement;
    })
  | (PageLifecycleIntentBaseV2 & {
      readonly kind: "archive";
      readonly pageId: string;
    })
  | (PageLifecycleIntentBaseV2 & {
      readonly kind: "unarchive";
      readonly pageId: string;
    })
  | (PageLifecycleIntentBaseV2 & {
      readonly kind: "delete";
      readonly pageId: string;
      readonly parentDocumentHead?: PageLifecycleDocumentHeadV2;
    })
  | (PageLifecycleIntentBaseV2 & {
      readonly kind: "restore";
      readonly pageId: string;
      readonly beforeBlockId?: string;
      readonly beforeViewPageId?: string;
      readonly parentDocumentHead?: PageLifecycleDocumentHeadV2;
    })
  | (PageLifecycleIntentBaseV2 & {
      readonly kind: "move_in_library";
      readonly pageId: string;
      readonly beforeBlockId?: string;
    });

export type PageLifecycleRuntimeErrorCodeV2 =
  | "preflight_unavailable"
  | "preflight_mismatch"
  | "page_identity_collision"
  | "page_not_found"
  | "page_lifecycle_conflict"
  | "page_parent_invalid"
  | "restore_evidence_missing"
  | "mutation_rejected";

export class PageLifecycleRuntimeErrorV2 extends Error {
  constructor(
    readonly code: PageLifecycleRuntimeErrorCodeV2,
    message: string,
    readonly commandError?: PageLifecycleMutationCommandErrorV2,
  ) {
    super(message);
    this.name = "PageLifecycleRuntimeErrorV2";
  }
}

export interface PageLifecycleRuntimeDependenciesV2 {
  readonly readPreflight: (
    projectId: string,
    pageId: string,
  ) => Promise<PageLifecyclePreflightResultV2>;
  readonly mutate: (
    projectId: string,
    request: PageLifecycleMutationRequestV2,
  ) => Promise<PageLifecycleMutationCommandResultV2>;
  readonly readBoardProjection: (
    projectId: string,
    pageId: string,
    minimumCommitCursor: ProjectionCursor,
  ) => Promise<DatabasePage | null>;
  readonly waitBeforeCanonicalReadRetry?: () => Promise<void>;
}

export interface PageLifecycleExecutionResultV2 {
  readonly receipt: PageLifecycleMutationReceiptV2;
  readonly boardProjection: DatabasePage | null;
}

const runtimeFail = (code: PageLifecycleRuntimeErrorCodeV2, message: string): never => {
  throw new PageLifecycleRuntimeErrorV2(code, message);
};

const canonicalDate = (value: Date | null | undefined): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

const canonicalDateTime = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

const primaryView = (preflight: PageLifecyclePreflightSnapshotV2) => {
  const value = preflight.value;
  if (!value) {
    return runtimeFail("preflight_mismatch", "Page lifecycle v2 preflight is missing");
  }
  const query = value.defaultView;
  const { database, dataSource, view } = query;
  if (
    database.lifecycle !== "active" ||
    database.defaultViewId !== view.viewId ||
    dataSource.lifecycle !== "active" ||
    view.lifecycle !== "active" ||
    !view.isDefault ||
    view.layout !== "board" ||
    view.databaseId !== database.databaseId ||
    view.dataSourceId !== dataSource.dataSourceId ||
    value.tagsProperty.propertyId !== "tags" ||
    value.tagsProperty.dataSourceId !== dataSource.dataSourceId
  ) {
    return runtimeFail(
      "preflight_mismatch",
      "Default Database, Data Source, View, and tags Property do not share one v2 authority",
    );
  }
  return query;
};

const requirePage = (
  preflight: PageLifecyclePreflightSnapshotV2,
  pageId: string,
): PageLifecycleOwnedBlockAuthorityV2 => {
  const page = preflight.value.page;
  if (!page || page.pageId !== pageId) {
    return runtimeFail("page_not_found", `Page does not exist: ${pageId}`);
  }
  return page;
};

const requireTopLevelPage = (
  preflight: PageLifecyclePreflightSnapshotV2,
  pageId: string,
): PageLifecycleOwnedBlockAuthorityV2 => {
  const page = requirePage(preflight, pageId);
  if (page.parent.kind !== "library" || page.libraryRankKey === null) {
    return runtimeFail("page_parent_invalid", `Page ${pageId} is not a top-level Library Page`);
  }
  return page;
};

const requireLifecyclePage = (
  preflight: PageLifecyclePreflightSnapshotV2,
  pageId: string,
): PageLifecycleOwnedBlockAuthorityV2 => {
  const page = requirePage(preflight, pageId);
  if (page.parent.kind === "page") {
    return runtimeFail("page_parent_invalid", `Nested Page ${pageId} requires a Block transfer`);
  }
  if (page.parent.kind === "library" && page.libraryRankKey === null) {
    return runtimeFail("page_parent_invalid", `Library Page ${pageId} has no top-level placement`);
  }
  if (
    page.parent.kind === "data_source" &&
    page.membership?.dataSourceId !== page.parent.dataSourceId
  ) {
    return runtimeFail(
      "preflight_mismatch",
      `Source Page ${pageId} has no matching active membership`,
    );
  }
  return page;
};

const createDisplayOperation = (
  intent: Extract<PageLifecycleIntentV2, { readonly kind: "create" }>,
  preflight: PageLifecyclePreflightSnapshotV2,
): PageLifecycleCreateDisplayOperation => {
  if (preflight.value.page || preflight.value.reservedBlockType) {
    return runtimeFail(
      "page_identity_collision",
      `Page identity is already reserved: ${intent.pageId}`,
    );
  }
  primaryView(preflight);
  const viewPlacement: CreatePageOperationV2["viewPlacement"] =
    intent.placement === "top"
      ? { kind: "start" }
      : typeof intent.placement === "object"
        ? { kind: "before", pageId: intent.placement.beforePageId }
        : { kind: "end" };
  const input = intent.input;
  return {
    kind: "create_page",
    pageId: intent.pageId,
    title: input.title,
    nfm: input.description ?? "",
    status: intent.status,
    viewPlacement,
    priority: input.priority ?? null,
    estimate: input.estimate ?? null,
    tagOptions: input.tagOptions ?? [],
    dueDate: canonicalDate(input.dueDate),
    scheduledStart: canonicalDateTime(input.scheduledStart),
    scheduledEnd: canonicalDateTime(input.scheduledEnd),
    isAllDay: input.isAllDay ?? false,
    recurrence: input.recurrence ?? null,
    reminders: input.reminders ?? [],
    scheduleTimezone: input.scheduleTimezone ?? null,
    assignee: input.assignee ?? null,
    runInTarget: input.runInTarget ?? "localProject",
    runInLocalPath: input.runInLocalPath ?? null,
    runInBaseBranch: input.runInBaseBranch ?? null,
    runInWorktreePath: input.runInWorktreePath ?? null,
    runInEnvironmentPath: input.runInEnvironmentPath ?? null,
  };
};

const runtimeActor = {
  kind: "page_lifecycle_runtime_v2",
} satisfies Readonly<Record<string, BlockPropertyJsonValue>>;

export const compilePageLifecycleRequestV2 = (input: {
  readonly intent: PageLifecycleIntentV2;
  readonly preflight: PageLifecyclePreflightSnapshotV2;
}): PageLifecycleMutationRequestV2 => {
  const { intent, preflight } = input;
  if (preflight.projectId !== intent.projectId || !preflight.storeEpoch) {
    return runtimeFail(
      "preflight_mismatch",
      "Page lifecycle v2 preflight does not match the requested Project",
    );
  }
  primaryView(preflight);

  if (intent.kind === "create") {
    const displayNameRequest: PageLifecycleCreateDisplayIntent = {
      operationId: intent.operationId,
      projectId: intent.projectId,
      storeEpoch: preflight.storeEpoch,
      ...(intent.clientSessionId ? { clientSessionId: intent.clientSessionId } : {}),
      actor: runtimeActor,
      operation: createDisplayOperation(intent, preflight),
    };
    return compilePageLifecycleCreateRequestV2({
      request: displayNameRequest,
      tagsProperty: preflight.value.tagsProperty,
    });
  }

  let operation: Exclude<PageLifecycleOperationV2, { readonly kind: "create_page" }>;
  if (intent.kind === "archive") {
    const page = requireLifecyclePage(preflight, intent.pageId);
    if (page.lifecycle !== "active") {
      return runtimeFail("page_lifecycle_conflict", `Page ${intent.pageId} is not active`);
    }
    operation = {
      kind: "archive_page",
      pageId: intent.pageId,
      expectedMetadataRevision: page.metadataRevision,
    };
  } else if (intent.kind === "unarchive") {
    const page = requireLifecyclePage(preflight, intent.pageId);
    if (page.lifecycle !== "archived") {
      return runtimeFail("page_lifecycle_conflict", `Page ${intent.pageId} is not archived`);
    }
    operation = {
      kind: "unarchive_page",
      pageId: intent.pageId,
      expectedMetadataRevision: page.metadataRevision,
    };
  } else if (intent.kind === "delete") {
    const page = requirePage(preflight, intent.pageId);
    if (page.lifecycle === "deleted") {
      return runtimeFail("page_lifecycle_conflict", `Page ${intent.pageId} is already deleted`);
    }
    operation = {
      kind: "delete_page",
      pageId: intent.pageId,
      expectedMetadataRevision: page.metadataRevision,
      expectedParentRevision: page.parentRevision,
      ...(page.parent.kind === "page"
        ? {
            parentDocumentHead:
              intent.parentDocumentHead ??
              runtimeFail(
                "page_parent_invalid",
                `Nested Page ${intent.pageId} requires the host Page Document head`,
              ),
          }
        : intent.parentDocumentHead
          ? {
              parentDocumentHead: runtimeFail(
                "page_parent_invalid",
                `Top-level Page ${intent.pageId} cannot carry a host Document head`,
              ),
            }
          : {}),
    };
  } else if (intent.kind === "restore") {
    const page = requirePage(preflight, intent.pageId);
    if (page.lifecycle !== "deleted") {
      return runtimeFail("page_lifecycle_conflict", `Page ${intent.pageId} is not deleted`);
    }
    const evidence = page.restoreEvidence;
    if (!evidence) {
      return runtimeFail(
        "restore_evidence_missing",
        `Page ${intent.pageId} has no valid delete receipt`,
      );
    }
    operation = {
      kind: "restore_page",
      pageId: intent.pageId,
      deleteOperationId: evidence.deleteOperationId,
      expectedMetadataRevision: page.metadataRevision,
      expectedParentRevision: page.parentRevision,
      membership: evidence.membership,
      ...(page.parent.kind === "page"
        ? {
            parentDocumentHead:
              intent.parentDocumentHead ??
              runtimeFail(
                "page_parent_invalid",
                `Nested Page ${intent.pageId} requires the host Page Document head`,
              ),
          }
        : intent.parentDocumentHead
          ? {
              parentDocumentHead: runtimeFail(
                "page_parent_invalid",
                `Top-level Page ${intent.pageId} cannot carry a host Document head`,
              ),
            }
          : {}),
      ...(intent.beforeBlockId ? { beforeBlockId: intent.beforeBlockId } : {}),
      ...(intent.beforeViewPageId && evidence.membership?.position
        ? {
            membership: {
              ...evidence.membership,
              position: {
                ...evidence.membership.position,
                beforeViewPageId: intent.beforeViewPageId,
              },
            },
          }
        : {}),
    };
  } else {
    const page = requireTopLevelPage(preflight, intent.pageId);
    if (page.lifecycle === "deleted") {
      return runtimeFail("page_lifecycle_conflict", `Page ${intent.pageId} is deleted`);
    }
    operation = {
      kind: "move_page_in_library",
      pageId: intent.pageId,
      expectedParentRevision: page.parentRevision,
      ...(intent.beforeBlockId ? { beforeBlockId: intent.beforeBlockId } : {}),
    };
  }

  return parsePageLifecycleMutationRequestV2({
    operationId: intent.operationId,
    projectId: intent.projectId,
    storeEpoch: preflight.storeEpoch,
    ...(intent.clientSessionId ? { clientSessionId: intent.clientSessionId } : {}),
    actor: runtimeActor,
    operation,
  });
};

const readBoardProjection = async (
  intent: PageLifecycleIntentV2,
  receipt: PageLifecycleMutationReceiptV2,
  dependencies: PageLifecycleRuntimeDependenciesV2,
): Promise<DatabasePage | null> => {
  const expectsDeleted = receipt.lifecycle === "deleted";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let page: DatabasePage | null = null;
    try {
      page = await dependencies.readBoardProjection(intent.projectId, receipt.pageId, {
        storeEpoch: receipt.storeEpoch,
        commitSeq: receipt.commitSeq,
      });
    } catch {
      // The mutation receipt is already durable. A transient projection read
      // can improve the immediate renderer result, but must not turn the
      // successful lifecycle command into a reported failure.
    }
    const matches = expectsDeleted
      ? page === null
      : page?.id === receipt.pageId && page.archived === (receipt.lifecycle === "archived");
    if (matches) return page;
    if (attempt < 2) {
      await (dependencies.waitBeforeCanonicalReadRetry?.() ?? Promise.resolve());
    }
  }
  return null;
};

export const executePageLifecycleIntentV2 = async (
  intent: PageLifecycleIntentV2,
  dependencies: PageLifecycleRuntimeDependenciesV2,
): Promise<PageLifecycleExecutionResultV2> => {
  const preflight = await dependencies.readPreflight(intent.projectId, intent.pageId);
  if (!preflight.ok) {
    throw new PageLifecycleRuntimeErrorV2("preflight_unavailable", preflight.error.message);
  }
  const request = compilePageLifecycleRequestV2({
    intent,
    preflight: preflight.value,
  });
  let result: PageLifecycleMutationCommandResultV2;
  let retried = false;
  try {
    result = await dependencies.mutate(intent.projectId, request);
  } catch {
    retried = true;
    result = await dependencies.mutate(intent.projectId, request);
  }
  if (!result.ok && result.error.retryable && !retried) {
    result = await dependencies.mutate(intent.projectId, request);
  }
  if (!result.ok) {
    throw new PageLifecycleRuntimeErrorV2("mutation_rejected", result.error.message, result.error);
  }
  return {
    receipt: result.value,
    boardProjection: await readBoardProjection(intent, result.value, dependencies),
  };
};
