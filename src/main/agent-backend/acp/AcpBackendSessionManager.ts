import type {
  AuthenticateResponse,
  ListSessionsResponse,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { AcpBackendSessionChangedEvent } from "../../../shared/agent-backend-api";
import type { AcpConversationSnapshot } from "../../../shared/acp-conversation";
import { MainConfig } from "../../app/MainConfig";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import { TerminalRuntimeMap } from "../../terminal-runtime/TerminalRuntimeMap";
import { AcpAgentLaunchProbe } from "../../platform/node/AcpAgentLaunchProbe";
import { AcpSessionTransport } from "../../platform/node/AcpSessionTransport";
import { live as capabilityOwnerLive } from "./AcpClientCapabilityOwner";
import { AcpInteractionAuthority } from "./AcpInteractionAuthority";
import { acpRuntimeError, type AcpRuntimeError } from "./AcpRuntimeError";
import {
  AcpSessionRuntime,
  layer as acpSessionRuntimeLayer,
  type AcpBackendCapabilityProfile,
  type AcpSessionOpenRequest,
  type AcpSessionRuntimeEvent,
} from "./AcpSessionRuntime";
import { live as terminalOwnerLive } from "./AcpTerminalOwner";
import { live as workspaceFileOwnerLive } from "./AcpWorkspaceFileOwner";
import { resolveClaudeAcpLaunch } from "./ClaudeAcpAgentDefinition";
import {
  beginAcpConversationTurn,
  closeAcpConversation,
  completeAcpConversationAuthentication,
  diffAcpConversationSnapshots,
  emptyAcpConversationSnapshot,
  failAcpConversation,
  recoverAcpConversationTurnFailure,
  reduceAcpConversationEvent,
} from "./AcpConversationProjection";

export type AcpBackendSessionState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "authentication-required"; readonly error: AcpRuntimeError }
  | { readonly kind: "failed"; readonly error: AcpRuntimeError }
  | { readonly kind: "closed" };

export interface OpenAcpBackendSessionInput {
  readonly threadId: string;
  readonly agentDefinitionId: string;
  readonly instanceConfigId: string;
  readonly workspaceRoot: string;
  readonly open?: AcpSessionOpenRequest;
  readonly permissionPolicy: "approve-for-me" | "ask";
}

export interface AcpDeferredInitialPrompt {
  readonly prompt: string;
  readonly clientUserMessageId: string;
}

export interface AcpBackendSessionHandle {
  readonly threadId: string;
  readonly agentDefinitionId: string;
  readonly instanceConfigId: string;
  readonly sessionId: string | null;
  readonly capabilities: AcpBackendCapabilityProfile;
  readonly modes: SessionModeState | null;
  readonly configOptions: readonly SessionConfigOption[];
  readonly status: SubscriptionRef.SubscriptionRef<AcpBackendSessionState>;
  readonly snapshot: SubscriptionRef.SubscriptionRef<AcpConversationSnapshot>;
  readonly events: Stream.Stream<AcpSessionRuntimeEvent>;
  readonly authenticate: (methodId: string) => Effect.Effect<AuthenticateResponse, AcpRuntimeError>;
  /** Holds a not-yet-submitted first prompt only while interactive authentication is pending. */
  readonly deferInitialPrompt: (prompt: AcpDeferredInitialPrompt) => Effect.Effect<void>;
  readonly takeDeferredInitialPrompt: Effect.Effect<AcpDeferredInitialPrompt | null>;
  readonly listSessions: Effect.Effect<ListSessionsResponse, AcpRuntimeError>;
  readonly deleteSession: (sessionId: string) => Effect.Effect<void, AcpRuntimeError>;
  readonly prompt: (
    prompt: PromptRequest["prompt"],
    options?: { readonly clientUserMessageId?: string },
  ) => Effect.Effect<PromptResponse, AcpRuntimeError>;
  readonly cancel: Effect.Effect<void, AcpRuntimeError>;
  readonly setMode: (modeId: string) => Effect.Effect<void, AcpRuntimeError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<readonly SessionConfigOption[], AcpRuntimeError>;
}

export class AcpBackendSessionManager extends Context.Service<
  AcpBackendSessionManager,
  {
    readonly open: (
      input: OpenAcpBackendSessionInput,
    ) => Effect.Effect<AcpBackendSessionHandle, AcpRuntimeError>;
    readonly get: (threadId: string) => Effect.Effect<AcpBackendSessionHandle | null>;
    readonly observe: (threadId: string) => Effect.Effect<void>;
    readonly unobserve: (threadId: string) => Effect.Effect<void>;
    readonly close: (threadId: string) => Effect.Effect<void>;
    readonly changes: Stream.Stream<AcpBackendSessionChangedEvent>;
  }
>()("nodex/main/agent-backend/acp/AcpBackendSessionManager") {}

interface OwnedSession {
  readonly scope: Scope.Closeable;
  readonly active: Ref.Ref<boolean>;
  readonly handle: AcpBackendSessionHandle;
}

const fail = (operation: string, reason: "capability" | "authorization", cause: unknown) =>
  acpRuntimeError({ operation, reason, retryable: false, cause });

export const DEFAULT_ACP_SESSION_IDLE_RETENTION = "2 minutes";
export const DEFAULT_ACP_SESSION_MAX_LIVE = 32;

export interface AcpBackendSessionManagerOptions {
  readonly idleRetention?: Duration.Input;
  readonly maxLiveSessions?: number;
}

export const make = (
  options: AcpBackendSessionManagerOptions = {},
): Effect.Effect<
  AcpBackendSessionManager["Service"],
  never,
  | AcpAgentLaunchProbe
  | AcpSessionTransport
  | ApplicationSettings
  | MainConfig
  | TerminalRuntimeMap
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const settings = yield* ApplicationSettings;
    const config = yield* MainConfig;
    const probe = yield* AcpAgentLaunchProbe;
    const transport = yield* AcpSessionTransport;
    const terminals = yield* TerminalRuntimeMap;
    const ownerScope = yield* Scope.Scope;
    const lanes = yield* RcMap.make({ lookup: (_threadId: string) => Semaphore.make(1) });
    const sessions = new Map<string, OwnedSession>();
    const observedThreads = new Set<string>();
    const reservations = new Set<string>();
    const capacityLock = yield* Semaphore.make(1);
    const maxLiveSessions = Math.max(
      1,
      Math.floor(options.maxLiveSessions ?? DEFAULT_ACP_SESSION_MAX_LIVE),
    );
    const idleEvictions = yield* FiberMap.make<string, void, never>();
    const changes = yield* PubSub.sliding<AcpBackendSessionChangedEvent>(256);

    const runExclusive = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const lane = yield* RcMap.get(lanes, threadId);
          return yield* lane.withPermits(1)(effect);
        }),
      );

    const closeOwned = (threadId: string, owned: OwnedSession): Effect.Effect<void> =>
      Effect.sync(() => {
        if (sessions.get(threadId) === owned) sessions.delete(threadId);
      }).pipe(
        Effect.andThen(Ref.set(owned.active, false)),
        Effect.andThen(SubscriptionRef.set(owned.handle.status, { kind: "closed" })),
        Effect.andThen(SubscriptionRef.update(owned.handle.snapshot, closeAcpConversation)),
        Effect.andThen(Scope.close(owned.scope, Exit.void)),
        Effect.asVoid,
        Effect.uninterruptible,
      );

    const reserveCapacity = (threadId: string): Effect.Effect<void, AcpRuntimeError> =>
      capacityLock.withPermits(1)(
        Effect.suspend(() => {
          if (sessions.size + reservations.size >= maxLiveSessions) {
            return Effect.fail(
              acpRuntimeError({
                operation: "session.capacity",
                reason: "pressure",
                retryable: true,
                cause: new Error(`Live ACP session limit (${maxLiveSessions}) reached`),
              }),
            );
          }
          reservations.add(threadId);
          return Effect.void;
        }),
      );
    const releaseCapacity = (threadId: string): Effect.Effect<void> =>
      capacityLock.withPermits(1)(
        Effect.sync(() => {
          reservations.delete(threadId);
        }),
      );
    const publishSession = (threadId: string, owned: OwnedSession): Effect.Effect<void> =>
      capacityLock.withPermits(1)(
        Effect.sync(() => {
          reservations.delete(threadId);
          sessions.set(threadId, owned);
        }),
      );

    const waitForIdleAndEvict = (threadId: string): Effect.Effect<void> =>
      Effect.sleep(options.idleRetention ?? DEFAULT_ACP_SESSION_IDLE_RETENTION).pipe(
        Effect.andThen(
          runExclusive(
            threadId,
            Effect.suspend(() => {
              if (observedThreads.has(threadId)) return Effect.succeed(true);
              const owned = sessions.get(threadId);
              if (!owned) return Effect.succeed(true);
              return SubscriptionRef.get(owned.handle.status).pipe(
                Effect.flatMap((state) =>
                  state.kind === "running"
                    ? Effect.succeed(false)
                    : closeOwned(threadId, owned).pipe(Effect.as(true)),
                ),
              );
            }),
          ),
        ),
        Effect.flatMap((finished) => (finished ? Effect.void : waitForIdleAndEvict(threadId))),
      );

    const scheduleIdleEviction = (threadId: string): Effect.Effect<void> => {
      if (observedThreads.has(threadId) || !sessions.has(threadId)) {
        return FiberMap.remove(idleEvictions, threadId);
      }
      return FiberMap.run(idleEvictions, threadId, waitForIdleAndEvict(threadId), {
        startImmediately: true,
      }).pipe(Effect.asVoid);
    };

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...sessions], ([threadId, owned]) => closeOwned(threadId, owned), {
        concurrency: "unbounded",
        discard: true,
      }),
    );

    const open = Effect.fn("AcpBackendSessionManager.open")(function* (
      input: OpenAcpBackendSessionInput,
    ) {
      return yield* runExclusive(
        input.threadId,
        Effect.scoped(
          Effect.gen(function* () {
            const existing = sessions.get(input.threadId);
            if (existing !== undefined) {
              const state = yield* SubscriptionRef.get(existing.handle.status);
              if (
                state.kind !== "closed" &&
                state.kind !== "failed" &&
                existing.handle.agentDefinitionId === input.agentDefinitionId &&
                existing.handle.instanceConfigId === input.instanceConfigId
              ) {
                return existing.handle;
              }
              if (state.kind === "closed" || state.kind === "failed") {
                yield* closeOwned(input.threadId, existing);
              } else {
                return yield* fail(
                  "session.binding",
                  "authorization",
                  new Error("Thread already has a live session for a different backend binding"),
                );
              }
            }
            if (input.agentDefinitionId !== "claude-agent-acp") {
              return yield* fail(
                "agent.definition",
                "capability",
                new Error(`Unsupported ACP Agent definition: ${input.agentDefinitionId}`),
              );
            }
            yield* FiberMap.remove(idleEvictions, input.threadId);
            yield* Effect.acquireRelease(reserveCapacity(input.threadId), () =>
              releaseCapacity(input.threadId),
            );
            const settingsSnapshot = yield* settings
              .snapshot()
              .pipe(Effect.mapError((cause) => fail("agent.settings", "authorization", cause)));
            const instance = settingsSnapshot.acpAgents.instances.find(
              ({ id }) => id === input.instanceConfigId,
            );
            if (
              instance === undefined ||
              !instance.enabled ||
              instance.agentDefinitionId !== input.agentDefinitionId
            ) {
              return yield* fail(
                "agent.instance",
                "authorization",
                new Error(
                  "ACP Agent instance is missing, disabled, or bound to another definition",
                ),
              );
            }
            const launch = yield* resolveClaudeAcpLaunch({
              installation: {
                packageRoot: instance.packageRoot,
              },
              nodeExecutable: instance.nodeExecutable,
              workspaceRoot: input.workspaceRoot,
              hostEnvironment: config.environment,
              policy: {
                credentials: instance.credentials,
                proxy: instance.proxy,
                sandbox: { kind: "agent-native-permissions", acknowledged: true },
              },
            }).pipe(Effect.provideService(AcpAgentLaunchProbe, probe));

            // Forking from the manager scope makes acquisition interruption-safe: until the
            // session is published in `sessions`, its child process is still owned by Main.
            const sessionScope = yield* Scope.fork(ownerScope);
            const workspace = workspaceFileOwnerLive({ workspaceRoot: launch.cwd });
            const terminal = terminalOwnerLive({
              environment: {
                PATH: config.environment.PATH ?? "/usr/bin:/bin",
                TERM: config.environment.TERM ?? "xterm-256color",
              },
            }).pipe(
              Layer.provide(Layer.merge(workspace, Layer.succeed(TerminalRuntimeMap, terminals))),
            );
            const interaction = Layer.succeed(
              AcpInteractionAuthority,
              AcpInteractionAuthority.of({
                requestPermission: (request) => {
                  if (input.permissionPolicy === "ask") {
                    return Effect.succeed({ outcome: { outcome: "cancelled" as const } });
                  }
                  const selected = request.options.find(({ kind }) => kind === "allow_once");
                  return Effect.succeed(
                    selected === undefined
                      ? { outcome: { outcome: "cancelled" as const } }
                      : {
                          outcome: {
                            outcome: "selected" as const,
                            optionId: selected.optionId,
                          },
                        },
                  );
                },
                createElicitation: () => Effect.succeed({ action: "cancel" }),
                completeElicitation: () => Effect.void,
              }),
            );
            const capabilityOwner = capabilityOwnerLive(launch.capabilityProfile).pipe(
              Layer.provide(Layer.mergeAll(interaction, workspace, terminal)),
            );
            const runtimeLayer = acpSessionRuntimeLayer({
              spawn: launch.spawn,
              cwd: launch.cwd,
              clientInfo: { name: "nodex", title: "Nodex", version: "0.5.0" },
              ...(input.open === undefined ? {} : { open: input.open }),
            }).pipe(
              Layer.provide(
                Layer.merge(Layer.succeed(AcpSessionTransport, transport), capabilityOwner),
              ),
            );
            const runtime = yield* Layer.buildWithScope(runtimeLayer, sessionScope).pipe(
              Effect.map((context) => Context.get(context, AcpSessionRuntime)),
              Effect.tapError(() => Scope.close(sessionScope, Exit.void)),
            );
            const authenticationRequired = acpRuntimeError({
              operation: "session.open",
              reason: "authentication-required",
              retryable: false,
              pid: runtime.pid,
              cause: new Error(
                "Choose an advertised ACP authentication method to open the session",
              ),
            });
            const status = yield* SubscriptionRef.make<AcpBackendSessionState>(
              runtime.sessionId === null
                ? { kind: "authentication-required", error: authenticationRequired }
                : { kind: "idle" },
            );
            const conversationSnapshot = yield* SubscriptionRef.make(
              runtime.sessionId === null
                ? recoverAcpConversationTurnFailure(
                    emptyAcpConversationSnapshot({
                      threadId: input.threadId,
                      sessionId: `pending:${input.threadId}`,
                    }),
                    authenticationRequired,
                    "authentication-required",
                  )
                : emptyAcpConversationSnapshot({
                    threadId: input.threadId,
                    sessionId: runtime.sessionId,
                  }),
            );
            const active = yield* Ref.make(true);
            const deferredInitialPrompt = yield* Ref.make<AcpDeferredInitialPrompt | null>(null);
            const projectedEvents = yield* PubSub.sliding<AcpSessionRuntimeEvent>(128);
            const nextTurnSequence = yield* Ref.make(1);
            const promptLane = yield* Semaphore.make(1);
            const projectedTurns = new Map<number, Deferred.Deferred<void>>();
            let currentModes = runtime.modes;
            let currentConfigOptions = runtime.configOptions;
            const requireActive = <A>(
              operation: string,
              effect: Effect.Effect<A, AcpRuntimeError>,
            ): Effect.Effect<A, AcpRuntimeError> =>
              Ref.get(active).pipe(
                Effect.flatMap((isActive) =>
                  isActive
                    ? effect
                    : Effect.fail(
                        acpRuntimeError({
                          operation,
                          reason: "request",
                          retryable: false,
                          ...(runtime.sessionId === null ? {} : { sessionId: runtime.sessionId }),
                          cause: new Error("ACP session handle is no longer active"),
                        }),
                      ),
                ),
              );
            const projectFailure = (error: AcpRuntimeError) =>
              SubscriptionRef.get(status).pipe(
                Effect.flatMap((current) =>
                  current.kind === "closed" || current.kind === "failed"
                    ? Effect.void
                    : SubscriptionRef.set(status, { kind: "failed", error }).pipe(
                        Effect.andThen(
                          SubscriptionRef.update(conversationSnapshot, (snapshot) =>
                            failAcpConversation(snapshot, error),
                          ),
                        ),
                      ),
                ),
              );
            const projectPromptFailure = (error: AcpRuntimeError) => {
              const recoverableStatus =
                error.reason === "authentication-required"
                  ? ("authentication-required" as const)
                  : error.reason === "request" || error.reason === "request-cancelled"
                    ? ("idle" as const)
                    : null;
              if (recoverableStatus === null) return projectFailure(error);
              return SubscriptionRef.get(status).pipe(
                Effect.flatMap((current) => {
                  if (current.kind === "closed" || current.kind === "failed") return Effect.void;
                  const next: AcpBackendSessionState =
                    recoverableStatus === "idle"
                      ? { kind: "idle" }
                      : { kind: "authentication-required", error };
                  return SubscriptionRef.set(status, next).pipe(
                    Effect.andThen(
                      SubscriptionRef.update(conversationSnapshot, (snapshot) =>
                        recoverAcpConversationTurnFailure(snapshot, error, recoverableStatus),
                      ),
                    ),
                  );
                }),
              );
            };

            yield* SubscriptionRef.changes(conversationSnapshot).pipe(
              Stream.mapAccum(
                () => null as AcpConversationSnapshot | null,
                (previous, snapshot) => {
                  if (previous === null) return [snapshot, []] as const;
                  const delta = diffAcpConversationSnapshots(previous, snapshot);
                  return [
                    snapshot,
                    delta === null ? [] : [{ threadId: input.threadId, delta }],
                  ] as const;
                },
              ),
              Stream.runForEach((event) => PubSub.publish(changes, event).pipe(Effect.asVoid)),
              Effect.forkIn(sessionScope),
            );

            yield* runtime.events.pipe(
              Stream.runForEach((event) => {
                if (event.kind === "session_update") {
                  if (event.update.sessionUpdate === "current_mode_update" && currentModes) {
                    currentModes = { ...currentModes, currentModeId: event.update.currentModeId };
                  }
                  if (event.update.sessionUpdate === "config_option_update") {
                    currentConfigOptions = event.update.configOptions;
                  }
                }
                return SubscriptionRef.update(conversationSnapshot, (current) =>
                  reduceAcpConversationEvent(current, event),
                ).pipe(
                  Effect.andThen(PubSub.publish(projectedEvents, event)),
                  Effect.andThen(
                    event.kind === "turn_stopped"
                      ? Effect.sync(() => projectedTurns.get(event.turnSequence)).pipe(
                          Effect.flatMap((completion) =>
                            completion === undefined
                              ? Effect.void
                              : Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
                          ),
                        )
                      : Effect.void,
                  ),
                  Effect.asVoid,
                );
              }),
              Effect.forkIn(sessionScope),
            );
            yield* runtime.drainEvents;
            const handle: AcpBackendSessionHandle = {
              threadId: input.threadId,
              agentDefinitionId: input.agentDefinitionId,
              instanceConfigId: input.instanceConfigId,
              get sessionId() {
                return runtime.sessionId;
              },
              capabilities: runtime.capabilities,
              get modes() {
                return currentModes;
              },
              get configOptions() {
                return currentConfigOptions;
              },
              status,
              snapshot: conversationSnapshot,
              events: Stream.fromPubSub(projectedEvents),
              authenticate: (methodId) =>
                requireActive("session.authenticate", runtime.authenticate(methodId)).pipe(
                  Effect.tap(() => {
                    const sessionId = runtime.sessionId;
                    if (sessionId === null) {
                      return Effect.fail(
                        acpRuntimeError({
                          operation: "session.authenticate",
                          reason: "protocol",
                          retryable: false,
                          pid: runtime.pid,
                          cause: new Error("ACP Agent authenticated without opening a session"),
                        }),
                      );
                    }
                    return SubscriptionRef.set(status, { kind: "idle" }).pipe(
                      Effect.andThen(
                        SubscriptionRef.update(conversationSnapshot, (snapshot) =>
                          completeAcpConversationAuthentication(snapshot, sessionId),
                        ),
                      ),
                    );
                  }),
                ),
              deferInitialPrompt: (prompt) => Ref.set(deferredInitialPrompt, prompt),
              takeDeferredInitialPrompt: Ref.getAndSet(deferredInitialPrompt, null),
              listSessions: requireActive("session.list", runtime.listSessions),
              deleteSession: (sessionId) =>
                requireActive("session.delete", runtime.deleteSession(sessionId)),
              prompt: (prompt, options) =>
                requireActive(
                  "session.prompt",
                  promptLane.withPermits(1)(
                    Effect.gen(function* () {
                      yield* requireActive("session.prompt.enter", Effect.void);
                      const turnSequence = yield* Ref.getAndUpdate(
                        nextTurnSequence,
                        (current) => current + 1,
                      );
                      const projected = yield* Deferred.make<void>();
                      projectedTurns.set(turnSequence, projected);
                      yield* SubscriptionRef.set(status, { kind: "running" });
                      yield* SubscriptionRef.update(conversationSnapshot, (current) =>
                        beginAcpConversationTurn(
                          current,
                          turnSequence,
                          prompt,
                          options?.clientUserMessageId ?? null,
                        ),
                      );
                      return yield* runtime.prompt(prompt).pipe(
                        Effect.tap(() => Deferred.await(projected)),
                        Effect.tap(() =>
                          SubscriptionRef.update(status, (current): AcpBackendSessionState =>
                            current.kind === "running" ? { kind: "idle" } : current,
                          ),
                        ),
                        Effect.tapError(projectPromptFailure),
                        Effect.ensuring(
                          Effect.sync(() => {
                            projectedTurns.delete(turnSequence);
                          }),
                        ),
                      );
                    }),
                  ),
                ),
              cancel: requireActive("session.cancel", runtime.cancel),
              setMode: (modeId) =>
                requireActive("session.set-mode", runtime.setMode(modeId)).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (currentModes) currentModes = { ...currentModes, currentModeId: modeId };
                    }),
                  ),
                ),
              setConfigOption: (configId, value) =>
                requireActive(
                  "session.set-config-option",
                  runtime.setConfigOption(configId, value),
                ).pipe(
                  Effect.tap((options) =>
                    Effect.sync(() => {
                      currentConfigOptions = options;
                    }),
                  ),
                ),
            };
            const owned = { scope: sessionScope, active, handle } satisfies OwnedSession;
            yield* Effect.uninterruptible(
              publishSession(input.threadId, owned).pipe(
                Effect.andThen(scheduleIdleEviction(input.threadId)),
                Effect.andThen(
                  runtime.termination.pipe(
                    Effect.catch((error) =>
                      runExclusive(
                        input.threadId,
                        Effect.suspend(() => {
                          if (sessions.get(input.threadId) !== owned) return Effect.void;
                          sessions.delete(input.threadId);
                          return Ref.set(active, false).pipe(
                            Effect.andThen(projectFailure(error)),
                            Effect.andThen(Scope.close(sessionScope, Exit.void)),
                          );
                        }),
                      ),
                    ),
                    Effect.forkIn(ownerScope),
                  ),
                ),
                Effect.asVoid,
              ),
            );
            return handle;
          }),
        ),
      );
    });

    return AcpBackendSessionManager.of({
      open,
      get: (threadId) => Effect.sync(() => sessions.get(threadId)?.handle ?? null),
      observe: (threadId) =>
        Effect.sync(() => observedThreads.add(threadId)).pipe(
          Effect.andThen(FiberMap.remove(idleEvictions, threadId)),
          Effect.asVoid,
        ),
      unobserve: (threadId) =>
        Effect.sync(() => observedThreads.delete(threadId)).pipe(
          Effect.andThen(Effect.suspend(() => scheduleIdleEviction(threadId))),
          Effect.asVoid,
        ),
      close: (threadId) =>
        FiberMap.remove(idleEvictions, threadId).pipe(
          Effect.andThen(
            runExclusive(
              threadId,
              Effect.suspend(() => {
                const owned = sessions.get(threadId);
                return owned === undefined ? Effect.void : closeOwned(threadId, owned);
              }),
            ),
          ),
        ),
      changes: Stream.fromPubSub(changes),
    });
  });

export const live: Layer.Layer<
  AcpBackendSessionManager,
  never,
  AcpAgentLaunchProbe | AcpSessionTransport | ApplicationSettings | MainConfig | TerminalRuntimeMap
> = Layer.effect(AcpBackendSessionManager, make());
