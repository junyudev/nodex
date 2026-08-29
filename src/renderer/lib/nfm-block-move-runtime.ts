import {
  type DatabaseContainerDescriptorV2,
  type DatabaseModuleErrorV2,
  type DatabaseModuleReadRequestV2,
  type DatabaseModuleReadResultV2,
  type DatabaseViewRecordV2,
} from "../../shared/database-module-v2";
import type {
  BlockTransferCommandError,
  BlockTransferCommandResult,
  BlockTransferDocumentHead,
} from "../../shared/block-transfer";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { PublicBlockTransferIntent } from "../../shared/block-transfer-transport";
import type { DocumentSyncCommandError } from "../../shared/block-documents/document-sync";
import type { ProjectAccessedDocumentDescriptor } from "../../shared/block-documents/contracts";
import type { DocumentHeadFence } from "./block-document-surface-runtime";
import { prepareOwnedBlockDocument, readDatabaseModule, transferBlocks } from "./api";

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
  readonly destination: NfmBlockMoveDestination;
}

export interface NfmBlockMoveRuntimeDependencies {
  readonly preparePage: (
    projectId: string,
    pageId: string,
  ) => Promise<
    | { readonly ok: true; readonly value: ProjectAccessedDocumentDescriptor }
    | { readonly ok: false; readonly error: DocumentSyncCommandError }
  >;
  readonly readDatabase: (
    projectId: string,
    request: DatabaseModuleReadRequestV2,
  ) => Promise<DatabaseModuleReadResultV2>;
  readonly transfer: (
    projectId: string,
    intent: PublicBlockTransferIntent,
  ) => Promise<BlockTransferCommandResult>;
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
  preparePage: prepareOwnedBlockDocument,
  readDatabase: readDatabaseModule,
  transfer: transferBlocks,
  createOperationId: createUuidV7,
};

const commandError = (error: BlockTransferCommandError): NfmBlockMoveError =>
  new NfmBlockMoveError({
    code: `block_transfer.${error.code}`,
    message: error.message,
    retryable: error.retryable,
    reloadRequired: error.reloadRequired,
    operationId: error.operationId,
  });

const documentError = (error: DocumentSyncCommandError, operationId: string): NfmBlockMoveError =>
  new NfmBlockMoveError({
    code: `document.${error.code}`,
    message: error.message,
    retryable: error.retryable,
    reloadRequired: error.resetRequired,
    operationId,
  });

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
 * Commits one selected-Block move after the editor has flushed its source
 * surface. Target identity, authorization reads, and BlockTransfer compilation
 * stay behind this interface so picker callers cannot assemble partial moves.
 */
export const moveNfmBlocks = async (
  request: NfmBlockMoveRequest,
  dependencies: NfmBlockMoveRuntimeDependencies = defaultDependencies,
) => {
  const operationId = dependencies.createOperationId();
  if (request.rootBlockIds.length === 0) {
    fail("selection.empty", "No blocks selected.", operationId);
  }
  if (request.destination.projectId !== request.projectId) {
    fail("destination.cross_project", "Choose a destination in the current Project.", operationId);
  }
  const sourceHead = requireSourceFence(request, operationId);

  let target: PublicBlockTransferIntent["target"];
  let causalDependencies: readonly BlockTransferDocumentHead[] = [sourceHead];

  if (request.destination.kind === "page") {
    if (request.destination.pageId === request.sourcePageId) {
      fail("destination.same_page", "Choose a different destination Page.", operationId);
    }
    const prepared = await dependencies.preparePage(request.projectId, request.destination.pageId);
    if (!prepared.ok) throw documentError(prepared.error, operationId);
    if (prepared.value.documentId === request.sourceDocumentId) {
      fail("destination.same_document", "Choose a different destination Page.", operationId);
    }
    if (prepared.value.storeEpoch !== request.storeEpoch) {
      fail(
        "destination.store_epoch_mismatch",
        "The source and destination Pages belong to different store epochs.",
        operationId,
        { reloadRequired: true },
      );
    }
    target = { kind: "page", pageId: request.destination.pageId };
    causalDependencies = [
      sourceHead,
      {
        documentId: prepared.value.documentId,
        generation: prepared.value.generation,
        expectedHeadSeq: prepared.value.headSeq,
      },
    ];
  } else {
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
    target = {
      kind: "data_source",
      dataSourceId: view.dataSourceId,
      placement: {
        kind: "direct",
        viewId: view.viewId,
        preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
        groupKey: request.destination.columnId,
      },
    };
  }

  const result = await dependencies.transfer(request.projectId, {
    operationId,
    projectId: request.projectId,
    storeEpoch: request.storeEpoch,
    mode: "move",
    rootBlockIds: request.rootBlockIds,
    causalDependencies,
    source: { kind: "page", pageId: request.sourcePageId },
    target,
    promotionPolicy: "literal",
  });
  if (!result.ok) throw commandError(result.error);
  return result.value;
};
