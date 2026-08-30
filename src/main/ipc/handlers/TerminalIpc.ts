import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { IpcEvents } from "../../../shared/ipc-api";
import type {
  TerminalAttachRequest,
  TerminalCreateRequest,
  TerminalRunActionRequest,
  TerminalSize,
  TerminalTakeOverViewRequest,
  TerminalViewLeaseResult,
} from "../../../shared/types";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { safeBroadcastToWindows, safeSendToWebContents } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ElectronWindowHost } from "../../platform/electron/ElectronWindowHost";
import {
  TerminalProjectAdmission,
  type TerminalProjectAdmissionError,
} from "../../terminal-runtime/TerminalProjectAdmission";
import {
  TerminalSessionError,
  TerminalSessions,
  type TerminalOwner,
} from "../../terminal-runtime/TerminalSessions";
import { WindowSessionCatalog } from "../../window-runtime/WindowSessionCatalog";

export class TerminalIpcError extends Schema.TaggedError<TerminalIpcError>()("TerminalIpcError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

interface LeaseCleanupBinding {
  readonly sender: WebContents;
  readonly listener: () => void;
}

const errorMessage = (error: TerminalSessionError): string =>
  error.cause instanceof Error ? error.cause.message : String(error.cause);

export const live: Layer.Layer<
  never,
  never,
  | ElectronIpc
  | ElectronWindowHost
  | ScopedCallbackRuntime
  | TerminalProjectAdmission
  | TerminalSessions
  | WindowSessionCatalog
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const callbacks = yield* ScopedCallbackRuntime;
    const ipc = yield* ElectronIpc;
    const windows = yield* ElectronWindowHost;
    const admission = yield* TerminalProjectAdmission;
    const sessions = yield* TerminalSessions;
    const windowSessions = yield* WindowSessionCatalog;
    const cleanupBindings = yield* Ref.make<ReadonlyMap<number, LeaseCleanupBinding>>(new Map());

    yield* Effect.addFinalizer(() =>
      Ref.get(cleanupBindings).pipe(
        Effect.tap((bindings) =>
          Effect.sync(() => {
            for (const binding of bindings.values()) {
              binding.sender.removeListener("destroyed", binding.listener);
            }
          }),
        ),
        Effect.andThen(Ref.set(cleanupBindings, new Map())),
      ),
    );

    const bindLeaseCleanup = Effect.fn("TerminalIpc.bindLeaseCleanup")(function* (
      sender: WebContents,
    ) {
      const listener = () => {
        callbacks.fork(
          sessions.releaseLeasesForWebContents(sender.id).pipe(
            Effect.andThen(
              Ref.update(cleanupBindings, (current) => {
                const next = new Map(current);
                next.delete(sender.id);
                return next;
              }),
            ),
          ),
        );
      };
      const inserted = yield* Ref.modify(cleanupBindings, (current) => {
        if (current.has(sender.id)) return [false, current] as const;
        const next = new Map(current);
        next.set(sender.id, { sender, listener });
        return [true, next] as const;
      });
      if (inserted) yield* Effect.sync(() => sender.once("destroyed", listener));
    });

    const ownerFor = Effect.fn("TerminalIpc.ownerFor")(function* (event: IpcMainInvokeEvent) {
      const windowSessionId = yield* windowSessions.resolveForWebContents(event.sender.id);
      if (windowSessionId === null) {
        return yield* new TerminalIpcError({
          operation: "resolve-window-session",
          cause: new Error("The requesting window has no assigned Window Session"),
        });
      }
      yield* bindLeaseCleanup(event.sender);
      return {
        webContentsId: event.sender.id,
        windowSessionId,
      } satisfies TerminalOwner;
    });

    const reportError = (sender: WebContents, sessionId: string, error: TerminalSessionError) =>
      Effect.sync(() => {
        safeSendToWebContents(sender, "terminal-error", [
          { sessionId, message: errorMessage(error) },
        ]);
      });

    const recoverLeaseResult = (
      sender: WebContents,
      sessionId: string,
      effect: Effect.Effect<
        TerminalViewLeaseResult,
        TerminalSessionError | TerminalProjectAdmissionError
      >,
    ) =>
      effect.pipe(
        Effect.catchTag("TerminalSessionError", (error) =>
          reportError(sender, sessionId, error).pipe(Effect.as({ status: "not_found" } as const)),
        ),
      );

    const recoverCommand = (
      sender: WebContents,
      sessionId: string,
      effect: Effect.Effect<void, TerminalSessionError | TerminalProjectAdmissionError>,
    ) =>
      effect.pipe(
        Effect.catchTag("TerminalSessionError", (error) => reportError(sender, sessionId, error)),
      );

    yield* Effect.forkScoped(
      sessions.events.pipe(
        Stream.runForEach((event) =>
          windows.all.pipe(
            Effect.tap((all) =>
              Effect.sync(() => {
                if (event.target.kind === "broadcast") {
                  safeBroadcastToWindows(all, event.channel as keyof IpcEvents, [
                    event.payload as never,
                  ]);
                  return;
                }
                const targetWebContentsId = event.target.webContentsId;
                const target = all.find(
                  (window) => window.webContents.id === targetWebContentsId,
                )?.webContents;
                if (!target) return;
                safeSendToWebContents(target, event.channel as keyof IpcEvents, [
                  event.payload as never,
                ]);
              }),
            ),
            Effect.asVoid,
          ),
        ),
      ),
    );

    yield* ipc.handlePlainCommand("terminal-create", (event, input: TerminalCreateRequest) =>
      ownerFor(event).pipe(
        Effect.andThen((owner) =>
          recoverLeaseResult(
            event.sender,
            input.sessionId,
            admission.run(input, sessions.create(owner, input)),
          ),
        ),
      ),
    );
    yield* ipc.handleControl("terminal-acquire-view", (event, input: TerminalAttachRequest) =>
      ownerFor(event).pipe(
        Effect.andThen((owner) =>
          recoverLeaseResult(
            event.sender,
            input.sessionId,
            admission.run(input, sessions.acquireViewLease(owner, input)),
          ),
        ),
      ),
    );
    yield* ipc.handleControl(
      "terminal-take-over-view",
      (event, input: TerminalTakeOverViewRequest) =>
        ownerFor(event).pipe(
          Effect.andThen((owner) =>
            recoverLeaseResult(
              event.sender,
              input.sessionId,
              sessions.takeOverViewLease(owner, input),
            ),
          ),
        ),
    );
    yield* ipc.handleControl("terminal-release-view", (event, sessionId: string) =>
      ownerFor(event).pipe(Effect.andThen((owner) => sessions.releaseViewLease(owner, sessionId))),
    );
    yield* ipc.handleControl("terminal-write", (event, sessionId: string, data: string) =>
      ownerFor(event).pipe(
        Effect.andThen((owner) =>
          recoverCommand(event.sender, sessionId, sessions.write(owner, sessionId, data)),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("terminal-run-action", (event, input: TerminalRunActionRequest) =>
      ownerFor(event).pipe(
        Effect.andThen((owner) =>
          recoverCommand(
            event.sender,
            input.sessionId,
            admission.run(input, sessions.runAction(owner, input)),
          ),
        ),
      ),
    );
    yield* ipc.handleQuery("terminal-session:snapshot", (_event, sessionId: string) =>
      sessions.getSessionSnapshot(sessionId),
    );
    yield* ipc.handleControl("terminal-resize", (event, sessionId: string, size: TerminalSize) =>
      ownerFor(event).pipe(
        Effect.andThen((owner) =>
          recoverCommand(event.sender, sessionId, sessions.resize(owner, sessionId, size)),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("terminal-kill", (event, sessionId: string) =>
      ownerFor(event).pipe(Effect.andThen(sessions.killSession(sessionId))),
    );
    yield* ipc.handleQuery("thread-terminal-snapshot", (_event, threadId: string) =>
      sessions.getThreadSnapshot(threadId),
    );
  }),
);
