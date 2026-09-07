import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  WORKBENCH_AGENT_CANCEL_CHANNEL,
  WORKBENCH_AGENT_MAX_REPLY_BYTES,
  WORKBENCH_AGENT_REQUEST_CHANNEL,
  WorkbenchAgentReplySchema,
  type WorkbenchAgentRequest,
  type WorkbenchAgentRequestBody,
  type WorkbenchAgentResult,
  type WorkbenchWindowReference,
} from "../../shared/nodex-app-tools/workbench";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import { safeSendToWindow } from "../ipc-safe-send";
import { WindowRuntime } from "../window-runtime/WindowRuntime";

export class WorkbenchAgentBridgeError extends Schema.TaggedError<WorkbenchAgentBridgeError>()(
  "WorkbenchAgentBridgeError",
  {
    reason: Schema.Literals([
      "unavailable",
      "stale_renderer",
      "capacity",
      "timeout",
      "cancelled",
      "failed",
      "stale_presentation",
      "invalid_request",
      "result_too_large",
      "closed",
    ]),
  },
) {}

interface PendingRequest {
  readonly reference: WorkbenchWindowReference;
  readonly webContentsId: number;
  readonly body: WorkbenchAgentRequestBody;
  readonly result: Deferred.Deferred<WorkbenchAgentResult, WorkbenchAgentBridgeError>;
}

export class WorkbenchAgentBridge extends Context.Service<
  WorkbenchAgentBridge,
  {
    /** The IPC Adapter supplies the trusted sender; payloads never choose a WebContents. */
    readonly register: (
      webContentsId: number,
      ownerId: string,
    ) => Effect.Effect<WorkbenchWindowReference, WorkbenchAgentBridgeError>;
    readonly release: (
      webContentsId: number,
      reference: WorkbenchWindowReference,
    ) => Effect.Effect<void>;
    readonly registered: () => readonly WorkbenchWindowReference[];
    readonly referenceForSender: (webContentsId: number) => WorkbenchWindowReference | null;
    readonly request: <Request extends WorkbenchAgentRequestBody>(
      reference: WorkbenchWindowReference,
      body: Request,
    ) => Effect.Effect<
      Extract<WorkbenchAgentResult, { kind: Request["kind"] }>,
      WorkbenchAgentBridgeError
    >;
    readonly reply: (webContentsId: number, payload: unknown) => Effect.Effect<boolean>;
  }
>()("nodex/main/app-tools/WorkbenchAgentBridge") {}

const sameReference = (left: WorkbenchWindowReference, right: WorkbenchWindowReference) =>
  left.windowSessionId === right.windowSessionId &&
  left.rendererGeneration === right.rendererGeneration;

/** Owns bounded request correlation only. Live Scenes remain exclusively in the renderer. */
export const make = (
  options: {
    readonly send?: typeof safeSendToWindow;
    readonly timeoutMs?: number;
    readonly maxPending?: number;
    readonly maxPendingPerWindow?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const windows = yield* WindowRuntime;
    const send = options.send ?? safeSendToWindow;
    const registrations = new Map<number, WorkbenchWindowReference>();
    const pending = new Map<string, PendingRequest>();
    let open = true;

    const isCurrent = (webContentsId: number, reference: WorkbenchWindowReference) =>
      windows.resolveSessionId(webContentsId) === reference.windowSessionId &&
      windows.resolveRendererGeneration(webContentsId) === reference.rendererGeneration;

    const invalidate = Effect.fn("WorkbenchAgentBridge.invalidate")(function* (
      webContentsId: number,
      reason: WorkbenchAgentBridgeError["reason"],
    ) {
      const registration = registrations.get(webContentsId);
      if (registration && !isCurrent(webContentsId, registration))
        registrations.delete(webContentsId);
      const invalidated = [...pending].filter(
        ([, request]) =>
          request.webContentsId === webContentsId &&
          (!isCurrent(webContentsId, request.reference) || !registrations.has(webContentsId)),
      );
      for (const [requestId] of invalidated) pending.delete(requestId);
      yield* Effect.forEach(
        invalidated,
        ([, request]) => Deferred.fail(request.result, new WorkbenchAgentBridgeError({ reason })),
        { discard: true },
      );
    });

    yield* windows.events.pipe(
      Stream.runForEach((event) => invalidate(event.window.webContentsId, "stale_renderer")),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        open = false;
        registrations.clear();
        const requests = [...pending.values()];
        pending.clear();
        yield* Effect.forEach(
          requests,
          (request) =>
            Deferred.fail(request.result, new WorkbenchAgentBridgeError({ reason: "closed" })),
          { discard: true },
        );
      }),
    );

    const register = Effect.fn("WorkbenchAgentBridge.register")(function* (
      webContentsId: number,
      ownerId: string,
    ) {
      if (!open) return yield* new WorkbenchAgentBridgeError({ reason: "closed" });
      const windowSessionId = windows.resolveSessionId(webContentsId);
      const rendererGeneration = windows.claimPresentationGeneration(webContentsId, ownerId);
      if (!windowSessionId || !rendererGeneration)
        return yield* new WorkbenchAgentBridgeError({ reason: "unavailable" });
      const reference = { windowSessionId, rendererGeneration };
      registrations.set(webContentsId, reference);
      yield* invalidate(webContentsId, "stale_renderer");
      return reference;
    });

    const release = Effect.fn("WorkbenchAgentBridge.release")(function* (
      webContentsId: number,
      reference: WorkbenchWindowReference,
    ) {
      const existing = registrations.get(webContentsId);
      if (!existing || !sameReference(existing, reference)) return;
      registrations.delete(webContentsId);
      yield* invalidate(webContentsId, "unavailable");
    });

    const request: WorkbenchAgentBridge["Service"]["request"] = <
      Request extends WorkbenchAgentRequestBody,
    >(
      reference: WorkbenchWindowReference,
      body: Request,
    ) =>
      Effect.gen(function* () {
        if (!open) return yield* new WorkbenchAgentBridgeError({ reason: "closed" });
        const target = [...registrations].find(([, candidate]) =>
          sameReference(reference, candidate),
        );
        if (!target || !isCurrent(target[0], reference))
          return yield* new WorkbenchAgentBridgeError({ reason: "stale_renderer" });
        const webContentsId = target[0];
        const window = windows.get(webContentsId);
        if (!window || window.isDestroyed())
          return yield* new WorkbenchAgentBridgeError({ reason: "unavailable" });
        if (
          pending.size >= (options.maxPending ?? 128) ||
          [...pending.values()].filter((item) => item.webContentsId === webContentsId).length >=
            (options.maxPendingPerWindow ?? 8)
        )
          return yield* new WorkbenchAgentBridgeError({ reason: "capacity" });

        const result = yield* Deferred.make<WorkbenchAgentResult, WorkbenchAgentBridgeError>();
        const requestId = randomUUID();
        const message: WorkbenchAgentRequest = {
          windowSessionId: reference.windowSessionId,
          rendererGeneration: reference.rendererGeneration,
          requestId,
          body,
        };
        const entry: PendingRequest = { reference, webContentsId, body, result };
        const value = yield* Effect.acquireUseRelease(
          Effect.sync(() => pending.set(requestId, entry)),
          () =>
            Effect.gen(function* () {
              if (!send(window, WORKBENCH_AGENT_REQUEST_CHANNEL, [message]))
                return yield* new WorkbenchAgentBridgeError({ reason: "unavailable" });
              return yield* Deferred.await(result).pipe(
                Effect.timeoutOrElse({
                  duration: options.timeoutMs ?? 10_000,
                  orElse: () => Effect.fail(new WorkbenchAgentBridgeError({ reason: "timeout" })),
                }),
              );
            }),
          () =>
            Effect.sync(() => {
              if (pending.get(requestId) !== entry) return;
              pending.delete(requestId);
              if (!isCurrent(webContentsId, reference)) return;
              send(window, WORKBENCH_AGENT_CANCEL_CHANNEL, [
                {
                  windowSessionId: reference.windowSessionId,
                  rendererGeneration: reference.rendererGeneration,
                  requestId,
                },
              ]);
            }),
        );
        return value as Extract<WorkbenchAgentResult, { kind: Request["kind"] }>;
      });

    const reply = Effect.fn("WorkbenchAgentBridge.reply")(function* (
      webContentsId: number,
      payload: unknown,
    ) {
      const parsed = yield* Effect.try({
        try: () => {
          if (Buffer.byteLength(JSON.stringify(payload), "utf8") > WORKBENCH_AGENT_MAX_REPLY_BYTES)
            return null;
          return WorkbenchAgentReplySchema.safeParse(payload);
        },
        catch: () => new WorkbenchAgentBridgeError({ reason: "invalid_request" }),
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!parsed?.success) return false;
      const response = parsed.data;
      const entry = pending.get(response.requestId);
      if (
        !entry ||
        entry.webContentsId !== webContentsId ||
        !sameReference(entry.reference, response)
      )
        return false;
      if (!isCurrent(webContentsId, entry.reference)) {
        yield* invalidate(webContentsId, "stale_renderer");
        return false;
      }
      if (response.outcome.ok) {
        const result = response.outcome.result;
        if (result.kind !== entry.body.kind) return false;
        if (
          entry.body.kind === "command" &&
          result.kind === "command" &&
          (result.receipt.operationId !== entry.body.envelope.operationId ||
            makeWorkbenchSceneKey(result.receipt.sceneOwner) !==
              makeWorkbenchSceneKey(entry.body.envelope.sceneOwner))
        )
          return false;
        if (
          entry.body.kind === "observe" &&
          result.kind === "observe" &&
          result.observation &&
          makeWorkbenchSceneKey(result.observation.sceneOwner) !==
            makeWorkbenchSceneKey(entry.body.sceneOwner)
        )
          return false;
      }
      pending.delete(response.requestId);
      if (!response.outcome.ok) {
        yield* Deferred.fail(
          entry.result,
          new WorkbenchAgentBridgeError({ reason: response.outcome.error }),
        );
        return true;
      }
      yield* Deferred.succeed(entry.result, response.outcome.result);
      return true;
    });

    return WorkbenchAgentBridge.of({
      register,
      release,
      request,
      reply,
      registered: () =>
        [...registrations].flatMap(([id, reference]) =>
          isCurrent(id, reference) ? [reference] : [],
        ),
      referenceForSender: (id) => {
        const reference = registrations.get(id);
        return reference && isCurrent(id, reference) ? reference : null;
      },
    });
  });

export const live = Layer.effect(WorkbenchAgentBridge, make());
