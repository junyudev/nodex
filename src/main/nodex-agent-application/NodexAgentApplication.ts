import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type {
  DocumentMutationRequest,
  DocumentOperationCommandResult,
} from "../../shared/block-documents/document-operations";
import type {
  CompleteNodexAgentPageUpdateRequest,
  CompleteNodexAgentPageUpdateResult,
  ExecuteNodexAgentCreatePagesResult,
  ExecuteNodexAgentDuplicatePageResult,
  ExecuteNodexAgentMovePagesResult,
  NodexAgentCreatePagesCommand,
  NodexAgentDocumentHead,
  NodexAgentDuplicatePageCommand,
  NodexAgentMovePagesCommand,
  NodexAgentV3ReadCommandResult,
  NodexAgentV3ReadRequest,
  PrepareNodexAgentCreatePagesRequest,
  PrepareNodexAgentCreatePagesResult,
  PrepareNodexAgentDuplicatePageRequest,
  PrepareNodexAgentDuplicatePageResult,
  PrepareNodexAgentMovePagesRequest,
  PrepareNodexAgentMovePagesResult,
  PrepareNodexAgentPageUpdateRequest,
  PrepareNodexAgentPageUpdateResult,
} from "../../shared/nodex-agent-tools";
import { GetContextV3OutputSchema } from "../../shared/nodex-agent-tools/v3-read-schemas";
import { NESTED_MARKDOWN_AGENT_GUIDE } from "../../shared/nfm/agent-guide";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import type { NativeNodexAgentCore } from "../core-client/native-nodex-agent-core";
import { readNativeFetch } from "../core-client/native-nodex-agent-fetch";
import type {
  NativeNodexAgentMutationTransition,
  NodexAgentMutationEnvelope,
} from "../core-client/native-nodex-agent-mutation-step";
import {
  executeNativeNodexAgentPageCopy,
  nativeNodexAgentPageCopyOperationId,
  prepareNativeNodexAgentPageCopy,
  type PendingNativePageCopy,
} from "../core-client/native-nodex-agent-page-copy";
import {
  executeNativeNodexAgentPageCreate,
  nativeNodexAgentPageCreateOperationId,
  prepareNativeNodexAgentPageCreate,
  type PendingNativePageCreate,
} from "../core-client/native-nodex-agent-page-create";
import {
  executeNativeNodexAgentPageMove,
  nativeNodexAgentPageMoveOperationId,
  prepareNativeNodexAgentPageMove,
  type PendingNativePageMove,
} from "../core-client/native-nodex-agent-page-move";
import {
  applyNativeNodexAgentPageUpdate,
  completeNativeNodexAgentPageUpdate,
  nativeNodexAgentPageUpdateOperationId,
  prepareNativeNodexAgentPageUpdate,
  type PendingNativePageUpdate,
} from "../core-client/native-nodex-agent-page-update";
import { readNativeDatabaseQuery } from "../core-client/native-nodex-agent-query";
import { readNativeSearch } from "../core-client/native-nodex-agent-search";
import { DatabaseModule } from "../database-application/DatabaseModule";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import type { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { DatabaseModuleError } from "../database-application/DatabaseModule";
import type {
  CoreMinimumCommitTimeout,
  CoreStoreEpochMismatch,
} from "../core-runtime/CoreMinimumCommit";

export class NodexAgentApplicationError extends Schema.TaggedError<NodexAgentApplicationError>()(
  "NodexAgentApplicationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export type NodexAgentApplicationFailure =
  | CoreMinimumCommitTimeout
  | CoreRuntimeError
  | CoreStoreEpochMismatch
  | DatabaseModuleError
  | NodexAgentApplicationError;

type NodexAgentEffect<A> = Effect.Effect<A, NodexAgentApplicationFailure>;

export type NodexAgentPreparation =
  | { readonly kind: "page_update"; readonly request: PrepareNodexAgentPageUpdateRequest }
  | { readonly kind: "create_pages"; readonly request: PrepareNodexAgentCreatePagesRequest }
  | { readonly kind: "duplicate_page"; readonly request: PrepareNodexAgentDuplicatePageRequest }
  | { readonly kind: "move_pages"; readonly request: PrepareNodexAgentMovePagesRequest };

export type NodexAgentPreparationResult =
  | {
      readonly kind: "page_update";
      readonly value: NodexAgentMutationEnvelope<PrepareNodexAgentPageUpdateResult>;
    }
  | {
      readonly kind: "create_pages";
      readonly value: NodexAgentMutationEnvelope<PrepareNodexAgentCreatePagesResult>;
    }
  | {
      readonly kind: "duplicate_page";
      readonly value: NodexAgentMutationEnvelope<PrepareNodexAgentDuplicatePageResult>;
    }
  | {
      readonly kind: "move_pages";
      readonly value: NodexAgentMutationEnvelope<PrepareNodexAgentMovePagesResult>;
    };

export type NodexAgentApplicationCommand =
  | { readonly kind: "document_mutation"; readonly request: DocumentMutationRequest }
  | {
      readonly kind: "create_pages";
      readonly command: NodexAgentCreatePagesCommand;
      readonly documentHeads: readonly NodexAgentDocumentHead[];
    }
  | { readonly kind: "duplicate_page"; readonly command: NodexAgentDuplicatePageCommand }
  | { readonly kind: "move_pages"; readonly command: NodexAgentMovePagesCommand };

export type NodexAgentApplicationResult =
  | {
      readonly kind: "document_mutation";
      readonly value: DocumentOperationCommandResult;
    }
  | { readonly kind: "create_pages"; readonly value: ExecuteNodexAgentCreatePagesResult }
  | { readonly kind: "duplicate_page"; readonly value: ExecuteNodexAgentDuplicatePageResult }
  | { readonly kind: "move_pages"; readonly value: ExecuteNodexAgentMovePagesResult };

export class NodexAgentApplication extends Context.Service<
  NodexAgentApplication,
  {
    readonly read: (
      request: NodexAgentV3ReadRequest,
    ) => NodexAgentEffect<NodexAgentMutationEnvelope<NodexAgentV3ReadCommandResult>>;
    readonly prepare: (
      preparation: NodexAgentPreparation,
    ) => NodexAgentEffect<NodexAgentPreparationResult>;
    readonly completePageUpdate: (
      request: CompleteNodexAgentPageUpdateRequest,
    ) => NodexAgentEffect<NodexAgentMutationEnvelope<CompleteNodexAgentPageUpdateResult>>;
    readonly apply: (
      command: NodexAgentApplicationCommand,
    ) => NodexAgentEffect<NodexAgentApplicationResult>;
  }
>()("nodex/main/nodex-agent-application/NodexAgentApplication") {}

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

const isNotFound = (error: CoreRuntimeError): boolean =>
  error.cause instanceof CoreModuleResponseError && error.cause.coreError.code === "not_found";

const MAX_PENDING_MUTATIONS = 1_024;

const commitTransition = <Pending extends { readonly operationId: string }>(
  state: Ref.Ref<ReadonlyMap<string, Pending>>,
  transition: NativeNodexAgentMutationTransition<Pending>,
  overflow: "evict_oldest" | "reject",
): Effect.Effect<boolean> =>
  Ref.modify(state, (current) => {
    if (transition.kind === "keep") return [true, current];
    const next = new Map(current);
    if (transition.kind === "clear") {
      next.delete(transition.operationId);
      return [true, next];
    }
    const pending = transition.pending;
    const replacing = next.delete(pending.operationId);
    if (!replacing && next.size >= MAX_PENDING_MUTATIONS) {
      if (overflow === "reject") return [false, current];
      const oldest = next.keys().next().value as string | undefined;
      if (oldest !== undefined) next.delete(oldest);
    }
    next.set(pending.operationId, pending);
    return [true, next];
  });

const capacityFailure = <Result>(operationId: string): NodexAgentMutationEnvelope<Result> =>
  envelope(
    {
      ok: false,
      error: {
        code: "internal_error",
        message: "Native Agent mutation preparation capacity is exhausted",
        retryable: false,
        recovery: "none",
      },
    } as Result,
    operationId,
  );

export const live: Layer.Layer<
  NodexAgentApplication,
  never,
  CoreAuthority | CoreModules | CoreSessionAccess | DatabaseModule
> = Layer.effect(
  NodexAgentApplication,
  Effect.gen(function* () {
    const authority = yield* CoreAuthority;
    const core = yield* CoreModules;
    const database = yield* DatabaseModule;
    const sessions = yield* CoreSessionAccess;
    const pageUpdates = yield* Ref.make<ReadonlyMap<string, PendingNativePageUpdate>>(new Map());
    const pageCopies = yield* Ref.make<ReadonlyMap<string, PendingNativePageCopy>>(new Map());
    const pageCreates = yield* Ref.make<ReadonlyMap<string, PendingNativePageCreate>>(new Map());
    const pageMoves = yield* Ref.make<ReadonlyMap<string, PendingNativePageMove>>(new Map());
    const mutationLanes = yield* RcMap.make({
      lookup: (_mutationId: string) => Semaphore.make(1),
    });
    const closed = yield* Ref.make(false);
    yield* Effect.addFinalizer(() =>
      Ref.set(closed, true).pipe(
        Effect.andThen(Ref.set(pageUpdates, new Map())),
        Effect.andThen(Ref.set(pageCopies, new Map())),
        Effect.andThen(Ref.set(pageCreates, new Map())),
        Effect.andThen(Ref.set(pageMoves, new Map())),
      ),
    );
    const assertOpen = Effect.gen(function* () {
      if (!(yield* Ref.get(closed))) return;
      return yield* new NodexAgentApplicationError({
        operation: "nodexAgent.closed",
        cause: new Error("Nodex Agent application scope is closed"),
      });
    });
    const runtimeFor = (client: CoreGenerationClient): NativeNodexAgentCore => {
      const runtime: NativeNodexAgentCore = {
        identity: authority.identity,
        rootClient: client,
        clientForProject: (projectId) => client.forProject(projectId),
      };
      return runtime;
    };
    const useNative = <A>(
      operation: string,
      run: (runtime: NativeNodexAgentCore, signal: AbortSignal) => Promise<A>,
    ): NodexAgentEffect<A> =>
      assertOpen.pipe(
        Effect.andThen(
          sessions.use(operation, (client, signal) => run(runtimeFor(client), signal)),
        ),
      );
    const evaluate = <A>(operation: string, run: () => A): NodexAgentEffect<A> =>
      Effect.try({
        try: run,
        catch: (cause) => new NodexAgentApplicationError({ operation, cause }),
      });
    const inMutationLane = <A, E, R>(
      mutationId: string,
      operation: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.scoped(
        Effect.gen(function* () {
          const lane = yield* RcMap.get(mutationLanes, mutationId);
          return yield* lane.withPermit(operation);
        }),
      );

    const readContext = (
      request: Extract<NodexAgentV3ReadRequest, { readonly tool: "get_context" }>,
    ): NodexAgentEffect<NodexAgentV3ReadCommandResult> =>
      Effect.gen(function* () {
        if (!request.projectId) {
          return yield* evaluate("nodexAgent.getContext.projectless", () => ({
            ok: true as const,
            tool: request.tool,
            output: GetContextV3OutputSchema.parse({
              data: {
                project: null,
                access: {
                  read: request.access.read,
                  write: request.access.write,
                  domains: request.access.read === "allowed" ? ["page", "database"] : [],
                },
                ...(request.input.include?.markdownGuide
                  ? { markdownGuide: NESTED_MARKDOWN_AGENT_GUIDE }
                  : {}),
              },
            }),
          }));
        }

        const projectId = request.projectId;
        const projectSnapshot = yield* core.workspace
          .read({ kind: "project", project_id: projectId }, undefined, projectId)
          .pipe(
            Effect.catch((error) =>
              isNotFound(error) ? Effect.succeed(null) : Effect.fail(error),
            ),
          );
        if (projectSnapshot === null) {
          return {
            ok: false,
            error: {
              code: "not_found",
              message: `Project ${projectId} was not found`,
              retryable: false,
              recovery: "start_new_task",
            },
          };
        }
        if (projectSnapshot.value.kind !== "project") {
          return yield* new NodexAgentApplicationError({
            operation: "nodexAgent.getContext.project",
            cause: new Error("Core returned the wrong Project Workspace read variant"),
          });
        }
        const project = projectSnapshot.value.project;
        const databaseResult = request.input.include?.databases
          ? yield* database.read({
              projectId,
              read: { target: { kind: "project_default" }, mode: "database" },
            })
          : null;
        if (databaseResult && !databaseResult.ok) {
          return {
            ok: false,
            error: {
              code:
                databaseResult.error.code === "authorization_denied"
                  ? "authorization_denied"
                  : databaseResult.error.code === "resource_not_found"
                    ? "not_found"
                    : "internal_error",
              message: databaseResult.error.message,
              retryable: databaseResult.error.retryable,
              recovery: "none",
              details: { domainCode: databaseResult.error.code },
            },
          };
        }
        if (databaseResult?.ok && databaseResult.value.value.kind !== "database") {
          return {
            ok: false,
            error: {
              code: "internal_error",
              message: "Database Core returned an incompatible Agent context snapshot",
              retryable: false,
              recovery: "none",
              details: { domainCode: "database_descriptor_variant_mismatch" },
            },
          };
        }
        const descriptor =
          databaseResult?.ok && databaseResult.value.value.kind === "database"
            ? databaseResult.value.value.value
            : null;
        const databases = descriptor
          ? [
              {
                databaseId: descriptor.database.databaseId,
                name: descriptor.database.name,
                isBound: descriptor.database.databaseId === project.database_id,
                dataSources: descriptor.dataSources
                  .filter((source) => source.lifecycle === "active")
                  .map((source) => ({
                    dataSourceId: source.dataSourceId,
                    name: source.name,
                    schemaRevision: source.schemaRevision,
                  })),
                views: descriptor.views
                  .filter((view) => view.lifecycle === "active")
                  .map((view) => ({
                    viewId: view.viewId,
                    dataSourceId: view.dataSourceId,
                    name: view.name,
                    layout: view.layout,
                    isDefault: view.isDefault,
                  })),
              },
            ]
          : undefined;

        return yield* evaluate("nodexAgent.getContext.project", () => ({
          ok: true as const,
          tool: request.tool,
          output: GetContextV3OutputSchema.parse({
            data: {
              project: {
                projectId: project.id,
                name: project.name,
                lifecycle: project.lifecycle,
                libraryId: project.library_id,
                boundDatabaseId: project.database_id,
              },
              access: {
                read: request.access.read,
                write: project.lifecycle === "active" ? request.access.write : "unavailable",
                domains: request.access.read === "allowed" ? ["page", "database"] : [],
              },
              ...(databases ? { databases } : {}),
              ...(request.input.include?.markdownGuide
                ? { markdownGuide: NESTED_MARKDOWN_AGENT_GUIDE }
                : {}),
            },
          }),
        }));
      });

    return NodexAgentApplication.of({
      read: (request) =>
        assertOpen.pipe(
          Effect.andThen(
            request.tool === "get_context"
              ? readContext(request)
              : useNative("nodexAgent.read", (runtime, signal) =>
                  request.tool === "fetch"
                    ? readNativeFetch(request, runtime, signal)
                    : request.tool === "search"
                      ? readNativeSearch(request, runtime, signal)
                      : readNativeDatabaseQuery(request, runtime, signal),
                ),
          ),
          Effect.map((result) => envelope(result, request.callId ?? `nodex-agent:${request.tool}`)),
        ),
      prepare: (preparation) => {
        const mutationId =
          preparation.kind === "page_update"
            ? nativeNodexAgentPageUpdateOperationId(preparation.request)
            : preparation.kind === "create_pages"
              ? nativeNodexAgentPageCreateOperationId(preparation.request)
              : preparation.kind === "duplicate_page"
                ? nativeNodexAgentPageCopyOperationId(preparation.request)
                : nativeNodexAgentPageMoveOperationId(preparation.request);
        return inMutationLane(
          mutationId,
          Effect.gen(function* () {
            switch (preparation.kind) {
              case "page_update": {
                const step = yield* useNative("nodexAgent.prepare.pageUpdate", (runtime, signal) =>
                  prepareNativeNodexAgentPageUpdate(runtime, preparation.request, signal),
                );
                yield* commitTransition(pageUpdates, step.transition, "evict_oldest");
                return { kind: preparation.kind, value: step.result } as const;
              }
              case "create_pages": {
                const step = yield* useNative("nodexAgent.prepare.createPages", (runtime, signal) =>
                  prepareNativeNodexAgentPageCreate(runtime, preparation.request, signal),
                );
                const retained = yield* commitTransition(pageCreates, step.transition, "reject");
                return {
                  kind: preparation.kind,
                  value: retained
                    ? step.result
                    : capacityFailure<PrepareNodexAgentCreatePagesResult>(
                        step.result.metrics.mutationId,
                      ),
                } as const;
              }
              case "duplicate_page": {
                const step = yield* useNative(
                  "nodexAgent.prepare.duplicatePage",
                  (runtime, signal) =>
                    prepareNativeNodexAgentPageCopy(runtime, preparation.request, signal),
                );
                const retained = yield* commitTransition(pageCopies, step.transition, "reject");
                return {
                  kind: preparation.kind,
                  value: retained
                    ? step.result
                    : capacityFailure<PrepareNodexAgentDuplicatePageResult>(
                        step.result.metrics.mutationId,
                      ),
                } as const;
              }
              case "move_pages": {
                const step = yield* useNative("nodexAgent.prepare.movePages", (runtime, signal) =>
                  prepareNativeNodexAgentPageMove(runtime, preparation.request, signal),
                );
                const retained = yield* commitTransition(pageMoves, step.transition, "reject");
                return {
                  kind: preparation.kind,
                  value: retained
                    ? step.result
                    : capacityFailure<PrepareNodexAgentMovePagesResult>(
                        step.result.metrics.mutationId,
                      ),
                } as const;
              }
            }
          }),
        );
      },
      completePageUpdate: (request) =>
        inMutationLane(
          request.result.mutationId,
          Effect.gen(function* () {
            const pending = (yield* Ref.get(pageUpdates)).get(request.result.mutationId);
            const step = yield* useNative("nodexAgent.completePageUpdate", (runtime, signal) =>
              completeNativeNodexAgentPageUpdate(runtime, pending, request, signal),
            );
            yield* commitTransition(pageUpdates, step.transition, "evict_oldest");
            return step.result;
          }),
        ),
      apply: (command) => {
        const mutationId =
          command.kind === "document_mutation"
            ? command.request.mutationId
            : command.command.mutationId;
        return inMutationLane(
          mutationId,
          Effect.gen(function* () {
            switch (command.kind) {
              case "document_mutation": {
                const pending = (yield* Ref.get(pageUpdates)).get(command.request.mutationId);
                const step = yield* useNative("nodexAgent.apply.pageUpdate", (runtime, signal) =>
                  applyNativeNodexAgentPageUpdate(runtime, pending, command.request, signal),
                );
                yield* commitTransition(pageUpdates, step.transition, "evict_oldest");
                return { kind: command.kind, value: step.result } as const;
              }
              case "create_pages": {
                const pending = (yield* Ref.get(pageCreates)).get(command.command.mutationId);
                const step = yield* useNative("nodexAgent.apply.createPages", (runtime, signal) =>
                  executeNativeNodexAgentPageCreate(
                    runtime,
                    pending,
                    command.command,
                    command.documentHeads,
                    signal,
                  ),
                );
                yield* commitTransition(pageCreates, step.transition, "reject");
                return { kind: command.kind, value: step.result } as const;
              }
              case "duplicate_page": {
                const pending = (yield* Ref.get(pageCopies)).get(command.command.mutationId);
                const step = yield* useNative("nodexAgent.apply.duplicatePage", (runtime, signal) =>
                  executeNativeNodexAgentPageCopy(runtime, pending, command.command, signal),
                );
                yield* commitTransition(pageCopies, step.transition, "reject");
                return { kind: command.kind, value: step.result } as const;
              }
              case "move_pages": {
                const pending = (yield* Ref.get(pageMoves)).get(command.command.mutationId);
                const step = yield* useNative("nodexAgent.apply.movePages", (runtime, signal) =>
                  executeNativeNodexAgentPageMove(runtime, pending, command.command, signal),
                );
                yield* commitTransition(pageMoves, step.transition, "reject");
                return { kind: command.kind, value: step.result } as const;
              }
            }
          }),
        );
      },
    });
  }),
);
