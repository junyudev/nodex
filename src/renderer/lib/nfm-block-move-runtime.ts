import {
  type DatabaseContainerDescriptorV2,
  type DatabaseModuleErrorV2,
  type DatabaseModuleReadRequestV2,
  type DatabaseModuleReadResultV2,
  type DatabaseViewRecordV2,
} from "../../shared/database-module-v2";
import type { BlockTransferDocumentHead } from "../../shared/block-transfer";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { PublicBlockTransferIntent } from "../../shared/block-transfer-transport";
import type { DocumentHeadFence } from "./block-document-surface-runtime";
import { readDatabaseModule } from "./api";

const STATUS_PROPERTY_ID = "status";

export type NfmBlockMoveDestination =
  | {
      readonly kind: "db-column";
      readonly projectId: string;
      readonly columnId: string;
    }
  | {
      readonly kind: "page";
      readonly projectId: string;
      readonly pageId: string;
    };

export interface NfmBlockMoveRequest {
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly sourcePageId: string;
  readonly sourceDocumentId: string;
  readonly sourceDocumentGeneration: number;
  readonly rootBlockIds: readonly string[];
  readonly sourceHead: DocumentHeadFence;
  readonly destination: Extract<NfmBlockMoveDestination, { kind: "db-column" }>;
}

export interface NfmBlockMoveRuntimeDependencies {
  readonly readDatabase: (
    projectId: string,
    request: DatabaseModuleReadRequestV2,
  ) => Promise<DatabaseModuleReadResultV2>;
  readonly createOperationId: () => string;
}

export class NfmBlockMoveError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly reloadRequired: boolean;
  readonly operationId?: string;

  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly reloadRequired?: boolean;
    readonly operationId?: string;
  }) {
    super(input.message);
    this.name = "NfmBlockMoveError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.reloadRequired = input.reloadRequired ?? false;
    this.operationId = input.operationId;
  }
}

const defaultDependencies: NfmBlockMoveRuntimeDependencies = {
  readDatabase: readDatabaseModule,
  createOperationId: createUuidV7,
};

const databaseError = (error: DatabaseModuleErrorV2, operationId: string): NfmBlockMoveError =>
  new NfmBlockMoveError({
    code: `database.${error.code}`,
    message: error.message,
    retryable: error.retryable,
    operationId: error.operationId ?? operationId,
  });

const fail = (
  code: string,
  message: string,
  operationId: string,
  options: {
    readonly retryable?: boolean;
    readonly reloadRequired?: boolean;
  } = {},
): never => {
  throw new NfmBlockMoveError({
    code,
    message,
    operationId,
    retryable: options.retryable,
    reloadRequired: options.reloadRequired,
  });
};

const activeStatusView = (
  descriptor: DatabaseContainerDescriptorV2,
): DatabaseViewRecordV2 | null => {
  const activeSourceIds = new Set(
    descriptor.dataSources
      .filter((source) => source.lifecycle === "active")
      .map((source) => source.dataSourceId),
  );
  const candidates = descriptor.views.filter(
    (view) =>
      view.lifecycle === "active" &&
      activeSourceIds.has(view.dataSourceId) &&
      view.config.presentation.group?.propertyId === STATUS_PROPERTY_ID,
  );
  const defaultViewId = descriptor.database.defaultViewId;
  return candidates.find((view) => view.viewId === defaultViewId) ?? candidates[0] ?? null;
};

const requireSourceFence = (
  request: NfmBlockMoveRequest,
  operationId: string,
): BlockTransferDocumentHead => {
  const { sourceHead } = request;
  if (
    sourceHead.storeEpoch !== request.storeEpoch ||
    sourceHead.documentId !== request.sourceDocumentId ||
    sourceHead.generation !== request.sourceDocumentGeneration
  ) {
    fail(
      "source.changed",
      "The source Page changed; reopen it before moving Blocks.",
      operationId,
      { reloadRequired: true },
    );
  }
  return {
    documentId: sourceHead.documentId,
    generation: sourceHead.generation,
    expectedHeadSeq: sourceHead.expectedHeadSeq,
  };
};

const readProjectDefaultDatabase = async (
  projectId: string,
  operationId: string,
  dependencies: NfmBlockMoveRuntimeDependencies,
) => {
  const result = await dependencies.readDatabase(projectId, {
    projectId,
    read: {
      target: { kind: "project_default" },
      mode: "database",
    },
  });
  if (!result.ok) throw databaseError(result.error, operationId);
  if (result.value.projectId !== projectId) {
    fail(
      "database.scope_mismatch",
      "The destination Database does not match this Project.",
      operationId,
    );
  }
  const readValue = result.value.value;
  if (readValue.kind !== "database") {
    return fail(
      "database.invalid_response",
      "The destination Database returned an unexpected response.",
      operationId,
    );
  }
  const descriptor = readValue.value;
  if (descriptor.database.lifecycle !== "active") {
    fail("database.unavailable", "The destination Database is not active.", operationId);
  }
  return {
    snapshot: result.value,
    descriptor,
  };
};

/**
 * Compiles a Promotion request after the surface owner admits and fences the gesture.
 * Page-to-Page moves belong to the editor's structural history session.
 * Target identity, authorization reads, and BlockTransfer compilation
 * stay behind this interface so picker callers cannot assemble partial moves.
 */
export const prepareNfmBlockPromotion = async (
  request: NfmBlockMoveRequest,
  dependencies: NfmBlockMoveRuntimeDependencies = defaultDependencies,
): Promise<PublicBlockTransferIntent> => {
  const operationId = dependencies.createOperationId();
  if (request.rootBlockIds.length === 0) {
    fail("selection.empty", "No blocks selected.", operationId);
  }
  if (request.destination.projectId !== request.projectId) {
    fail("destination.cross_project", "Choose a destination in the current Project.", operationId);
  }
  const sourceHead = requireSourceFence(request, operationId);

  const { snapshot, descriptor } = await readProjectDefaultDatabase(
    request.projectId,
    operationId,
    dependencies,
  );
  if (snapshot.storeEpoch !== request.storeEpoch) {
    fail(
      "destination.store_epoch_mismatch",
      "The source Page and destination Database belong to different store epochs.",
      operationId,
      { reloadRequired: true },
    );
  }
  const view = activeStatusView(descriptor);
  if (view === null) {
    return fail(
      "database.status_view_unavailable",
      "This Project has no active Database View grouped by Status.",
      operationId,
    );
  }
  const target: PublicBlockTransferIntent["target"] = {
    kind: "data_source",
    dataSourceId: view.dataSourceId,
    placement: {
      kind: "direct",
      viewId: view.viewId,
      preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
      groupKey: request.destination.columnId,
    },
  };

  return {
    operationId,
    projectId: request.projectId,
    storeEpoch: request.storeEpoch,
    mode: "move",
    rootBlockIds: request.rootBlockIds,
    causalDependencies: [sourceHead],
    source: { kind: "page", pageId: request.sourcePageId },
    target,
    promotionPolicy: "literal",
  };
};
