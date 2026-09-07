import type { components } from "@nodex/core-protocol";
import { createHash } from "node:crypto";
import type {
  ExecuteNodexAgentDuplicatePageResult,
  NodexAgentDuplicatePageCommand,
  PrepareNodexAgentDuplicatePageRequest,
  PrepareNodexAgentDuplicatePageResult,
} from "../../shared/nodex-agent-tools";
import { DuplicatePageV6OutputSchema } from "../../shared/nodex-agent-tools/v6-schemas";
import { TransferBlocksInputSchema } from "../../shared/nodex-agent-tools/write-schemas";
import { nativeAgentClient, type NativeNodexAgentCore } from "./native-nodex-agent-core";
import { toCoreAgentExecutionAuthorization } from "./core-agent-execution-authorization";
import {
  hasExactNativeAgentDocumentHeads,
  nativeAgentDocumentCommits,
  nativeAgentPageLocation,
  nativeAgentDocumentHeads,
  preparedAgentPageDestination,
  toCoreAgentPageDestination,
} from "./native-nodex-agent-page-destination";
import { mapNativeNodexAgentCoreError } from "./native-nodex-agent-page-update";
import type {
  NativeNodexAgentMutationStep,
  NodexAgentMutationEnvelope,
} from "./native-nodex-agent-mutation-step";
import { applyResultCursor } from "./types";

export type CoreCopyRequest = components["schemas"]["LibraryAgentPageCopyRequest"];
export type CoreCopyResult = components["schemas"]["LibraryAgentPageCopyResult"];
export type CoreCopyPreparation = components["schemas"]["LibraryAgentPageCopyPreparation"];

export interface PendingNativePageCopy {
  readonly request: PrepareNodexAgentDuplicatePageRequest;
  readonly operationId: string;
  readonly token: string;
  readonly coreRequest: CoreCopyRequest;
  readonly documentHeads: NodexAgentDuplicatePageCommand["documentHeads"];
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

export const nativeNodexAgentPageCopyOperationId = (
  request: Pick<PrepareNodexAgentDuplicatePageRequest, "threadId" | "callId" | "operationId">,
): string =>
  request.operationId ??
  `nodex-agent-duplicate:${createHash("sha256")
    .update(JSON.stringify([request.threadId, request.callId, "duplicate_page"]))
    .digest("hex")}`;

const coreRequest = (request: PrepareNodexAgentDuplicatePageRequest): CoreCopyRequest => ({
  source_page_id: request.input.pageId,
  destination: toCoreAgentPageDestination(request.input.destination),
  include_block_map: request.input.return?.includes("block_map") ?? false,
  include_etags: request.input.return?.includes("etags") ?? false,
});

const output = (result: CoreCopyResult, includeBlockMap: boolean) =>
  DuplicatePageV6OutputSchema.parse({
    data: {
      sourcePageId: result.source_page_id,
      pageId: result.page_id,
      pageKey: result.page_key ?? null,
      location: nativeAgentPageLocation(result.location),
      bodyBlocksCreated: result.body_blocks_created,
      ...(includeBlockMap && result.block_map ? { blockMap: result.block_map } : {}),
      ...(result.etags ? { etags: { title: result.etags.title, body: result.etags.body } } : {}),
    },
  });

const preparedDestination = (
  _request: PrepareNodexAgentDuplicatePageRequest,
  preparation: CoreCopyPreparation,
): NodexAgentDuplicatePageCommand["destination"] => preparedAgentPageDestination(preparation);

const normalizedInput = (
  request: PrepareNodexAgentDuplicatePageRequest,
  preparation: CoreCopyPreparation,
): NodexAgentDuplicatePageCommand["normalizedInput"] => {
  const destination = request.input.destination;
  if (destination.kind === "library") {
    return TransferBlocksInputSchema.parse({
      mode: "copy",
      blockIds: [request.input.pageId],
      destination: { kind: "library", ...(destination.at ? { at: destination.at } : {}) },
      return: { blockMap: request.input.return?.includes("block_map") ?? false },
    });
  }
  if (destination.kind === "page") {
    const target = preparation.destination_document;
    if (!target) {
      throw new Error("Core Agent Page copy preparation omitted its target Document");
    }
    return TransferBlocksInputSchema.parse({
      mode: "copy",
      blockIds: [request.input.pageId],
      destination: {
        kind: "document",
        documentId: target.document_id,
        at:
          destination.at?.kind === "before" || destination.at?.kind === "after"
            ? { kind: destination.at.kind, blockId: destination.at.blockId }
            : { kind: destination.at?.kind ?? "end" },
      },
      return: { blockMap: request.input.return?.includes("block_map") ?? false },
    });
  }
  const databaseId = preparation.destination_database_id;
  if (!databaseId) {
    throw new Error("Core Agent Page copy preparation omitted its target Database");
  }
  return TransferBlocksInputSchema.parse({
    mode: "copy",
    blockIds: [request.input.pageId],
    destination: {
      kind: "data_source",
      dataSourceId: destination.dataSourceId,
      values: destination.values,
      ...(destination.view
        ? {
            view: {
              viewId: destination.view.viewId,
              groupKey: destination.view.groupKey,
              at: destination.view.at,
            },
          }
        : {}),
    },
    return: { blockMap: request.input.return?.includes("block_map") ?? false },
  });
};

export const prepareNativeNodexAgentPageCopy = async (
  runtime: NativeNodexAgentCore,
  request: PrepareNodexAgentDuplicatePageRequest,
  signal?: AbortSignal,
): Promise<
  NativeNodexAgentMutationStep<
    NodexAgentMutationEnvelope<PrepareNodexAgentDuplicatePageResult>,
    PendingNativePageCopy
  >
> => {
  const operationId = nativeNodexAgentPageCopyOperationId(request);
  try {
    if (!request.authority) {
      throw new Error("Native Agent Page copy requires frozen Turn authority");
    }
    const copyRequest = coreRequest(request);
    const snapshot = await nativeAgentClient(runtime, request.projectId).libraryRead(
      {
        kind: "prepare_agent_page_copy",
        operation_id: operationId,
        store_epoch: request.authority.storeEpoch,
        authorization: toCoreAgentExecutionAuthorization(
          runtime.identity.profileId,
          request.authority,
          request.callId,
          request.resourceAccess,
        ),
        request: copyRequest,
      },
      { class: "background", signal },
    );
    if (snapshot.value.kind !== "agent_page_copy_preparation") {
      throw new Error("Core returned the wrong Agent Page copy preparation variant");
    }
    const preparation = snapshot.value.value;
    if (preparation.preparation.state === "committed_replay") {
      const committed = preparation.committed?.outcome.agent_page_copy;
      if (!committed) throw new Error("Core Agent Page copy replay omitted its result");
      return {
        result: envelope(
          {
            ok: true,
            value: {
              kind: "completed",
              output: output(committed, request.input.return?.includes("block_map") ?? false),
            },
          },
          operationId,
        ),
        transition: { kind: "clear", operationId },
      };
    }
    const token = preparation.preparation.token;
    if (!token) throw new Error("Core Agent Page copy preparation omitted its token");
    const documentHeads = nativeAgentDocumentHeads(preparation.document_heads);
    const pending: PendingNativePageCopy = {
      request,
      operationId,
      token,
      coreRequest: copyRequest,
      documentHeads,
    };
    const command: NodexAgentDuplicatePageCommand = {
      ...request,
      requestHash: operationId,
      mutationId: operationId,
      storeEpoch: request.authority.storeEpoch,
      input: request.input,
      normalizedInput: normalizedInput(request, preparation),
      destination: preparedDestination(request, preparation),
      documentHeads,
      canonical: { newPageId: preparation.page_id },
    };
    return {
      result: envelope(
        {
          ok: true,
          value: {
            kind: "prepared",
            command,
            authorization: {
              roots: {
                [request.input.pageId]: { type: "page", transformation: "preserved" },
              },
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

export const executeNativeNodexAgentPageCopy = async (
  runtime: NativeNodexAgentCore,
  pending: PendingNativePageCopy | undefined,
  command: NodexAgentDuplicatePageCommand,
  signal?: AbortSignal,
): Promise<
  NativeNodexAgentMutationStep<ExecuteNodexAgentDuplicatePageResult, PendingNativePageCopy>
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
          message: "Native Agent Page copy has no matching preparation",
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
          message: "Native Agent Page copy lost its frozen Turn authority",
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
          kind: "execute_prepared_agent_page_copy",
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
    const result = committed.outcome.agent_page_copy;
    if (!result) throw new Error("Core Agent Page copy commit omitted its result");
    return {
      result: {
        ok: true,
        value: {
          output: output(result, pending.request.input.return?.includes("block_map") ?? false),
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
