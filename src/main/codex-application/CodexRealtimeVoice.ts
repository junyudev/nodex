import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import type {
  CodexRealtimeVoiceEvent,
  CodexRealtimeVoiceGrant,
  CodexRealtimeVoiceMediaEvidence,
  CodexRealtimeVoiceNativeNotification,
  CodexRealtimeVoiceSnapshot,
  CodexRealtimeVoiceTarget,
} from "../../shared/codex-realtime-voice";
import { isCodexRealtimeVoiceStartupComplete } from "../../shared/codex-realtime-voice";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  prepareUntrustedAppInput,
  type CodexAppModelContextAttachment,
} from "../../shared/codex-untrusted-app-input";
import type { ConversationTextRole } from "@nodex/codex-app-server-protocol";
import type { TurnCompletedNotification } from "@nodex/codex-app-server-protocol/v2";
import { CodexMedia } from "./CodexMedia";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import {
  buildRealtimeVoiceInitialItems,
  resolveSupportedRealtimeVoice,
} from "./CodexRealtimeVoiceConfiguration";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import {
  CodexRuntimeError,
  isCodexThreadLifecycleAlreadyAppliedRequestError,
} from "../codex-runtime/CodexRuntimeError";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { DictationRuntime } from "../host-runtime/DictationRuntime";
import { RendererClientRuntime } from "../host-runtime/RendererClientRuntime";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import type { ConversationEntityState } from "./internal/ConversationEntityState";
import {
  CodexRealtimeVoicePolicy,
  type CodexPreparedRealtimeVoicePolicy,
} from "./CodexRealtimeVoicePolicy";

export class CodexRealtimeVoiceError extends Schema.TaggedError<CodexRealtimeVoiceError>()(
  "CodexRealtimeVoiceError",
  {
    reason: Schema.Literals(["unavailable", "busy", "changed", "native"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

interface VoiceAttempt {
  readonly grant: CodexRealtimeVoiceGrant;
  readonly clientId: string;
  readonly webContentsId: number;
  readonly capabilities: CodexAppServerCapabilitySnapshot;
  readonly entity: ConversationEntityState;
  readonly executionEpoch: number;
  readonly policy: CodexPreparedRealtimeVoicePolicy;
  readonly scope: Scope.Closeable;
  readonly startGate: Semaphore.Semaphore;
  startFiber: Fiber.Fiber<void, CodexRealtimeVoiceError> | null;
  snapshot: CodexRealtimeVoiceSnapshot;
  evidence: {
    requestAccepted: boolean;
    started: boolean;
    connected: boolean;
    initialized: boolean;
  };
  startIssued: boolean;
  nativeStopped: boolean;
  microphoneInputDeviceId: string | null;
  stopping: boolean;
  terminated: boolean;
  closing: boolean;
  readonly closed: Deferred.Deferred<void>;
}
type VoiceObservation =
  | CodexRealtimeVoiceNativeNotification
  | {
      readonly method: "turn/completed";
      readonly params: TurnCompletedNotification;
    };

export class CodexRealtimeVoice extends Context.Service<
  CodexRealtimeVoice,
  {
    /** Occupancy is Profile-wide; query admission is evaluated for its separate target. */
    readonly readSession: () => CodexRealtimeVoiceSnapshot | null;
    readonly prepare: (
      webContentsId: number,
      target: CodexRealtimeVoiceTarget,
    ) => Effect.Effect<CodexRealtimeVoiceGrant, CodexRealtimeVoiceError>;
    readonly start: (
      webContentsId: number,
      claimId: string,
      sdp: string,
    ) => Effect.Effect<void, CodexRealtimeVoiceError>;
    readonly observeNative: (
      source: { readonly hostId: string; readonly generation: number },
      notification: VoiceObservation,
    ) => Effect.Effect<void>;
    readonly reportMedia: (
      webContentsId: number,
      claimId: string,
      evidence: CodexRealtimeVoiceMediaEvidence,
    ) => Effect.Effect<void, CodexRealtimeVoiceError>;
    readonly setMuted: (
      webContentsId: number,
      claimId: string,
      input: { readonly microphoneMuted: boolean; readonly outputMuted: boolean },
    ) => Effect.Effect<void, CodexRealtimeVoiceError>;
    readonly stop: (
      webContentsId: number,
      claimId: string,
    ) => Effect.Effect<void, CodexRealtimeVoiceError>;
    /** Only after its renderer has released the actual media graph and tracks. */
    readonly release: (webContentsId: number, claimId: string) => Effect.Effect<boolean>;
    readonly appendText: (
      webContentsId: number,
      claimId: string,
      role: ConversationTextRole,
      text: string,
    ) => Effect.Effect<void, CodexRealtimeVoiceError>;
    readonly appendSpeech: (
      webContentsId: number,
      claimId: string,
      text: string,
    ) => Effect.Effect<void, CodexRealtimeVoiceError>;
    readonly injectContext: (
      webContentsId: number,
      claimId: string,
      attachments: readonly CodexAppModelContextAttachment[],
    ) => Effect.Effect<void, CodexRealtimeVoiceError>;
  }
>()("nodex/main/codex-application/CodexRealtimeVoice") {}

const changed = () =>
  new CodexRealtimeVoiceError({ reason: "changed", message: "The voice session changed" });
const failure = (cause: unknown) =>
  new CodexRealtimeVoiceError({
    reason: "native",
    message: "Could not update the voice session",
    cause,
  });

export const make = Effect.gen(function* () {
  const gateway = yield* CodexGateway;
  const capabilities = yield* CodexAppServerCapabilities;
  const dictation = yield* DictationRuntime;
  const clients = yield* RendererClientRuntime;
  const conversations = yield* ConversationEntityMap;
  const policy = yield* CodexRealtimeVoicePolicy;
  const media = yield* CodexMedia;
  const lifetime = yield* Scope.Scope;
  const admission = yield* Semaphore.make(1);
  let current: VoiceAttempt | null = null;
  let accepting = true;

  const owns = (attempt: VoiceAttempt, webContentsId = attempt.webContentsId): boolean =>
    accepting &&
    !attempt.terminated &&
    current === attempt &&
    attempt.webContentsId === webContentsId &&
    clients.getClientIdForWebContentsId(webContentsId) === attempt.clientId &&
    conversations.current(attempt.grant.threadId) === attempt.entity &&
    attempt.entity.readCanonicalState()?.hostId === attempt.grant.hostId;
  const emit = (attempt: VoiceAttempt, event: CodexRealtimeVoiceEvent): void => {
    if (current === attempt)
      clients.sendCriticalToClient(attempt.clientId, "codex:realtime-voice:event", event);
  };
  const publish = (attempt: VoiceAttempt): void => {
    attempt.snapshot = { ...attempt.snapshot, revision: attempt.snapshot.revision + 1 };
    emit(attempt, { type: "snapshot", snapshot: attempt.snapshot });
  };
  const invalidateAvailability = (): void => {
    clients.broadcast("codex:realtime-voice:event", {
      type: "availabilityChanged",
    } satisfies CodexRealtimeVoiceEvent);
  };
  const activate = (attempt: VoiceAttempt): void => {
    if (
      !owns(attempt) ||
      attempt.stopping ||
      !isCodexRealtimeVoiceStartupComplete(attempt.evidence)
    )
      return;
    attempt.snapshot = { ...attempt.snapshot, phase: "active" };
    publish(attempt);
  };
  const terminate = (attempt: VoiceAttempt): void => {
    if (current !== attempt || attempt.terminated) return;
    attempt.terminated = true;
    attempt.stopping = true;
    attempt.snapshot = { ...attempt.snapshot, phase: "stopping" };
    publish(attempt);
    emit(attempt, { type: "terminate", claimId: attempt.grant.claimId });
  };
  const resolve = (
    webContentsId: number,
    claimId: string,
  ): Effect.Effect<VoiceAttempt, CodexRealtimeVoiceError> =>
    Effect.suspend(() =>
      current?.grant.claimId === claimId && owns(current, webContentsId)
        ? Effect.succeed(current)
        : Effect.fail(changed()),
    );
  const assertCurrent = Effect.fn("CodexRealtimeVoice.assertCurrent")(function* (
    attempt: VoiceAttempt,
  ) {
    if (!owns(attempt)) return yield* changed();
    if (!(yield* capabilities.isCurrent(attempt.capabilities).pipe(Effect.mapError(failure))))
      return yield* changed();
    yield* policy.assertCurrent(attempt.policy).pipe(Effect.mapError(() => changed()));
    if (
      !owns(attempt) ||
      (yield* conversations.executionEpoch(attempt.grant.threadId)) !== attempt.executionEpoch
    )
      return yield* changed();
  });
  const close = Effect.fn("CodexRealtimeVoice.close")(function* (attempt: VoiceAttempt) {
    if (current !== attempt) return;
    if (attempt.closing) return yield* Deferred.await(attempt.closed);
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        attempt.closing = true;
        terminate(attempt);
      }),
      () => Scope.close(attempt.scope, Exit.void),
      () =>
        Effect.gen(function* () {
          if (current === attempt) {
            current = null;
            invalidateAvailability();
          }
          yield* Deferred.succeed(attempt.closed, undefined);
        }),
    );
  });

  yield* policy.changes.pipe(
    Stream.runForEach((product) =>
      Effect.sync(() => {
        invalidateAvailability();
        const attempt = current;
        if (!attempt) return;
        if (
          product.status !== "ready" ||
          !product.entryPoint ||
          !product.accessAllowed ||
          product.accountId !== attempt.policy.productPolicy.accountId ||
          product.userId !== attempt.policy.productPolicy.userId
        )
          terminate(attempt);
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* dictation.changes.pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const attempt = current;
        if (!attempt || attempt.stopping) return;
        const settings = yield* dictation.readSettings.pipe(Effect.orElseSucceed(() => null));
        if (
          !settings ||
          !owns(attempt) ||
          attempt.stopping ||
          settings.microphoneInputDeviceId === attempt.microphoneInputDeviceId
        )
          return;
        attempt.microphoneInputDeviceId = settings.microphoneInputDeviceId;
        emit(attempt, {
          type: "microphoneChanged",
          claimId: attempt.grant.claimId,
          deviceId: settings.microphoneInputDeviceId,
        });
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* clients.events.pipe(
    Stream.runForEach((event) =>
      event.kind === "disposed" && current?.clientId === event.clientId
        ? close(current)
        : Effect.void,
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      conversations.subscribeRetired((threadId, generation) => {
        if (current?.entity.threadId === threadId && current.entity.generation === generation)
          terminate(current);
      }),
    ),
    (subscription) => Effect.sync(() => subscription[Symbol.dispose]()),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      accepting = false;
    }).pipe(Effect.andThen(Effect.suspend(() => (current ? close(current) : Effect.void)))),
  );

  const prepare = Effect.fn("CodexRealtimeVoice.prepare")(function* (
    webContentsId: number,
    target: CodexRealtimeVoiceTarget,
  ) {
    if (!accepting) return yield* changed();
    const clientId = clients.getClientIdForWebContentsId(webContentsId);
    if (clientId === null) return yield* changed();
    if (current) {
      if (
        owns(current, webContentsId) &&
        !current.stopping &&
        current.grant.hostId === target.hostId &&
        current.grant.threadId === target.threadId
      ) {
        yield* assertCurrent(current);
        return current.grant;
      }
      return yield* new CodexRealtimeVoiceError({
        reason: "busy",
        message: "Voice is already active",
      });
    }
    const entity = conversations.current(target.threadId);
    const nativeHost = entity?.readCanonicalState()?.hostId;
    if (!entity || nativeHost !== target.hostId || entity.readResumeState() !== "resumed")
      return yield* new CodexRealtimeVoiceError({
        reason: "unavailable",
        message: "Restore this chat before starting voice",
      });
    const captured = yield* capabilities.forHost(target.hostId).pipe(Effect.mapError(failure));
    const prepared = yield* policy.prepare(target).pipe(
      Effect.mapError(
        (cause) =>
          new CodexRealtimeVoiceError({
            reason: "unavailable",
            message: "Voice is not available",
            cause,
          }),
      ),
    );
    if (prepared.hostId !== target.hostId || prepared.threadId !== target.threadId)
      return yield* changed();
    const catalog = yield* gateway
      .requestOnHost(
        target.hostId,
        "thread/realtime/listVoices",
        {},
        codexGatewayGenerationFence(captured),
      )
      .pipe(Effect.mapError(failure));
    const preferred =
      prepared.productPolicy.accountId !== null && prepared.productPolicy.userId !== null
        ? yield* media.readRealtimeVoicePreference({
            accountId: prepared.productPolicy.accountId,
            userId: prepared.productPolicy.userId,
          })
        : null;
    const selectedVoice = resolveSupportedRealtimeVoice(catalog.voices, preferred);
    if (selectedVoice === null)
      return yield* new CodexRealtimeVoiceError({
        reason: "unavailable",
        message: "No supported voice is available",
      });
    const policyWithVoice = {
      ...prepared,
      nativeStart: { ...prepared.nativeStart, voice: selectedVoice },
    };
    const executionEpoch = yield* conversations.executionEpoch(target.threadId);
    const settings = yield* dictation.readSettings.pipe(Effect.mapError(failure));
    const label = yield* dictation.readMicrophoneRouteHint.pipe(Effect.mapError(failure));
    if (
      !accepting ||
      clients.getClientIdForWebContentsId(webContentsId) !== clientId ||
      conversations.current(target.threadId) !== entity
    )
      return yield* changed();
    const grant: CodexRealtimeVoiceGrant = {
      ...target,
      claimId: createUuidV7(),
      realtimeSessionId: createUuidV7(),
      microphoneInputDeviceId: settings.microphoneInputDeviceId,
      builtInMicrophoneLabelHint: label,
      bufferInputWhileConnecting: prepared.bufferInputWhileConnecting,
    };
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const scope = yield* Scope.fork(lifetime, "sequential");
        const startGate = yield* Semaphore.make(1);
        const closed = yield* Deferred.make<void>();
        const attempt: VoiceAttempt = {
          grant,
          scope,
          startGate,
          startFiber: null,
          clientId,
          webContentsId,
          capabilities: captured,
          entity,
          executionEpoch,
          policy: policyWithVoice,
          evidence: {
            requestAccepted: false,
            started: false,
            connected: false,
            initialized: false,
          },
          startIssued: false,
          nativeStopped: false,
          stopping: false,
          terminated: false,
          closing: false,
          closed,
          microphoneInputDeviceId: grant.microphoneInputDeviceId,
          snapshot: {
            ...target,
            claimId: grant.claimId,
            realtimeSessionId: grant.realtimeSessionId,
            phase: "starting",
            microphoneMuted: false,
            outputMuted: false,
            revision: 0,
          },
        };
        current = attempt;
        invalidateAvailability();
        const nativeLease = entity.retainNativeExecution({
          hostId: captured.hostId,
          generation: captured.generation,
        });
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            nativeLease[Symbol.dispose]();
          }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                attempt.startIssued && !attempt.nativeStopped
                  ? gateway
                      .requestOnHost(
                        attempt.grant.hostId,
                        "thread/realtime/stop",
                        { threadId: attempt.grant.threadId },
                        codexGatewayGenerationFence(attempt.capabilities),
                      )
                      .pipe(
                        Effect.catch(() =>
                          Effect.logWarning("Voice transport cleanup did not complete"),
                        ),
                        Effect.asVoid,
                      )
                  : Effect.void,
              ),
            ),
            Effect.ensuring(microphoneRelease(attempt)),
            Effect.asVoid,
          ),
        );
        yield* gateway.connectionChanges(captured.hostId).pipe(
          Stream.runForEach((connection) =>
            Effect.sync(() => {
              if (connection.kind !== "ready" || connection.generation !== captured.generation)
                terminate(attempt);
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        return attempt;
      }),
      (attempt) =>
        Effect.gen(function* () {
          yield* assertCurrent(attempt);
          const acquired = yield* dictation.acquireVoiceMicrophone({
            webContentsId,
            sessionId: grant.claimId,
          });
          if (!acquired)
            return yield* new CodexRealtimeVoiceError({
              reason: "busy",
              message: "The microphone is in use",
            });
          yield* assertCurrent(attempt);
          publish(attempt);
          return grant;
        }),
      (attempt, exit) => (Exit.isFailure(exit) ? close(attempt) : Effect.void),
    );
  });

  function microphoneRelease(attempt: VoiceAttempt): Effect.Effect<boolean> {
    return dictation.releaseMicrophone(attempt.webContentsId, attempt.grant.claimId);
  }

  return CodexRealtimeVoice.of({
    readSession: () => current?.snapshot ?? null,
    prepare: (webContentsId, target) => admission.withPermit(prepare(webContentsId, target)),
    start: Effect.fn("CodexRealtimeVoice.start")(function* (webContentsId, claimId, sdp) {
      const attempt = yield* resolve(webContentsId, claimId);
      const request = Effect.gen(function* () {
        yield* assertCurrent(attempt);
        if (attempt.stopping) return yield* changed();
        yield* conversations
          .admitExecution(
            attempt.grant.threadId,
            { hostId: attempt.capabilities.hostId, generation: attempt.capabilities.generation },
            Effect.gen(function* () {
              yield* assertCurrent(attempt);
              if (attempt.stopping) return yield* changed();
              const initialItems = buildRealtimeVoiceInitialItems(
                residentConversationTurns(attempt.entity.readCanonicalState()),
                attempt.policy.productPolicy.config,
                attempt.policy.nativeStart.version,
              );
              attempt.startIssued = true;
              yield* gateway.requestOnHost(
                attempt.grant.hostId,
                "thread/realtime/start",
                {
                  ...attempt.policy.nativeStart,
                  ...(initialItems.length > 0 ? { initialItems } : {}),
                  threadId: attempt.grant.threadId,
                  realtimeSessionId: attempt.grant.realtimeSessionId,
                  transport: { type: "webrtc", sdp },
                },
                codexGatewayGenerationFence(attempt.capabilities),
              );
            }),
            attempt.executionEpoch,
          )
          .pipe(Effect.mapError(failure));
        yield* assertCurrent(attempt);
        attempt.evidence.requestAccepted = true;
        activate(attempt);
      });
      const fiber = yield* attempt.startGate.withPermit(
        Effect.gen(function* () {
          if (attempt.startFiber) return attempt.startFiber;
          const fiber = yield* request.pipe(
            Effect.forkIn(attempt.scope, { startImmediately: true }),
          );
          attempt.startFiber = fiber;
          return fiber;
        }),
      );
      yield* Fiber.join(fiber);
    }),
    observeNative: Effect.fn("CodexRealtimeVoice.observeNative")(function* (source, notification) {
      const attempt = current;
      if (
        !attempt ||
        (!attempt.startIssued && notification.method !== "turn/completed") ||
        attempt.terminated ||
        !owns(attempt) ||
        source.hostId !== attempt.capabilities.hostId ||
        source.generation !== attempt.capabilities.generation ||
        notification.params.threadId !== attempt.grant.threadId
      )
        return;
      if (
        !(yield* capabilities
          .isCurrent(attempt.capabilities)
          .pipe(Effect.mapError(failure))
          .pipe(Effect.orElseSucceed(() => false))) ||
        !owns(attempt) ||
        attempt.terminated
      )
        return;
      if (notification.method === "turn/completed") {
        if (notification.params.turn.error?.codexErrorInfo === "misalignmentPolicyViolation")
          terminate(attempt);
        return;
      }
      if (notification.method === "thread/realtime/started") {
        if (notification.params.realtimeSessionId !== attempt.grant.realtimeSessionId) return;
        attempt.evidence.started = true;
        activate(attempt);
      }
      emit(attempt, { type: "native", claimId: attempt.grant.claimId, notification });
    }),
    reportMedia: Effect.fn("CodexRealtimeVoice.reportMedia")(
      function* (webContentsId, claimId, evidence) {
        const attempt = yield* resolve(webContentsId, claimId);
        yield* assertCurrent(attempt);
        attempt.evidence[evidence] = true;
        activate(attempt);
      },
    ),
    setMuted: Effect.fn("CodexRealtimeVoice.setMuted")(function* (webContentsId, claimId, input) {
      const attempt = yield* resolve(webContentsId, claimId);
      yield* assertCurrent(attempt);
      attempt.snapshot = { ...attempt.snapshot, ...input };
      publish(attempt);
    }),
    stop: Effect.fn("CodexRealtimeVoice.stop")(function* (webContentsId, claimId) {
      const attempt = yield* resolve(webContentsId, claimId);
      const previous = attempt.snapshot.phase;
      attempt.stopping = true;
      attempt.snapshot = { ...attempt.snapshot, phase: "stopping" };
      publish(attempt);
      if (!attempt.startIssued) return;
      return yield* gateway
        .requestOnHost(
          attempt.grant.hostId,
          "thread/realtime/stop",
          { threadId: attempt.grant.threadId },
          codexGatewayGenerationFence(attempt.capabilities),
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              attempt.nativeStopped = true;
            }),
          ),
          Effect.asVoid,
          Effect.mapError(failure),
          Effect.tapError((error) =>
            Effect.gen(function* () {
              const cause = error.cause;
              const missing =
                Schema.is(CodexRuntimeError)(cause) &&
                cause.hostId === attempt.capabilities.hostId &&
                cause.generation === attempt.capabilities.generation &&
                isCodexThreadLifecycleAlreadyAppliedRequestError(cause, {
                  method: "thread/realtime/stop",
                  threadId: attempt.grant.threadId,
                });
              if (missing) attempt.nativeStopped = true;
              if (!owns(attempt)) return;
              if (missing) {
                terminate(attempt);
                return;
              }
              const valid = yield* assertCurrent(attempt).pipe(Effect.result);
              if (valid._tag === "Failure") {
                terminate(attempt);
                return;
              }
              attempt.stopping = false;
              attempt.snapshot = { ...attempt.snapshot, phase: previous };
              publish(attempt);
              activate(attempt);
            }),
          ),
        );
    }),
    release: (webContentsId, claimId) =>
      Effect.suspend(() =>
        current?.grant.claimId === claimId && current.webContentsId === webContentsId
          ? close(current).pipe(Effect.as(true))
          : Effect.succeed(false),
      ),
    appendText: Effect.fn("CodexRealtimeVoice.appendText")(
      function* (webContentsId, claimId, role, text) {
        const attempt = yield* resolve(webContentsId, claimId);
        yield* assertCurrent(attempt);
        yield* gateway
          .requestOnHost(
            attempt.grant.hostId,
            "thread/realtime/appendText",
            {
              threadId: attempt.grant.threadId,
              role,
              text,
            },
            codexGatewayGenerationFence(attempt.capabilities),
          )
          .pipe(Effect.mapError(failure));
        yield* assertCurrent(attempt);
      },
    ),
    appendSpeech: Effect.fn("CodexRealtimeVoice.appendSpeech")(
      function* (webContentsId, claimId, text) {
        const attempt = yield* resolve(webContentsId, claimId);
        yield* assertCurrent(attempt);
        yield* gateway
          .requestOnHost(
            attempt.grant.hostId,
            "thread/realtime/appendSpeech",
            { threadId: attempt.grant.threadId, text },
            codexGatewayGenerationFence(attempt.capabilities),
          )
          .pipe(Effect.mapError(failure));
        yield* assertCurrent(attempt);
      },
    ),
    injectContext: Effect.fn("CodexRealtimeVoice.injectContext")(
      function* (webContentsId, claimId, attachments) {
        const attempt = yield* resolve(webContentsId, claimId);
        yield* assertCurrent(attempt);
        const items = yield* Effect.try({
          try: () =>
            prepareUntrustedAppInput(
              "",
              { mcpAppModelContextAttachments: attachments },
              `untrusted_input_${createUuidV7()}`,
            ).responseItems,
          catch: failure,
        });
        if (items.length === 0) return;
        yield* gateway
          .requestOnHost(
            attempt.grant.hostId,
            "thread/inject_items",
            {
              threadId: attempt.grant.threadId,
              items,
            },
            codexGatewayGenerationFence(attempt.capabilities),
          )
          .pipe(Effect.mapError(failure));
        yield* assertCurrent(attempt);
      },
    ),
  });
});

export const live = Layer.effect(CodexRealtimeVoice, make);
