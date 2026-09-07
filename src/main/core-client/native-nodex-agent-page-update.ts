import type { components } from "@nodex/core-protocol";
import { createHash } from "node:crypto";
import {
  type NodexAgentPreparedPageUpdate,
  type NodexAgentPageUpdateCommit,
  type NodexAgentPageUpdateCommandResult,
  type CompleteNodexAgentPageUpdateRequest,
  type CompleteNodexAgentPageUpdateResult,
  type PrepareNodexAgentPageUpdateRequest,
  type PrepareNodexAgentPageUpdateResult,
} from "../../shared/nodex-agent-tools/v3-write-runtime";
import type { AgentDocumentEditEffects } from "../../shared/nodex-agent-tools/document-edit-compiler";
import type { NewBlockDraftInput } from "../../shared/nodex-agent-tools/write-schemas";
import type { ToolFailure } from "../../shared/nodex-agent-tools/base-schemas";
import { UpdatePageV3OutputSchema } from "../../shared/nodex-agent-tools/v3-write-schemas";
import {
  AgentDocumentEditCompilerError,
  applyExactNfmPatches,
} from "../../shared/nodex-agent-tools/exact-nfm-patches";
import { CoreModuleResponseError } from "./core-client";
import { nativeAgentClient, type NativeNodexAgentCore } from "./native-nodex-agent-core";
import { toCoreAgentExecutionAuthorization } from "./core-agent-execution-authorization";
import type {
  NativeNodexAgentMutationStep,
  NodexAgentMutationEnvelope,
} from "./native-nodex-agent-mutation-step";
import {
  applyResultCursor,
  applyResultStoreEpoch,
  rendererLocalCommitApply,
  type LibraryReadSnapshot,
  type OwnedDocumentApplyResult,
} from "./types";

export type CoreAgentMutation = components["schemas"]["AgentDocumentSemanticMutation"];
export type CoreAgentPreparation = components["schemas"]["AgentOperationPreparation"];
export type CoreCommittedDocument = OwnedDocumentApplyResult;
type ToolError = ToolFailure["error"];
type CorePageContent = Extract<
  LibraryReadSnapshot["value"],
  { readonly kind: "page_content" }
>["value"];

export interface PendingNativePageUpdate {
  readonly request: PrepareNodexAgentPageUpdateRequest;
  readonly operationId: string;
  readonly clientSessionId: string;
  readonly mutation: CoreAgentMutation;
  readonly token: string;
  committed?: CoreCommittedDocument;
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

export const mapNativeNodexAgentCoreError = (error: unknown): ToolError => {
  if (!(error instanceof CoreModuleResponseError)) {
    return {
      code: "internal_error",
      message: error instanceof Error ? error.message : "Native Agent Page update failed",
      retryable: false,
      recovery: "none",
    };
  }
  const code = error.coreError.code;
  if (code === "not_found") {
    return {
      code: "not_found",
      message: error.coreError.message,
      retryable: false,
      recovery: "none",
      details: { domainCode: code },
    };
  }
  if (code === "idempotency_key_reused") {
    return {
      code: "idempotency_collision",
      message: error.coreError.message,
      retryable: false,
      recovery: "none",
      details: { domainCode: code },
    };
  }
  if (code === "protected_owner_deletion") {
    return {
      code: "protected_owner_deletion",
      message: error.coreError.message,
      retryable: false,
      recovery: "none",
      details: { domainCode: code },
    };
  }
  if (
    code === "revision_conflict" ||
    code === "stale_store_epoch" ||
    code === "generation_conflict" ||
    code === "head_conflict"
  ) {
    return {
      code: "conflict",
      message: error.coreError.message,
      retryable: error.coreError.retryable,
      recovery: "fetch_again",
      details: { domainCode: code },
    };
  }
  if (code === "unauthorized") {
    return {
      code: "authorization_denied",
      message: error.coreError.message,
      retryable: false,
      recovery: "start_new_task",
      details: { domainCode: code },
    };
  }
  return {
    code: code === "invalid_input" ? "invalid_arguments" : "internal_error",
    message: error.coreError.message,
    retryable: error.coreError.retryable,
    recovery: error.coreError.retryable ? "retry_same" : "none",
    details: { domainCode: code },
  };
};

export const nativeNodexAgentPageUpdateOperationId = (
  request: Pick<PrepareNodexAgentPageUpdateRequest, "threadId" | "callId" | "operationId" | "tool">,
): string =>
  request.operationId ??
  `nodex-agent-edit:${createHash("sha256")
    .update(JSON.stringify([request.threadId, request.callId, request.tool]))
    .digest("hex")}`;

const emptyEffects = (): AgentDocumentEditEffects => ({
  createdBlockIds: [],
  localBlockIds: {},
  copiedBlockIds: {},
  updatedBlockIds: [],
  movedBlockIds: [],
  deletedBlockIds: [],
  deletedOwnerBlockIds: [],
  titleChanged: false,
});

const effectsFromPreparation = (
  pageId: string,
  preparation: CoreAgentPreparation,
  titleChanged: boolean,
): AgentDocumentEditEffects => {
  const moved = new Set(
    preparation.footprint.ownership_transformations.map((item) => item.resource_id),
  );
  const deleted = new Set(preparation.footprint.deleted_roots);
  return {
    ...emptyEffects(),
    createdBlockIds: [...preparation.footprint.created_roots],
    updatedBlockIds: preparation.footprint.updated_roots.filter(
      (id) => id !== pageId && !moved.has(id) && !deleted.has(id),
    ),
    movedBlockIds: [...moved],
    deletedBlockIds: [...deleted],
    deletedOwnerBlockIds: [...preparation.footprint.deleted_owner_roots],
    titleChanged,
  };
};

const semanticAnchor = (
  anchor:
    | {
        readonly kind: "start";
        readonly parentBlockId?: string;
      }
    | {
        readonly kind: "end";
        readonly parentBlockId?: string;
      }
    | {
        readonly kind: "before";
        readonly blockId: string;
      }
    | {
        readonly kind: "after";
        readonly blockId: string;
      },
): components["schemas"]["DocumentSemanticAnchor"] => {
  if (anchor.kind === "start" || anchor.kind === "end") {
    return {
      kind: anchor.kind,
      parent_block_id: anchor.parentBlockId ?? null,
    };
  }
  return {
    kind: anchor.kind,
    block_id: anchor.blockId,
  };
};

const semanticBlockDraft = (
  block: NewBlockDraftInput,
): components["schemas"]["DocumentSemanticBlockDraft"] => ({
  local_id: block.localId,
  block_type: block.type,
  props: block.props ?? {},
  content:
    block.content === undefined ? { kind: "absent" } : { kind: "value", value: block.content },
  children: (block.children ?? []).map(semanticBlockDraft),
});

const effectFromCommit = (
  committed: CoreCommittedDocument,
): NonNullable<CoreCommittedDocument["outcome"]["mutation_effect"]> | null =>
  committed.outcome.mutation_effect ?? null;

const toNodexAgentPageUpdateCommit = (
  pending: PendingNativePageUpdate,
  committed: CoreCommittedDocument,
): NodexAgentPageUpdateCommit => {
  const effect = effectFromCommit(committed);
  const committedAt = committed.outcome.committed_at;
  if (!committedAt) {
    throw new Error("Core Agent Page update omitted its commit timestamp");
  }
  return {
    mutationKind:
      pending.request.tool === "update_page" &&
      (pending.request.input.body?.kind === "replace" ||
        pending.request.input.body?.kind === "patch")
        ? "replace_document_from_nfm"
        : "document_operation_batch",
    mutationId: pending.operationId,
    projectId: pending.request.projectId,
    storeEpoch: applyResultStoreEpoch(committed),
    documentId: committed.outcome.document_id,
    generation: committed.outcome.generation,
    baseHeadSeq: effect?.base_head_seq ?? committed.outcome.head_seq,
    headSeq: committed.outcome.head_seq,
    touchedBlockIds: effect?.touched_block_ids ?? [],
    createdBlockIds: effect?.created_block_ids ?? [],
    deletedBlockIds: effect?.deleted_block_ids ?? [],
    updatedBlockIds: effect?.updated_block_ids ?? [],
    movedBlockIds: effect?.moved_block_ids ?? [],
    writeFenceBlockIds: effect?.write_fence_block_ids ?? [],
    titleChanged: effect?.title_changed ?? false,
    coordination: effect?.coordination ?? "merge_friendly",
    commitSeq: applyResultCursor(committed),
    committedAt,
    duplicate: committed.receipt.duplicate,
  };
};

const mutationCommands = (
  request: PrepareNodexAgentPageUpdateRequest,
): CoreAgentMutation["commands"] | ToolError => {
  if (request.tool === "advanced_update_page") {
    return request.input.edits.map((edit): CoreAgentMutation["commands"][number] => {
      if (edit.kind === "insert") {
        return {
          kind: "insert_block",
          anchor: semanticAnchor(edit.at),
          block: semanticBlockDraft(edit.block),
        };
      }
      if (edit.kind === "update") {
        return {
          kind: "update_block",
          block_id: edit.blockId,
          expected_etag: edit.ifMatch,
          patch: {
            ...(edit.patch.type === undefined ? {} : { block_type: edit.patch.type }),
            ...(edit.patch.props === undefined ? {} : { props: edit.patch.props }),
            content:
              edit.patch.content === undefined
                ? { kind: "absent" }
                : { kind: "value", value: edit.patch.content },
            unset_content: edit.patch.unsetContent === true,
          },
        };
      }
      if (edit.kind === "delete") {
        return {
          kind: "delete_block",
          block_id: edit.blockId,
          expected_etag: edit.ifMatch,
        };
      }
      return {
        kind: "move_block",
        block_id: edit.blockId,
        anchor: semanticAnchor(edit.at),
      };
    });
  }
  const body = request.input.body;
  return [
    ...(request.input.title
      ? [
          {
            kind: "set_title" as const,
            inline_markdown: request.input.title.markdown,
            expected_etag: request.input.title.ifMatch,
          },
        ]
      : []),
    ...(body?.kind === "patch"
      ? body.patches.map((patch) => ({
          kind: "patch_body" as const,
          old_fragment: patch.oldMarkdown,
          new_fragment: patch.newMarkdown,
          expected_matches: patch.expectedMatches ?? null,
          expected_etag: body.ifMatch ?? null,
        }))
      : body?.kind === "replace"
        ? [
            {
              kind: "replace_body" as const,
              nested_markdown: body.markdown,
              expected_etag: body.ifMatch,
            },
          ]
        : body?.kind === "insert"
          ? [
              {
                kind: "insert_body" as const,
                anchor: semanticAnchor(body.at),
                nested_markdown: body.markdown,
              },
            ]
          : []),
  ];
};

const isToolError = (value: CoreAgentMutation["commands"] | ToolError): value is ToolError =>
  !Array.isArray(value);

const projectNativeNodexAgentPageUpdateOutput = (
  request: PrepareNodexAgentPageUpdateRequest,
  committed: CoreCommittedDocument,
  content: CorePageContent | null,
) => {
  const effect = effectFromCommit(committed);
  const wantsBlockIds = request.input.return?.includes("block_ids") ?? false;
  const wantsEtags = request.input.return?.includes("etags") ?? false;
  const semanticEtags = committed.outcome.semantic_etags;
  const semanticLocalBlockIds = committed.outcome.semantic_local_block_ids ?? {};
  if (wantsEtags && !semanticEtags) {
    throw new Error("Core Agent Page update omitted its semantic ETags");
  }
  const exactContent =
    content?.document_generation === committed.outcome.generation &&
    content.document_head_seq === committed.outcome.head_seq
      ? content
      : null;
  const created = effect?.created_block_ids ?? [];
  const updated = effect?.updated_block_ids ?? [];
  const moved = effect?.moved_block_ids ?? [];
  const deleted = effect?.deleted_block_ids ?? [];
  return UpdatePageV3OutputSchema.parse({
    data: {
      pageId: request.input.pageId,
      effects: {
        created: created.length,
        updated: updated.length,
        moved: moved.length,
        deleted: deleted.length,
        ...(wantsBlockIds
          ? {
              blockIds: {
                created,
                local: semanticLocalBlockIds,
                copied: {},
                updated,
                moved,
                deleted,
              },
            }
          : {}),
      },
      ...(wantsEtags && semanticEtags
        ? { etags: { title: semanticEtags.title, body: semanticEtags.body } }
        : {}),
      ...(exactContent
        ? {
            body: {
              format: "markdown",
              markdown: exactContent.body_nfm,
              contentHash: createHash("sha256").update(exactContent.body_nfm).digest("hex"),
            },
          }
        : {}),
    },
  });
};

const readNativeNodexAgentPageUpdateOutput = async (
  runtime: NativeNodexAgentCore,
  request: PrepareNodexAgentPageUpdateRequest,
  committed: CoreCommittedDocument,
  signal?: AbortSignal,
) => {
  const wantsMarkdown = request.input.return?.includes("markdown") ?? false;
  const contentSnapshot = wantsMarkdown
    ? await runtime.rootClient.libraryRead(
        { kind: "page_content", page_id: request.input.pageId },
        { class: "background", signal },
      )
    : null;
  const content =
    contentSnapshot?.value.kind === "page_content" ? contentSnapshot.value.value : null;
  return projectNativeNodexAgentPageUpdateOutput(request, committed, content);
};

export const prepareNativeNodexAgentPageUpdate = async (
  runtime: NativeNodexAgentCore,
  request: PrepareNodexAgentPageUpdateRequest,
  signal?: AbortSignal,
): Promise<
  NativeNodexAgentMutationStep<
    NodexAgentMutationEnvelope<PrepareNodexAgentPageUpdateResult>,
    PendingNativePageUpdate
  >
> => {
  const operationId = nativeNodexAgentPageUpdateOperationId(request);
  try {
    if (!request.authority) {
      return {
        result: envelope(
          {
            ok: false,
            error: {
              code: "authorization_denied",
              message: "Native Agent Page updates require exact Turn authority",
              retryable: false,
              recovery: "start_new_task",
            },
          },
          operationId,
        ),
        transition: { kind: "keep" },
      };
    }
    const commands = mutationCommands(request);
    if (isToolError(commands)) {
      return {
        result: envelope({ ok: false, error: commands }, operationId),
        transition: { kind: "keep" },
      };
    }
    const contentSnapshot = await runtime.rootClient.libraryRead(
      { kind: "page_content", page_id: request.input.pageId },
      { class: "background", signal },
    );
    if (contentSnapshot.value.kind !== "page_content") {
      throw new Error("Core returned the wrong Agent Page content variant");
    }
    const content = contentSnapshot.value.value;
    const targetMarkdown =
      request.tool === "update_page" && request.input.body?.kind === "patch"
        ? applyExactNfmPatches(
            content.body_nfm,
            request.input.body.patches.map((patch) => ({
              oldNfm: patch.oldMarkdown,
              newNfm: patch.newMarkdown,
              ...(patch.expectedMatches !== undefined
                ? { expectedMatches: patch.expectedMatches }
                : {}),
            })),
          )
        : request.tool === "update_page" && request.input.body?.kind === "replace"
          ? request.input.body.markdown
          : content.body_nfm;
    const mutation: CoreAgentMutation = {
      document_id: content.document_id,
      generation: content.document_generation,
      expected_head_seq: content.document_head_seq,
      commands,
    };
    const clientSessionId = `nodex-agent:${request.threadId}`.slice(0, 512);
    const snapshot = await nativeAgentClient(runtime, request.projectId).documentRead(
      clientSessionId,
      {
        kind: "prepare_agent_semantic_mutation",
        operation_id: operationId,
        store_epoch: request.authority.storeEpoch,
        authorization: toCoreAgentExecutionAuthorization(
          runtime.identity.profileId,
          request.authority,
          request.callId,
          request.resourceAccess,
        ),
        mutation,
      },
      { class: "background", signal },
    );
    if (snapshot.value.kind !== "agent_semantic_mutation_preparation") {
      throw new Error("Core returned the wrong Agent Page update preparation variant");
    }
    if (snapshot.value.preparation.state === "committed_replay") {
      if (!snapshot.value.committed) {
        throw new Error("Core Agent replay omitted its committed result");
      }
      const output = await readNativeNodexAgentPageUpdateOutput(
        runtime,
        request,
        snapshot.value.committed,
        signal,
      );
      return {
        result: envelope({ ok: true, value: { kind: "completed", output } }, operationId),
        transition: { kind: "clear", operationId },
      };
    }
    const token = snapshot.value.preparation.token;
    if (!token) throw new Error("Core Agent preparation omitted its execution token");
    const pending: PendingNativePageUpdate = {
      request,
      operationId,
      clientSessionId,
      mutation,
      token,
    };
    const preparedCommand: NodexAgentPreparedPageUpdate = {
      mutationId: operationId,
      projectId: request.projectId,
      storeEpoch: request.authority.storeEpoch,
      clientSessionId,
      threadId: request.threadId,
      callId: request.callId,
      documentId: content.document_id,
      generation: content.document_generation,
      expectedHeadSeq: content.document_head_seq,
    };
    return {
      result: envelope(
        {
          ok: true,
          value: {
            kind: "prepared",
            mutation: preparedCommand,
            effects: effectsFromPreparation(
              request.input.pageId,
              snapshot.value.preparation,
              request.tool === "update_page" && request.input.title !== undefined,
            ),
            targetMarkdown: snapshot.value.preparation.preview_markdown ?? targetMarkdown,
            ...(request.resourceAccess ? { resourceAccess: request.resourceAccess } : {}),
          },
        },
        operationId,
      ),
      transition: { kind: "retain", pending },
    };
  } catch (error) {
    const mapped =
      error instanceof AgentDocumentEditCompilerError
        ? {
            code: error.code,
            message: error.message,
            retryable: false,
            recovery:
              error.code === "nfm_patch_mismatch" || error.code === "nfm_patch_overlap"
                ? ("fetch_again" as const)
                : ("none" as const),
          }
        : mapNativeNodexAgentCoreError(error);
    return {
      result: envelope({ ok: false, error: mapped }, operationId),
      transition: { kind: "keep" },
    };
  }
};

export const applyNativeNodexAgentPageUpdate = async (
  runtime: NativeNodexAgentCore,
  pending: PendingNativePageUpdate | undefined,
  request: NodexAgentPreparedPageUpdate,
  signal?: AbortSignal,
): Promise<
  NativeNodexAgentMutationStep<NodexAgentPageUpdateCommandResult, PendingNativePageUpdate>
> => {
  const authority = pending?.request.authority;
  const matchesPreparation =
    pending &&
    authority &&
    request.projectId === pending.request.projectId &&
    request.storeEpoch === authority.storeEpoch &&
    request.clientSessionId === pending.clientSessionId &&
    request.documentId === pending.mutation.document_id &&
    request.generation === pending.mutation.generation &&
    request.expectedHeadSeq === pending.mutation.expected_head_seq &&
    request.mutationId === pending.operationId &&
    request.threadId === pending.request.threadId &&
    request.callId === pending.request.callId;
  if (!matchesPreparation) {
    return {
      result: {
        ok: false,
        error: {
          code: "mutation_id_collision",
          message: "Native Agent Page update has no matching preparation",
          retryable: false,
          mutationId: request.mutationId,
        },
      },
      transition: { kind: "keep" },
    };
  }
  try {
    const committed = await nativeAgentClient(runtime, pending.request.projectId).documentApply(
      {
        operationId: pending.operationId,
        clientSessionId: pending.clientSessionId,
        intent: {
          kind: "execute_prepared_agent_semantic_mutation",
          authorization: {
            authorization: toCoreAgentExecutionAuthorization(
              runtime.identity.profileId,
              authority,
              pending.request.callId,
              pending.request.resourceAccess,
            ),
            token: pending.token,
          },
          mutation: pending.mutation,
        },
      },
      { class: "background", signal },
    );
    const retained = { ...pending, committed };
    return {
      result: {
        ok: true,
        value: toNodexAgentPageUpdateCommit(retained, committed),
        localCommit: rendererLocalCommitApply(committed),
      },
      transition: { kind: "retain", pending: retained },
    };
  } catch (error) {
    const mapped = mapNativeNodexAgentCoreError(error);
    return {
      result: {
        ok: false,
        error: {
          code:
            mapped.code === "conflict"
              ? "document_head_conflict"
              : mapped.code === "not_found"
                ? "document_not_found"
                : "unknown",
          message: mapped.message,
          retryable: mapped.retryable,
          mutationId: pending.operationId,
        },
      },
      transition: { kind: "clear", operationId: pending.operationId },
    };
  }
};

export const completeNativeNodexAgentPageUpdate = async (
  runtime: NativeNodexAgentCore,
  pending: PendingNativePageUpdate | undefined,
  request: CompleteNodexAgentPageUpdateRequest,
  signal?: AbortSignal,
): Promise<
  NativeNodexAgentMutationStep<
    NodexAgentMutationEnvelope<CompleteNodexAgentPageUpdateResult>,
    PendingNativePageUpdate
  >
> => {
  const operationId = nativeNodexAgentPageUpdateOperationId(request);
  const committed = pending?.committed;
  const matchesCommit =
    pending &&
    committed &&
    request.projectId === pending.request.projectId &&
    request.pageId === pending.request.input.pageId &&
    request.result.mutationId === operationId &&
    request.result.projectId === pending.request.projectId &&
    request.result.storeEpoch === applyResultStoreEpoch(committed) &&
    request.result.documentId === committed.outcome.document_id &&
    request.result.generation === committed.outcome.generation &&
    request.result.headSeq === committed.outcome.head_seq;
  if (!matchesCommit) {
    return {
      result: envelope(
        {
          ok: false,
          error: {
            code: "idempotency_collision",
            message: "Native Agent Page update has no matching committed preparation",
            retryable: false,
            recovery: "retry_same",
          },
        },
        operationId,
      ),
      transition: { kind: "keep" },
    };
  }
  try {
    const output = await readNativeNodexAgentPageUpdateOutput(
      runtime,
      pending.request,
      committed,
      signal,
    );
    return {
      result: envelope({ ok: true, output }, operationId),
      transition: { kind: "clear", operationId },
    };
  } catch (error) {
    return {
      result: envelope({ ok: false, error: mapNativeNodexAgentCoreError(error) }, operationId),
      transition: { kind: "keep" },
    };
  }
};
