import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import type {
  AgentRuntimeResponseInput,
  AgentRuntimeSessionEvent,
} from "../../../shared/agent-runtime-api";
import * as Inputs from "../../../shared/schemas/agent-runtime-api";
import { AgentRuntimeApplication } from "../../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSessionActivity } from "../../agent-runtime/AgentRuntimeSessionActivity";
import { AgentRuntimeSupervisor } from "../../agent-runtime/AgentRuntimeSupervisor";
import { MainConfig } from "../../app/MainConfig";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { safeBroadcastToWindows, safeSendToWebContents } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class AgentRuntimeIpcError extends Schema.TaggedError<AgentRuntimeIpcError>()(
  "AgentRuntimeIpcError",
  {
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** Renderer observation owns delivery only; the engine owns execution and replay. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const application = yield* AgentRuntimeApplication;
    const supervisor = yield* AgentRuntimeSupervisor;
    const activity = yield* AgentRuntimeSessionActivity;
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const callbacks = yield* ScopedCallbackRuntime;
    const ownerScope = yield* Effect.scope;
    const watchers = new Map<
      string,
      { readonly sender: IpcMainInvokeEvent["sender"]; readonly scope: Scope.Closeable }
    >();
    const senderDisposals = new Map<
      number,
      { readonly sender: IpcMainInvokeEvent["sender"]; readonly dispose: () => void }
    >();
    const keyOf = (senderId: number, subscriptionId: string) =>
      JSON.stringify([senderId, subscriptionId]);
    const release = Effect.fn("AgentRuntimeIpc.release")(function* (key: string) {
      const watcher = watchers.get(key);
      if (!watcher) return;
      watchers.delete(key);
      const senderId = watcher.sender.id;
      if (![...watchers.values()].some((entry) => entry.sender.id === senderId)) {
        const disposal = senderDisposals.get(senderId);
        disposal?.sender.removeListener("destroyed", disposal.dispose);
        senderDisposals.delete(senderId);
      }
      yield* Scope.close(watcher.scope, Exit.void);
    });
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          if (
            !isTrustedAppRendererIpcSender({
              developmentOrigin: config.rendererUrl,
              hasOwnerWindow: windows.has(event.sender.id),
              senderType: event.sender.getType(),
              senderUrl: event.senderFrame?.url ?? "",
              isMainFrame: event.senderFrame === event.sender.mainFrame,
            })
          )
            throw new Error("Agent Runtime requires an active Nodex window");
        },
        catch: (cause) => new AgentRuntimeIpcError({ operation: "authorize", cause }),
      });
    const handle = <A, B>(
      event: IpcMainInvokeEvent,
      schema: z.ZodType<A>,
      value: unknown,
      operation: (input: A) => Effect.Effect<B, unknown>,
    ) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.try({
            try: () => schema.parse(value),
            catch: (cause) => new AgentRuntimeIpcError({ operation: "input", cause }),
          }),
        ),
        Effect.flatMap(operation),
      );
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...watchers.keys()], release, { discard: true }),
    );
    // One Main projection serves every window; renderers re-read the snapshot after `reset`.
    yield* activity.activityChanges.pipe(
      Stream.runForEach((change) =>
        Effect.sync(() =>
          safeBroadcastToWindows(windows.all(), "agent-runtime:activity-changed", [change]),
        ),
      ),
      Effect.forkScoped,
    );
    yield* activity.connectionChanges.pipe(
      Stream.runForEach((state) =>
        Effect.sync(() =>
          safeBroadcastToWindows(windows.all(), "agent-runtime:connection-changed", [state]),
        ),
      ),
      Effect.forkScoped,
    );
    yield* ipc.handleQuery("agent-runtime:activity:read", (event) =>
      authorize(event).pipe(Effect.andThen(activity.read)),
    );
    yield* ipc.handleQuery("agent-runtime:connection:read", (event) =>
      authorize(event).pipe(Effect.andThen(activity.connection)),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:launch", (event, value) =>
      handle(event, Inputs.AgentRuntimeLaunchSchema, value, application.launch),
    );
    yield* ipc.handleQuery("agent-runtime:session:read", (event, value) =>
      handle(event, Inputs.AgentRuntimeTargetSchema, value, application.read),
    );
    yield* ipc.handleQuery("agent-runtime:session:control", (event, value) =>
      handle(event, Inputs.AgentRuntimeControlSchema, value, application.control),
    );
    yield* ipc.handleQuery("agent-runtime:session:inspect", (event, value) =>
      handle(event, Inputs.AgentRuntimeTargetSchema, value, application.inspect),
    );
    yield* ipc.handleQuery("agent-runtime:session:overview", (event, value) =>
      handle(event, Inputs.AgentRuntimeOverviewSchema, value, application.overview),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:message", (event, value) =>
      handle(event, Inputs.AgentRuntimeMessageInputSchema, value, application.message),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:queue-message", (event, value) =>
      handle(event, Inputs.AgentRuntimeMessageInputSchema, value, application.queueMessage),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:queue", (event, value) =>
      handle(event, Inputs.AgentRuntimeQueueSchema, value, application.queue),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:fork", (event, value) =>
      handle(event, Inputs.AgentRuntimeForkSchema, value, application.fork),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:merge-back", (event, value) =>
      handle(event, Inputs.AgentRuntimeMergeBackSchema, value, application.mergeBack),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:stop", (event, value) =>
      handle(event, Inputs.AgentRuntimeStopSchema, value, application.stop),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:respond", (event, value) =>
      handle(
        event,
        Inputs.AgentRuntimeResponseSchema as z.ZodType<AgentRuntimeResponseInput>,
        value,
        application.respond,
      ),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:set-modes", (event, value) =>
      handle(event, Inputs.AgentRuntimeModesSchema, value, application.setModes),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:compact", (event, value) =>
      handle(event, Inputs.AgentRuntimeCompactSchema, value, application.compact),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:rollback", (event, value) =>
      handle(event, Inputs.AgentRuntimeRollbackSchema, value, application.rollback),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:retry-preparation", (event, value) =>
      handle(event, Inputs.AgentRuntimePreparationRetrySchema, value, application.retryPreparation),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:stop-task", (event, value) =>
      handle(event, Inputs.AgentRuntimeTaskStopSchema, value, application.stopTask),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:move", (event, value) =>
      handle(event, Inputs.AgentRuntimeSessionMoveSchema, value, application.moveSession),
    );
    yield* ipc.handleQuery("agent-runtime:session:history", (event, value) =>
      handle(event, Inputs.AgentRuntimeHistorySchema, value, application.history),
    );
    yield* ipc.handleQuery("agent-runtime:session:prompt-index", (event, value) =>
      handle(event, Inputs.AgentRuntimeTargetSchema, value, application.promptIndex),
    );
    yield* ipc.handleQuery("agent-runtime:session:queue-read", (event, value) =>
      handle(event, Inputs.AgentRuntimeQueueReadSchema, value, application.readQueuePage),
    );
    yield* ipc.handleQuery("agent-runtime:session:queued-preview", (event, value) =>
      handle(event, Inputs.AgentRuntimeRunSchema, value, application.readQueuedPreview),
    );
    yield* ipc.handleQuery("agent-runtime:session:run-message", (event, value) =>
      handle(event, Inputs.AgentRuntimeRunSchema, value, application.readRunMessage),
    );
    yield* ipc.handleQuery("agent-runtime:session:item", (event, value) =>
      handle(event, Inputs.AgentRuntimeItemSchema, value, application.item),
    );
    yield* ipc.handleQuery("agent-runtime:session:attachment", (event, value) =>
      handle(event, Inputs.AgentRuntimeAttachmentSchema, value, application.attachment),
    );
    yield* ipc.handleQuery("agent-runtime:providers:read", (event, value) =>
      handle(event, Inputs.AgentRuntimeCatalogSchema, value ?? {}, application.catalog),
    );
    yield* ipc.handleQuery("agent-runtime:providers:known", (event) =>
      authorize(event).pipe(Effect.andThen(application.knownCatalog())),
    );
    yield* ipc.handleControl("agent-runtime:session:unobserve", (event, value) =>
      handle(event, Inputs.AgentRuntimeUnobserveSchema, value, (input) =>
        release(keyOf(event.sender.id, input.subscriptionId)).pipe(
          Effect.as({ unobserved: true as const }),
        ),
      ),
    );
    yield* ipc.handleControl("agent-runtime:session:observe", (event, value) =>
      handle(event, Inputs.AgentRuntimeObserveSchema, value, (input) =>
        Effect.gen(function* () {
          const target = yield* application.resolveTarget(input);
          const connection = yield* supervisor.get();
          if (connection.identity.runtimeId !== target.runtimeId)
            return yield* new AgentRuntimeIpcError({ operation: "runtime-identity" });
          const key = keyOf(event.sender.id, input.subscriptionId);
          if (watchers.has(key)) return { observed: true as const };
          if (
            watchers.size >= 256 ||
            [...watchers.values()].filter((entry) => entry.sender.id === event.sender.id).length >=
              64
          )
            return yield* new AgentRuntimeIpcError({ operation: "observation-capacity" });
          const scope = yield* Scope.fork(ownerScope);
          const watcher = { sender: event.sender, scope };
          watchers.set(key, watcher);
          if (!senderDisposals.has(event.sender.id)) {
            const dispose = () =>
              callbacks.fork(
                Effect.forEach(
                  [...watchers.entries()].filter(
                    ([, entry]) => entry.sender.id === event.sender.id,
                  ),
                  ([key]) => release(key),
                  { discard: true },
                ),
              );
            senderDisposals.set(event.sender.id, { sender: event.sender, dispose });
            event.sender.once("destroyed", dispose);
          }
          const send = (message: AgentRuntimeSessionEvent) =>
            Effect.sync(() => {
              if (watchers.get(key) !== watcher) return;
              if (
                !safeSendToWebContents(event.sender, "agent-runtime:session-event", [
                  { ...message, subscriptionId: input.subscriptionId },
                ])
              )
                callbacks.fork(release(key));
            });
          const reset = (
            reason: Extract<
              AgentRuntimeSessionEvent,
              { readonly type: "reset-required" }
            >["reason"],
          ) =>
            send({
              type: "reset-required",
              sessionId: target.sessionId,
              threadId: target.threadId,
              reason,
            });
          yield* Effect.gen(function* () {
            // Subscribe before requesting replay so events emitted before its acknowledgement survive.
            const notifications = yield* connection.subscribeNotifications;
            const admitted = yield* connection.request("events.observe", {
              threadId: target.threadId,
              afterSequence: input.afterSequence,
              eventTypes: input.eventTypes,
            });
            yield* Effect.addFinalizer(() =>
              connection
                .request("events.unobserve", { subscriptionId: admitted.subscriptionId })
                .pipe(Effect.timeout("2 seconds"), Effect.ignoreCause),
            );
            let previousDelivery: number | undefined;
            const delivery = notifications.pipe(
              Stream.runForEach(({ delivery, notification }) =>
                Effect.gen(function* () {
                  if (previousDelivery !== undefined && delivery !== previousDelivery + 1)
                    yield* reset("delivery-gap");
                  previousDelivery = delivery;
                  if (
                    notification.type === "event" &&
                    notification.subscriptionId === admitted.subscriptionId
                  )
                    yield* send({
                      type: "event",
                      sessionId: target.sessionId,
                      threadId: target.threadId,
                      event: notification.event,
                    });
                  if (
                    notification.type === "event.error" &&
                    notification.subscriptionId === admitted.subscriptionId
                  )
                    yield* reset("stream-failed");
                }),
              ),
            );
            yield* Effect.raceFirst(
              delivery,
              connection.terminated.pipe(Effect.andThen(reset("runtime-restarted"))),
            ).pipe(
              Effect.catchCause(() => reset("stream-failed")),
              Effect.forkIn(scope, { startImmediately: true }),
            );
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onError(() => release(key)),
          );
          return { observed: true as const };
        }),
      ),
    );
  }),
);
