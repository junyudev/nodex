import { randomUuidV4 } from "@nodex/provider-core/server/randomUuid";
import {
  EventId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
} from "@nodex/runtime-contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import {
  addRuntimeChatGrant,
  RuntimeApprovals,
  type RuntimeApprovalRequest,
} from "./RuntimeApprovals.ts";
import { ThreadCommandExecutor } from "./ThreadCommandExecutor.ts";

const defaultOptions: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Approve once" },
  { decision: "decline", label: "Decline" },
  { decision: "cancel", label: "Decline and stop" },
];

/** The outbox delivers the decision from the committed request to its process-local waiter. */
export class RuntimeApprovalDelivery extends Context.Service<
  RuntimeApprovalDelivery,
  {
    readonly deliver: (
      id: RuntimeRequestId,
      decision: ProviderApprovalDecision,
    ) => Effect.Effect<void>;
  }
>()("nodex/agent-runtime/orchestration-v2/RuntimeApprovalDelivery") {}

function endsApproval(
  event: OrchestrationV2DomainEvent,
  input: RuntimeApprovalRequest,
  id: RuntimeRequestId,
  runOrdinal: number,
  modeRevision: EventId | undefined,
): boolean {
  switch (event.type) {
    case "thread.archived":
    case "thread.deleted":
      return true;
    case "thread.metadata-updated":
    case "thread.runtime-mode-updated":
      return (
        (event.type === "thread.metadata-updated" &&
          (event.payload.executionStoppedThroughOrdinal ?? 0) >= runOrdinal) ||
        (input.chatGrant !== undefined &&
          event.payload.runtimeChatGrants?.modeRevision !== modeRevision)
      );
    case "run.created":
    case "run.updated":
      return event.payload.id === input.runId
        ? event.payload.status !== "running" || event.payload.activeAttemptId !== input.attemptId
        : event.payload.status === "running" && event.payload.ordinal > runOrdinal;
    case "run-attempt.updated":
      return event.payload.id === input.attemptId && event.payload.status !== "running";
    case "run.execution-retired":
      return (
        event.payload.runId === input.runId &&
        (event.payload.attemptId === null || event.payload.attemptId === input.attemptId)
      );
    case "turn-item.updated":
      return event.payload.runId === input.runId && event.payload.type === "run_interrupt_request";
    case "runtime-request.updated":
      return (
        event.payload.id === id &&
        (event.payload.status === "cancelled" || event.payload.status === "expired")
      );
    default:
      return false;
  }
}

const waitForAbort = (signal: AbortSignal | undefined): Effect.Effect<void> =>
  signal === undefined
    ? Effect.never
    : Effect.callback((resume) => {
        if (signal.aborted) return resume(Effect.void);
        const abort = () => resume(Effect.void);
        signal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      });

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const events = yield* EventSinkV2;
    const projections = yield* ProjectionStoreV2;
    const commands = yield* ThreadCommandExecutor;
    const waiters = new Map<RuntimeRequestId, Deferred.Deferred<ProviderApprovalDecision>>();
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        yield* Effect.forEach(waiters.values(), (waiter) => Deferred.succeed(waiter, "cancel"), {
          discard: true,
        });
      }),
    );

    const ask: RuntimeApprovals["Service"]["ask"] = (input) =>
      Effect.gen(function* () {
        const options = input.options ?? defaultOptions;
        if (closed || input.signal?.aborted || options.length === 0) return "cancel" as const;

        const key = `runtime-approval:${yield* randomUuidV4}`;
        const id = RuntimeRequestId.make(key);
        const nodeId = NodeId.make(key);
        const itemId = TurnItemId.make(key);
        const deferred = yield* Deferred.make<ProviderApprovalDecision>();
        const { threadId, runId, attemptId } = input;

        const open = Effect.gen(function* () {
          const { attempts, runs, thread } = yield* projections.getThreadRecords(
            threadId,
            ["attempts", "runs"],
            { attemptIds: [attemptId], runIds: [runId] },
          );
          const [attempt] = attempts;
          const [run] = runs;
          if (
            closed ||
            run === undefined ||
            attempt?.runId !== runId ||
            attempt.status !== "running" ||
            input.signal?.aborted
          )
            return undefined;

          const now = yield* DateTime.now;
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: attempt.rootNodeId,
            rootNodeId: attempt.rootNodeId,
            kind: "approval_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: id,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          };
          const modeRevision = thread.runtimeChatGrants?.modeRevision;
          const request: OrchestrationV2RuntimeRequest = {
            id,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: input.kind,
            status: "pending",
            responseCapability: {
              type: "runtime",
              attemptId,
              ...(input.chatGrant === undefined
                ? {}
                : {
                    chatGrant: {
                      grant: input.chatGrant,
                      ...(modeRevision === undefined ? {} : { modeRevision }),
                    },
                  }),
            },
            createdAt: now,
            resolvedAt: null,
          };
          const item: OrchestrationV2TurnItem = {
            id: itemId,
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            type: "approval_request",
            status: "waiting",
            title: null,
            requestId: id,
            requestKind: input.kind,
            prompt: input.prompt,
            options,
            ...(input.appName === undefined ? {} : { appName: input.appName }),
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          };
          const base = { threadId, runId, nodeId, occurredAt: now };
          const written = yield* events.writeIfRunCurrent({
            threadId,
            runId,
            activeAttemptId: attemptId,
            expectedStatus: "running",
            requireApprovalOwner: true,
            events: [
              { ...base, id: EventId.make(`${key}:node`), type: "node.updated", payload: node },
              {
                ...base,
                id: EventId.make(`${key}:request`),
                type: "runtime-request.updated",
                payload: request,
              },
              {
                ...base,
                id: EventId.make(`${key}:item`),
                type: "turn-item.updated",
                payload: item,
              },
            ],
          });
          const sequence = written.storedEvents.at(-1)?.sequence;
          return sequence === undefined
            ? undefined
            : { sequence, modeRevision, runOrdinal: run.ordinal };
        });

        const withdraw = Effect.gen(function* () {
          const { request, node, item } = yield* projections.getRuntimeResponseContext(
            threadId,
            id,
          );
          if (
            request === undefined ||
            !["pending", "cancelled", "expired"].includes(request.status) ||
            node === undefined ||
            item?.type !== "approval_request"
          )
            return;
          if (
            request.status !== "pending" &&
            node.status === "cancelled" &&
            item.status === "cancelled"
          )
            return;
          const now = yield* DateTime.now;
          const base = { threadId, runId, nodeId, occurredAt: now };
          yield* events.write({
            guardProviderRequestUpdates: true,
            events: [
              ...(request.status !== "pending"
                ? []
                : [
                    {
                      ...base,
                      id: EventId.make(`${key}:cancel-request`),
                      type: "runtime-request.updated",
                      payload: {
                        ...request,
                        status: "cancelled",
                        resolvedAt: now,
                        responseCapability: {
                          type: "not_resumable",
                          reason: "The approval was withdrawn.",
                        },
                      },
                    } satisfies OrchestrationV2DomainEvent,
                  ]),
              {
                ...base,
                id: EventId.make(`${key}:cancel-node`),
                type: "node.updated",
                payload: { ...node, status: "cancelled", completedAt: now },
              },
              {
                ...base,
                id: EventId.make(`${key}:cancel-item`),
                type: "turn-item.updated",
                payload: { ...item, status: "cancelled", completedAt: now, updatedAt: now },
              },
            ],
          });
        });

        waiters.set(id, deferred);
        return yield* Effect.gen(function* () {
          const opened = yield* commands.withLock(threadId, open);
          if (opened === undefined) return "cancel" as const;
          // Replay from the opening transaction to include teardown committed before subscription.
          const ended = events
            .stream({ threadId, afterSequence: opened.sequence, capturedCursor: true })
            .pipe(
              Stream.filter(({ event }) =>
                endsApproval(event, input, id, opened.runOrdinal, opened.modeRevision),
              ),
              Stream.runHead,
            );
          return yield* Effect.raceFirst(
            Deferred.await(deferred).pipe(
              Effect.map((decision) => (input.signal?.aborted ? ("cancel" as const) : decision)),
            ),
            Effect.raceFirst(ended, waitForAbort(input.signal)).pipe(Effect.as("cancel" as const)),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              waiters.delete(id);
            }).pipe(
              Effect.andThen(commands.withLock(threadId, withdraw)),
              Effect.catch(() =>
                Effect.logWarning("Could not withdraw Runtime approval", { requestId: id }),
              ),
            ),
          ),
        );
      }).pipe(
        Effect.orElseSucceed(() => "cancel" as const),
        Effect.catchDefect(() => Effect.succeed("cancel" as const)),
      );

    const approvals = RuntimeApprovals.of({
      ask,
      isAllowedForChat: ({ threadId, grant }) =>
        projections.getThread(threadId).pipe(
          Effect.map(
            (thread) =>
              thread.deletedAt === null &&
              thread.archivedAt === null &&
              thread.runtimeChatGrants?.mode === thread.runtimeMode &&
              thread.runtimeChatGrants.grants.includes(grant),
          ),
          Effect.orElseSucceed(() => false),
        ),
      allowForChat: ({ threadId, grant }) =>
        commands
          .withLock(
            threadId,
            Effect.gen(function* () {
              const thread = yield* projections.getThread(threadId);
              if (thread.deletedAt !== null || thread.archivedAt !== null) return;
              const runtimeChatGrants = addRuntimeChatGrant(thread, grant);
              if (runtimeChatGrants === undefined) return;
              const now = yield* DateTime.now;
              yield* events.write({
                events: [
                  {
                    id: EventId.make(`runtime-chat-grant:${yield* randomUuidV4}`),
                    type: "thread.runtime-chat-grant-added",
                    threadId,
                    occurredAt: now,
                    payload: { ...thread, runtimeChatGrants },
                  },
                ],
              });
            }),
          )
          .pipe(
            Effect.catch(() =>
              Effect.logWarning("Could not record Runtime chat grant", { threadId }),
            ),
          ),
    });

    return Context.make(RuntimeApprovals, approvals).pipe(
      Context.add(
        RuntimeApprovalDelivery,
        RuntimeApprovalDelivery.of({
          deliver: (id, decision) =>
            Effect.suspend(() => {
              const waiter = waiters.get(id);
              return waiter === undefined
                ? Effect.void
                : Deferred.succeed(waiter, decision).pipe(Effect.asVoid);
            }),
        }),
      ),
    );
  }),
);
