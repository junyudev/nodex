import type { components } from "@nodex/core-protocol";
import { createHash } from "node:crypto";
import { parseInlineMarkdownTitle } from "../../shared/nfm/agent-title";
import type {
  ExecuteNodexAgentCreatePagesResult,
  NodexAgentCreatePagesCommand,
  NodexAgentDocumentHead,
  PrepareNodexAgentCreatePagesRequest,
  PrepareNodexAgentCreatePagesResult,
} from "../../shared/nodex-agent-tools";
import { CreatePagesV6OutputSchema } from "../../shared/nodex-agent-tools/v6-schemas";
import { CreateInputSchema } from "../../shared/nodex-agent-tools/write-schemas";
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

export type CoreCreateRequest = components["schemas"]["LibraryAgentCreatePagesRequest"];
export type CoreCreateResult = components["schemas"]["LibraryAgentCreatePagesResult"];
export type CoreCreatePreparation = components["schemas"]["LibraryAgentCreatePagesPreparation"];

export interface PendingNativePageCreate {
  readonly request: PrepareNodexAgentCreatePagesRequest;
  readonly operationId: string;
  readonly token: string;
  readonly coreRequest: CoreCreateRequest;
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

export const nativeNodexAgentPageCreateOperationId = (
  request: Pick<PrepareNodexAgentCreatePagesRequest, "threadId" | "callId" | "operationId">,
): string =>
  request.operationId ??
  `nodex-agent-create-pages:${createHash("sha256")
    .update(JSON.stringify([request.threadId, request.callId, "create_pages"]))
    .digest("hex")}`;

const coreRequest = (request: PrepareNodexAgentCreatePagesRequest): CoreCreateRequest => ({
  destination: toCoreAgentPageDestination(request.input.destination, []),
  pages: request.input.pages.map((page) => ({
    title_markdown: page.title,
    nfm: page.markdown ?? "",
    values: (page.values ?? []).map((value) => ({
      property_id: value.propertyId,
      value: value.value,
    })),
  })),
  include_block_ids: request.input.return?.includes("block_ids") ?? false,
  include_etags: request.input.return?.includes("etags") ?? false,
});

const output = (result: CoreCreateResult, request: PrepareNodexAgentCreatePagesRequest) =>
  CreatePagesV6OutputSchema.parse({
    data: {
      pages: result.pages.map((page) => ({
        pageId: page.page_id,
        pageKey: page.page_key ?? null,
        location: nativeAgentPageLocation(page.location),
        bodyBlocksCreated: page.body_blocks_created,
        ...(request.input.return?.includes("block_ids") ? { blockIds: page.block_ids } : {}),
        ...(page.etags ? { etags: { title: page.etags.title, body: page.etags.body } } : {}),
      })),
      created: result.pages.length,
    },
  });

const normalizedDestination = (
  request: PrepareNodexAgentCreatePagesRequest,
  preparation: CoreCreatePreparation,
  pageIndex: number,
) => {
  const destination = request.input.destination;
  if (destination.kind === "library") {
    return { kind: "library" as const, ...(destination.at ? { at: destination.at } : {}) };
  }
  if (destination.kind === "page") {
    const target = preparation.destination_document;
    if (!target) {
      throw new Error("Core Agent Page creation omitted its target Document");
    }
    return {
      kind: "document" as const,
      documentId: target.document_id,
      at: destination.at ?? { kind: "end" as const },
    };
  }
  const databaseId = preparation.destination_database_id;
  if (!databaseId) {
    throw new Error("Core Agent Page creation omitted its target Database");
  }
  const page = request.input.pages[pageIndex];
  if (!page) throw new Error(`Core Agent Page draft ${pageIndex} is unavailable`);
  return {
    kind: "data_source" as const,
    dataSourceId: destination.dataSourceId,
    ...(page.values ? { values: page.values } : {}),
    ...(destination.view ? { view: destination.view } : {}),
  };
};

const command = (
  request: PrepareNodexAgentCreatePagesRequest,
  operationId: string,
  preparation: CoreCreatePreparation,
): NodexAgentCreatePagesCommand => {
  if (!request.authority) {
    throw new Error("Native Agent Page creation requires frozen Turn authority");
  }
  if (preparation.pages.length !== request.input.pages.length) {
    throw new Error("Core Agent Page creation returned a divergent Page batch");
  }
  const destination = preparedAgentPageDestination(preparation);
  return {
    ...request,
    requestHash: operationId,
    mutationId: operationId,
    storeEpoch: request.authority.storeEpoch,
    input: request.input,
    destination,
    pages: preparation.pages.map((page, index) => {
      const draft = request.input.pages[index];
      if (!draft) throw new Error(`Agent Page draft ${index} is unavailable`);
      return {
        input: CreateInputSchema.parse({
          resource: {
            kind: "page",
            title: {
              kind: "rich",
              richText: [...parseInlineMarkdownTitle(draft.title)],
            },
            ...(draft.markdown !== undefined
              ? { body: { format: "nfm", content: draft.markdown } }
              : {}),
          },
          destination: normalizedDestination(request, preparation, index),
          ...(request.input.return
            ? {
                return: {
                  ...(request.input.return.includes("block_ids") ? { blockIds: true } : {}),
                  ...(request.input.return.includes("etags") ? { etags: true } : {}),
                },
              }
            : {}),
        }),
        pageId: page.page_id,
        bodyBlockIds: [...page.body_block_ids],
        primaryMembershipId: page.primary_membership_id,
        targetMembershipId: page.target_membership_id,
      };
    }),
  };
};

export const prepareNativeNodexAgentPageCreate = async (
  runtime: NativeNodexAgentCore,
  request: PrepareNodexAgentCreatePagesRequest,
  signal?: AbortSignal,
): Promise<
  NativeNodexAgentMutationStep<
    NodexAgentMutationEnvelope<PrepareNodexAgentCreatePagesResult>,
    PendingNativePageCreate
  >
> => {
  const operationId = nativeNodexAgentPageCreateOperationId(request);
  try {
    if (!request.authority) {
      throw new Error("Native Agent Page creation requires frozen Turn authority");
    }
    const createRequest = coreRequest(request);
    const snapshot = await nativeAgentClient(runtime, request.projectId).libraryRead(
      {
        kind: "prepare_agent_create_pages",
        operation_id: operationId,
        store_epoch: request.authority.storeEpoch,
        authorization: toCoreAgentExecutionAuthorization(
          runtime.identity.profileId,
          request.authority,
          request.callId,
          request.resourceAccess,
        ),
        request: createRequest,
      },
      { class: "background", signal },
    );
    if (snapshot.value.kind !== "agent_create_pages_preparation") {
      throw new Error("Core returned the wrong Agent Page-create preparation variant");
    }
    const preparation = snapshot.value.value;
    if (preparation.preparation.state === "committed_replay") {
      const committed = preparation.committed?.outcome.agent_create_pages;
      if (!committed) throw new Error("Core Agent Page-create replay omitted its result");
      return {
        result: envelope(
          {
            ok: true,
            value: { kind: "completed", output: output(committed, request) },
          },
          operationId,
        ),
        transition: { kind: "clear", operationId },
      };
    }
    const token = preparation.preparation.token;
    if (!token) throw new Error("Core Agent Page-create preparation omitted its token");
    const documentHeads = nativeAgentDocumentHeads(preparation.document_heads);
    const pending: PendingNativePageCreate = {
      request,
      operationId,
      token,
      coreRequest: createRequest,
      documentHeads,
    };
    return {
      result: envelope(
        {
          ok: true,
          value: {
            kind: "prepared",
            command: command(request, operationId, preparation),
            documentHeads,
            previews: preparation.pages.map((page, index) => {
              const draft = request.input.pages[index];
              if (!draft) throw new Error(`Agent Page draft ${index} is unavailable`);
              return {
                pageId: page.page_id,
                title: draft.title,
                bodyBlockCount: page.body_block_ids.length,
                targetMarkdown: draft.markdown ?? "",
              };
            }),
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

export const executeNativeNodexAgentPageCreate = async (
  runtime: NativeNodexAgentCore,
  pending: PendingNativePageCreate | undefined,
  command: NodexAgentCreatePagesCommand,
  documentHeads: readonly NodexAgentDocumentHead[],
  signal?: AbortSignal,
): Promise<
  NativeNodexAgentMutationStep<ExecuteNodexAgentCreatePagesResult, PendingNativePageCreate>
> => {
  if (
    !pending ||
    pending.request.projectId !== command.projectId ||
    pending.request.callId !== command.callId ||
    pending.request.threadId !== command.threadId ||
    pending.request.authority?.storeEpoch !== command.storeEpoch ||
    !hasExactNativeAgentDocumentHeads(pending.documentHeads, documentHeads)
  ) {
    return {
      result: {
        ok: false,
        error: {
          code: "idempotency_collision",
          message: "Native Agent Page creation has no matching preparation",
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
          message: "Native Agent Page creation lost its frozen Turn authority",
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
          kind: "execute_prepared_agent_create_pages",
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
    const result = committed.outcome.agent_create_pages;
    if (!result) throw new Error("Core Agent Page-create commit omitted its result");
    return {
      result: {
        ok: true,
        value: {
          output: output(result, pending.request),
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
