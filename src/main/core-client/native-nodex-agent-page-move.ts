import type { components } from "@nodex/core-protocol";
import { createHash } from "node:crypto";
import type {
  ExecuteNodexAgentMovePagesResult,
  NodexAgentDocumentHead,
  NodexAgentMovePagesCommand,
  PrepareNodexAgentMovePagesRequest,
  PrepareNodexAgentMovePagesResult,
} from "../../shared/nodex-agent-tools";
import { MovePagesV6OutputSchema } from "../../shared/nodex-agent-tools/v6-schemas";
import { TransferBlocksInputSchema } from "../../shared/nodex-agent-tools/write-schemas";
import { nativeAgentClient, type NativeNodexAgentCore } from "./native-nodex-agent-core";
import { toCoreAgentExecutionAuthorization } from "./core-agent-execution-authorization";
import {
  hasExactNativeAgentDocumentHeads,
  nativeAgentDocumentCommits,
  nativeAgentDocumentHeads,
  nativeAgentPageLocation,
  preparedAgentPageDestination,
  toCoreAgentPageDestination,
} from "./native-nodex-agent-page-destination";
import { mapNativeNodexAgentCoreError } from "./native-nodex-agent-page-update";
import type {
  NativeNodexAgentMutationStep,
  NodexAgentMutationEnvelope,
} from "./native-nodex-agent-mutation-step";
import { applyResultCursor } from "./types";

export type CoreMoveRequest = components["schemas"]["LibraryAgentMovePagesRequest"];
export type CoreMoveResult = components["schemas"]["LibraryAgentMovePagesResult"];
export type CoreMovePreparation = components["schemas"]["LibraryAgentMovePagesPreparation"];
export type CoreMovePagePreparation = components["schemas"]["LibraryAgentMovePagePreparation"];

export interface PendingNativePageMove {
  readonly request: PrepareNodexAgentMovePagesRequest;
  readonly operationId: string;
  readonly token: string;
  readonly coreRequest: CoreMoveRequest;
  readonly documentHeads: readonly NodexAgentDocumentHead[];
}

const envelope = <Result>(
  result: Result,
  mutationId: string,
): NodexAgentMutationEnvelope<Result> => ({
  result,
  events: [],
  metrics: {
    mutationId,
    queueWaitMs: 0,
    workerDurationMs: 0,
    transactionMs: 0,
    eventCount: 0,
  },
});

export const nativeNodexAgentPageMoveOperationId = (
  request: Pick<PrepareNodexAgentMovePagesRequest, "threadId" | "callId" | "operationId">,
): string =>
  request.operationId ??
  `nodex-agent-move-pages:${createHash("sha256")
    .update(JSON.stringify([request.threadId, request.callId, "move_pages"]))
    .digest("hex")}`;

const coreRequest = (request: PrepareNodexAgentMovePagesRequest): CoreMoveRequest => ({
  page_ids: [...request.input.pageIds],
  destination: toCoreAgentPageDestination(request.input.destination),
});

const output = (result: CoreMoveResult) =>
  MovePagesV6OutputSchema.parse({
    data: {
      pages: result.pages.map((page) => ({
        pageId: page.page_id,
        pageKey: page.page_key ?? null,
        location: nativeAgentPageLocation(page.location),
      })),
      moved: result.pages.length,
    },
  });

const sourceInput = (page: CoreMovePagePreparation) => {
  if (page.source.kind === "library") {
    return {
      kind: "library" as const,
      libraryId: page.source.library_id,
    };
  }
  if (page.source.kind === "data_source") {
    if (!page.source_database_id) {
      throw new Error(`Core Agent Page move omitted source Database for ${page.page_id}`);
    }
    return {
      kind: "data_source" as const,
      dataSourceId: page.source.data_source_id,
    };
  }
  const documentId =
    page.source.kind === "document" ? page.source.document_id : page.source_document_id;
  if (!documentId) {
    throw new Error(`Core Agent Page move omitted source Document for ${page.page_id}`);
  }
  return { kind: "document" as const, documentId };
};

const destinationInput = (
  request: PrepareNodexAgentMovePagesRequest,
  preparation: CoreMovePreparation,
) => {
  const destination = request.input.destination;
  if (destination.kind === "library") {
    return {
      kind: "library" as const,
      ...(destination.at ? { at: destination.at } : {}),
    };
  }
  if (destination.kind === "page") {
    const document = preparation.destination_document;
    if (!document) throw new Error("Core Agent Page move omitted its target Document");
    return {
      kind: "document" as const,
      documentId: document.document_id,
      at: destination.at ?? { kind: "end" as const },
    };
  }
  const databaseId = preparation.destination_database_id;
  if (!databaseId) throw new Error("Core Agent Page move omitted its target Database");
  return {
    kind: "data_source" as const,
    dataSourceId: destination.dataSourceId,
    ...(destination.values ? { values: destination.values } : {}),
    ...(destination.view ? { view: destination.view } : {}),
  };
};

const command = (
  request: PrepareNodexAgentMovePagesRequest,
  operationId: string,
  preparation: CoreMovePreparation,
): NodexAgentMovePagesCommand => {
  if (!request.authority) {
    throw new Error("Native Agent Page movement requires frozen Turn authority");
  }
  if (preparation.pages.length !== request.input.pageIds.length) {
    throw new Error("Core Agent Page movement returned a divergent Page batch");
  }
  const destination = preparedAgentPageDestination(preparation);
  const normalizedDestination = destinationInput(request, preparation);
  return {
    ...request,
    requestHash: operationId,
    mutationId: operationId,
    storeEpoch: request.authority.storeEpoch,
    input: request.input,
    destination,
    transfers: preparation.pages.map((page) => ({
      pageId: page.page_id,
      normalizedInput: TransferBlocksInputSchema.parse({
        mode: "move",
        blockIds: [page.page_id],
        from: sourceInput(page),
        destination: normalizedDestination,
      }),
      transfer: null,
    })),
    documentHeads: nativeAgentDocumentHeads(preparation.document_heads),
  };
};

export const prepareNativeNodexAgentPageMove = async (
  runtime: NativeNodexAgentCore,
  request: PrepareNodexAgentMovePagesRequest,
  signal?: AbortSignal,
): Promise<
  NativeNodexAgentMutationStep<
    NodexAgentMutationEnvelope<PrepareNodexAgentMovePagesResult>,
    PendingNativePageMove
  >
> => {
  const operationId = nativeNodexAgentPageMoveOperationId(request);
  try {
    if (!request.authority) {
      throw new Error("Native Agent Page movement requires frozen Turn authority");
    }
    const moveRequest = coreRequest(request);
    const snapshot = await nativeAgentClient(runtime, request.projectId).libraryRead(
      {
        kind: "prepare_agent_move_pages",
        operation_id: operationId,
        store_epoch: request.authority.storeEpoch,
        authorization: toCoreAgentExecutionAuthorization(
          runtime.identity.profileId,
          request.authority,
          request.callId,
          request.resourceAccess,
        ),
        request: moveRequest,
      },
      { class: "background", signal },
    );
    if (snapshot.value.kind !== "agent_move_pages_preparation") {
      throw new Error("Core returned the wrong Agent Page-move preparation variant");
    }
    const preparation = snapshot.value.value;
    if (preparation.preparation.state === "committed_replay") {
      const committed = preparation.committed?.outcome.agent_move_pages;
      if (!committed) throw new Error("Core Agent Page-move replay omitted its result");
      return {
        result: envelope(
          { ok: true, value: { kind: "completed", output: output(committed) } },
          operationId,
        ),
        transition: { kind: "clear", operationId },
      };
    }
    const token = preparation.preparation.token;
    if (!token) throw new Error("Core Agent Page-move preparation omitted its token");
    const documentHeads = nativeAgentDocumentHeads(preparation.document_heads);
    const pending: PendingNativePageMove = {
      request,
      operationId,
      token,
      coreRequest: moveRequest,
      documentHeads,
    };
    return {
      result: envelope(
        {
          ok: true,
          value: {
            kind: "prepared",
            command: command(request, operationId, preparation),
            authorization: {
              roots: Object.fromEntries(
                request.input.pageIds.map((pageId) => [
                  pageId,
                  { type: "page" as const, transformation: "preserved" as const },
                ]),
              ),
              documentIds: documentHeads.map((head) => head.documentId),
            },
          },
        },
        operationId,
      ),
      transition: { kind: "retain", pending },
    };
  } catch (error) {
    return {
      result: envelope({ ok: false, error: mapNativeNodexAgentCoreError(error) }, operationId),
      transition: { kind: "keep" },
    };
  }
};

export const executeNativeNodexAgentPageMove = async (
  runtime: NativeNodexAgentCore,
  pending: PendingNativePageMove | undefined,
  command: NodexAgentMovePagesCommand,
  signal?: AbortSignal,
): Promise<
  NativeNodexAgentMutationStep<ExecuteNodexAgentMovePagesResult, PendingNativePageMove>
> => {
  if (
    !pending ||
    pending.request.projectId !== command.projectId ||
    pending.request.callId !== command.callId ||
    pending.request.threadId !== command.threadId ||
    pending.request.authority?.storeEpoch !== command.storeEpoch ||
    !hasExactNativeAgentDocumentHeads(pending.documentHeads, command.documentHeads)
  ) {
    return {
      result: {
        ok: false,
        error: {
          code: "idempotency_collision",
          message: "Native Agent Page movement has no matching preparation",
          retryable: false,
          recovery: "none",
        },
      },
      transition: { kind: "keep" },
    };
  }
  const authority = pending.request.authority;
  if (!authority) {
    return {
      result: {
        ok: false,
        error: {
          code: "authorization_denied",
          message: "Native Agent Page movement lost its frozen Turn authority",
          retryable: false,
          recovery: "start_new_task",
        },
      },
      transition: { kind: "keep" },
    };
  }
  try {
    const committed = await nativeAgentClient(runtime, pending.request.projectId).libraryApply(
      {
        operationId: pending.operationId,
        intent: {
          kind: "execute_prepared_agent_move_pages",
          authorization: {
            authorization: toCoreAgentExecutionAuthorization(
              runtime.identity.profileId,
              authority,
              pending.request.callId,
              pending.request.resourceAccess,
            ),
            token: pending.token,
          },
          request: pending.coreRequest,
        },
      },
      { signal },
    );
    const result = committed.outcome.agent_move_pages;
    if (!result) throw new Error("Core Agent Page-move commit omitted its result");
    return {
      result: {
        ok: true,
        value: {
          output: output(result),
          duplicate: committed.receipt.duplicate,
          documentCommits: nativeAgentDocumentCommits(result.document_commits),
          affectedDatabaseBlockIds: [...result.affected_database_ids],
          commitSeq: applyResultCursor(committed),
        },
      },
      transition: { kind: "clear", operationId: command.mutationId },
    };
  } catch (error) {
    return {
      result: { ok: false, error: mapNativeNodexAgentCoreError(error) },
      transition: { kind: "keep" },
    };
  }
};
