import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { IpcEvents } from "../../../shared/ipc-api";
import { AgentBackendApplication } from "../../agent-backend/AgentBackendApplication";
import { MainConfig } from "../../app/MainConfig";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { safeSendToWebContents } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import {
  AcpRendererObservationRegistry,
  type AcpRendererObservationChanges,
} from "./AcpRendererObservationRegistry";

const id = z.string().trim().min(1).max(512);
const prompt = z
  .string()
  .trim()
  .min(1)
  .max(256 * 1024);
const OpenInput = z.object({ threadId: id }).strict();
const StartInput = z.object({ sessionId: id, instanceConfigId: id, prompt }).strict();
const PromptInput = z.object({ threadId: id, prompt }).strict();
const ModeInput = z.object({ threadId: id, modeId: id }).strict();
const ConfigInput = z
  .object({ threadId: id, configId: id, value: z.union([z.string().max(16_384), z.boolean()]) })
  .strict();
const AuthenticateInput = z.object({ threadId: id, methodId: id }).strict();

export class AgentBackendIpcError extends Schema.TaggedError<AgentBackendIpcError>()(
  "AgentBackendIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const failure = (operation: string, cause: unknown) =>
  new AgentBackendIpcError({ operation, cause });

export const live: Layer.Layer<
  never,
  never,
  AgentBackendApplication | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const application = yield* AgentBackendApplication;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const observers = new AcpRendererObservationRegistry<IpcMainInvokeEvent["sender"]>();
    const runObservationLifecycle = yield* FiberSet.makeRuntime<never, void, never>();
    const applyObservationChanges = (changes: AcpRendererObservationChanges) =>
      Effect.forEach(changes.unobservedThreadIds, application.unobserveAcpSession, {
        discard: true,
      }).pipe(
        Effect.andThen(
          Effect.forEach(changes.observedThreadIds, application.observeAcpSession, {
            discard: true,
          }),
        ),
        Effect.asVoid,
      );
    const releaseObserver = (ownerId: number) =>
      Effect.sync(() => observers.release(ownerId)).pipe(
        Effect.flatMap(applyObservationChanges),
        Effect.uninterruptible,
      );
    const closeObservers = Effect.sync(() => observers.close()).pipe(
      Effect.flatMap(applyObservationChanges),
    );
    yield* Effect.addFinalizer(() => closeObservers);
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
          ) {
            throw new Error("Agent Backend access requires an active Nodex window");
          }
        },
        catch: (cause) => failure("authorize-renderer", cause),
      });
    const parse = <A>(operation: string, schema: z.ZodType<A>, value: unknown) =>
      Effect.try({ try: () => schema.parse(value), catch: (cause) => failure(operation, cause) });
    const handle = <A, B>(
      event: IpcMainInvokeEvent,
      operation: string,
      schema: z.ZodType<A>,
      value: unknown,
      evaluate: (input: A) => Effect.Effect<B, unknown>,
    ) =>
      authorize(event).pipe(
        Effect.andThen(parse(`parse-${operation}`, schema, value)),
        Effect.flatMap(evaluate),
        Effect.mapError((cause) =>
          cause instanceof AgentBackendIpcError ? cause : failure(operation, cause),
        ),
      );
    const threadId = (event: IpcMainInvokeEvent, operation: string, value: unknown) =>
      authorize(event).pipe(
        Effect.andThen(parse(`parse-${operation}`, id, value)),
        Effect.mapError((cause) =>
          cause instanceof AgentBackendIpcError ? cause : failure(operation, cause),
        ),
      );

    yield* ipc.handlePlainCommand("agent-backend:acp:thread:start", (event, input) =>
      handle(event, "thread.start", StartInput, input, application.startAcpThread),
    );
    yield* ipc.handlePlainCommand("agent-backend:acp:session:open", (event, input) =>
      handle(event, "session.open", OpenInput, input, application.openAcpSession),
    );
    yield* ipc.handleQuery("agent-backend:acp:session:read", (event, value) =>
      threadId(event, "session.read", value).pipe(Effect.flatMap(application.readAcpSession)),
    );
    yield* ipc.handleControl("agent-backend:acp:session:observe", (event, value) =>
      threadId(event, "session.observe", value).pipe(
        Effect.flatMap((observedThreadId) =>
          Effect.try({
            try: () => {
              const onDestroyed = () => {
                void runObservationLifecycle(releaseObserver(event.sender.id));
              };
              event.sender.once("destroyed", onDestroyed);
              return observers.observe(event.sender.id, event.sender, observedThreadId, () =>
                event.sender.removeListener("destroyed", onDestroyed),
              );
            },
            catch: (cause) => failure("session.observe", cause),
          }).pipe(Effect.flatMap(applyObservationChanges), Effect.uninterruptible),
        ),
        Effect.asVoid,
      ),
    );
    yield* ipc.handleControl("agent-backend:acp:session:unobserve", (event, value) =>
      threadId(event, "session.unobserve", value).pipe(
        Effect.flatMap((observedThreadId) =>
          Effect.sync(() => observers.unobserve(event.sender.id, observedThreadId)).pipe(
            Effect.flatMap(applyObservationChanges),
            Effect.uninterruptible,
          ),
        ),
        Effect.asVoid,
      ),
    );
    yield* ipc.handlePlainCommand("agent-backend:acp:session:prompt", (event, input) =>
      handle(event, "session.prompt", PromptInput, input, application.promptAcpSession),
    );
    yield* ipc.handlePlainCommand("agent-backend:acp:session:cancel", (event, value) =>
      threadId(event, "session.cancel", value).pipe(Effect.flatMap(application.cancelAcpSession)),
    );
    yield* ipc.handlePlainCommand("agent-backend:acp:session:set-mode", (event, input) =>
      handle(event, "session.set-mode", ModeInput, input, application.setAcpMode),
    );
    yield* ipc.handlePlainCommand("agent-backend:acp:session:set-config-option", (event, input) =>
      handle(
        event,
        "session.set-config-option",
        ConfigInput,
        input,
        application.setAcpConfigOption,
      ),
    );
    yield* ipc.handlePlainCommand("agent-backend:acp:session:authenticate", (event, input) =>
      handle(
        event,
        "session.authenticate",
        AuthenticateInput,
        input,
        application.authenticateAcpSession,
      ),
    );
    yield* ipc.handlePlainCommand("agent-backend:acp:session:close", (event, value) =>
      threadId(event, "session.close", value).pipe(Effect.flatMap(application.closeAcpSession)),
    );

    yield* application.changes.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          for (const [webContentsId, sender] of observers.matching(event.threadId)) {
            const delivered = safeSendToWebContents(
              sender,
              "agent-backend:acp:session-changed" satisfies keyof IpcEvents,
              [event],
            );
            if (!delivered && sender.isDestroyed()) yield* releaseObserver(webContentsId);
          }
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
