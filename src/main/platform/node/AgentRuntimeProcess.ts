import { withoutAgentShell } from "./agent-shell-environment";
import {
  AGENT_RUNTIME_SHUTDOWN_TIMEOUT_MS,
  AGENT_RUNTIME_FORCE_KILL_AFTER_MS,
  reapAgentRuntimeServers,
} from "@nodex/agent-runtime/process-lifecycle";
import * as Exit from "effect/Exit";
import { decodeAgentAcpFailure, type AgentAcpFailure } from "@nodex/agent-runtime/contracts";
import { randomUUID } from "node:crypto";
import {
  type AgentRuntimeBootstrap,
  type AgentHostRequest,
  type AgentHostResult,
  type AgentRuntimeConfiguration,
  type AgentRuntimeIdentity,
  type AgentRuntimeMethod,
  type AgentRuntimeNotification,
  type AgentRuntimeOperations,
} from "@nodex/agent-runtime/contracts";
import * as Clock from "effect/Clock";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { isAgentRuntimeResponsive, nextAgentRuntimeSilentTicks } from "./agent-runtime-liveness";
import * as Deferred from "effect/Deferred";
import type { Done } from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { z } from "zod";
import { createAgentRuntimeFrameDecoder } from "./agent-runtime-framing";
import { appToolsHostCallTimeoutMs } from "@nodex/app-tools-mcp/manifest";
import { agentProcessLaunch, type AgentRunner } from "../../../host/HostAgentPolicy";

export const RUNTIME_HOME_BUSY = "runtime-home-busy";
const runtimeHomeBusyFrame = z.object({
  type: z.literal(RUNTIME_HOME_BUSY),
  pid: z.number().int().positive().nullable(),
  startedAt: z.iso.datetime().nullable(),
});

const MAXIMUM_FRAME_BYTES = 16 * 1024 * 1024;
/**
 * An 8 MiB young generation keeps ready memory about 60 MiB below V8's default sizing without
 * measurable streaming cost; smaller spaces double scavenge CPU under sustained deltas.
 */
export const AGENT_RUNTIME_NODE_FLAGS = ["--max-semi-space-size=8"] as const;
const MAXIMUM_PENDING_REQUESTS = 64;
const MAXIMUM_WAITING_REQUESTS = 1024;
const LIVENESS_TICK_MS = 5_000;
const SLOW_REQUEST_MS = 10_000;
// Scope release must finish even when the engine cannot answer shutdown.
const SHUTDOWN_TIMEOUT = Duration.millis(AGENT_RUNTIME_SHUTDOWN_TIMEOUT_MS);

const MAXIMUM_PENDING_HOST_REQUESTS = 128;
/**
 * Reads someone is looking at a blank surface for, answered from the execution store alone. Work
 * that is slow by nature, such as generating text or importing history, is deliberately absent.
 */
const WATCHED_READS: ReadonlySet<AgentRuntimeMethod> = new Set<AgentRuntimeMethod>([
  "thread.read",
  "thread.snapshot",
  "thread.control",
  "thread.history",
  "thread.timeline",
  "thread.queue",
  "thread.queued-preview",
  "thread.run-message",
  "thread.questions.list",
  "thread.prompt-index",
  "thread.item",
  "thread.item.full",
  "thread.item.content",
  "thread.attachment",
  "tasks.overview",
  "events.observe",
]);
const identitySchema = z.object({
  runtimeId: z.string().min(1),
  runtimeGeneration: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  databasePath: z.string().min(1),
  mcpEndpoint: z.string().url(),
  lastSequence: z.number().int().nonnegative(),
});
const pongSchema = z.object({ type: z.literal("pong") });
const replySchema = z.discriminatedUnion("success", [
  z.object({ id: z.string(), success: z.literal(true), output: z.unknown() }),
  z.object({
    id: z.string(),
    success: z.literal(false),
    error: z.object({
      message: z.string(),
      tag: z.string().optional(),
      code: z.string().optional(),
      retryable: z.boolean().optional(),
      reason: z.string().optional(),
      acp: z
        .unknown()
        .transform((value, context) => {
          const failure = decodeAgentAcpFailure(value);
          if (failure) return failure;
          context.addIssue({ code: "custom", message: "Invalid ACP failure envelope" });
          return z.NEVER;
        })
        .optional(),
    }),
  }),
]);
const hostIdentitySchema = z.object({
  runtimeId: z.string().min(1),
  runtimeGeneration: z.string().min(1),
});
const hostToolIdentitySchema = z.union([
  hostIdentitySchema
    .extend({ threadId: z.string().min(1), runId: z.string().min(1) })
    .passthrough(),
  hostIdentitySchema
    .extend({
      threadId: z.string().min(1),
      source: z.literal("native-session"),
      runId: z.null(),
      attemptId: z.null(),
      incarnationId: z.string().min(1),
      providerSessionId: z.string().min(1),
      nativeGeneration: z.number().int().positive(),
    })
    .passthrough(),
]);
const hostRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      type: z.literal("host.request"),
      id: z.string().min(1),
      operation: z.literal("turn.prepare"),
      identity: hostIdentitySchema
        .extend({ threadId: z.string().min(1), runId: z.string().min(1) })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("host.request"),
      id: z.string().min(1),
      operation: z.literal("tool.call"),
      identity: hostToolIdentitySchema,
    })
    .passthrough(),
  z.object({
    type: z.literal("host.request"),
    id: z.string().min(1),
    operation: z.literal("desktop.skill-roots"),
    identity: hostIdentitySchema.extend({
      providerInstanceId: z.string().min(1),
      nativeDriver: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("host.request"),
    id: z.string().min(1),
    operation: z.literal("thread.prepare"),
    identity: hostIdentitySchema.extend({
      threadId: z.string().min(1),
      providerInstanceId: z.string().min(1),
      nativeDriver: z.string().min(1),
    }),
    cwd: z.string().nullable(),
  }),
  z.object({
    type: z.literal("host.request"),
    id: z.string().min(1),
    operation: z.literal("turn.native"),
    identity: hostIdentitySchema
      .extend({ threadId: z.string().min(1), runId: z.string().min(1) })
      .passthrough(),
    nativeThreadId: z.string().min(1),
    nativeTurnId: z.string().min(1),
    phase: z.enum(["started", "ended"]),
  }),
]);
// An engine frame this schema rejects ends the connection, so every host operation is admitted.
type UnadmittedHostOperation = Exclude<
  AgentHostRequest["operation"],
  z.infer<typeof hostRequestSchema>["operation"]
>;
const everyHostOperationAdmitted: [UnadmittedHostOperation] extends [never]
  ? true
  : UnadmittedHostOperation = true;
void everyHostOperationAdmitted;
const nativeSourceSchema = z.object({
  runtimeGeneration: z.string(),
  threadId: z.string(),
  providerSessionId: z.string(),
  nativeGeneration: z.number().int(),
  providerThreadId: z.string(),
  nativeThreadId: z.string(),
});
const notificationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("host.cancel"),
    id: z.string().min(1),
    runtimeId: z.string().min(1),
    runtimeGeneration: z.string().min(1),
  }),
  z.object({
    type: z.literal("native.voice.event"),
    claimId: z.string(),
    source: nativeSourceSchema,
    notification: z.object({ method: z.string(), params: z.unknown() }),
  }),
  z.object({
    type: z.literal("native.voice.closed"),
    claimId: z.string(),
    source: nativeSourceSchema,
  }),
  z.object({
    type: z.literal("product-analytics"),
    name: z.string().min(1).max(128),
    properties: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal("ready"), identity: identitySchema }),
  z.object({
    type: z.literal("event"),
    subscriptionId: z.string(),
    event: z.object({ sequence: z.number().int().nonnegative(), event: z.unknown() }).passthrough(),
  }),
  z.object({ type: z.literal("event.error"), subscriptionId: z.string(), message: z.string() }),
  z.object({
    type: z.literal("activity"),
    rootThreadId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("execution.native-session.closed"),
    runtimeId: z.string().min(1),
    runtimeGeneration: z.string().min(1),
    providerSessionId: z.string().min(1),
    nativeGeneration: z.number().int().positive(),
    incarnationId: z.string().min(1),
  }),
  z.object({
    type: z.literal("execution.lifecycle"),
    subscriptionId: z.string(),
    runtimeGeneration: z.string(),
    sequence: z.number().int().nonnegative(),
    threadId: z.string(),
    eventType: z.enum(["run.updated", "thread.deleted"]),
    runId: z.string().optional(),
    runStatus: z.string().optional(),
  }),
  hostRequestSchema,
]);

export class AgentRuntimeProcessError extends Schema.TaggedError<AgentRuntimeProcessError>()(
  "AgentRuntimeProcessError",
  {
    reason: Schema.Literals([
      "closed",
      "protocol",
      "pressure",
      "host-deadline",
      "rejected",
      "start",
    ]),
    message: Schema.String,
    /** The engine failure's tag when the engine rejected a request. */
    engineTag: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String),
    retryable: Schema.optional(Schema.Boolean),
    engineReason: Schema.optional(Schema.String),
    acp: Schema.optional(
      Schema.declare<AgentAcpFailure>(
        (value): value is AgentAcpFailure => decodeAgentAcpFailure(value) !== null,
      ),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AgentRuntimeProcessOptions {
  readonly executable: string;
  readonly agentRunner?: AgentRunner;
  readonly entryPath: string;
  readonly configuration: AgentRuntimeConfiguration;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly profileHome?: string;
  /** Internal scheduler interval; production uses the default. */
  readonly livenessTickMs?: number;
  readonly host: (request: AgentHostRequest) => Effect.Effect<unknown, Error>;
  readonly productEvent?: (
    name: string,
    properties: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
}

export interface AgentRuntimeProcessDelivery {
  readonly delivery: number;
  readonly notification: AgentRuntimeNotification;
}

export interface AgentRuntimeProcessConnection {
  readonly identity: AgentRuntimeIdentity;
  readonly terminated: Effect.Effect<AgentRuntimeProcessError>;
  /** Current responsiveness followed by changes; silence never retires the process. */
  readonly responsive: Stream.Stream<boolean>;
  readonly request: <M extends AgentRuntimeMethod>(
    method: M,
    input: AgentRuntimeOperations[M]["input"],
  ) => Effect.Effect<AgentRuntimeOperations[M]["output"], AgentRuntimeProcessError>;
  /** A skipped delivery requires resuming persisted events from the owner's cursor. */
  readonly notifications: Stream.Stream<AgentRuntimeProcessDelivery>;
  /** Acquire before replay admission; constructing a lazy Stream does not subscribe. */
  readonly subscribeNotifications: Effect.Effect<
    Stream.Stream<AgentRuntimeProcessDelivery>,
    never,
    Scope.Scope
  >;
  /** Independent metadata delivery budget; transcript bursts cannot evict lifecycle observations. */
  readonly subscribeExecutionNotifications: Effect.Effect<
    Stream.Stream<AgentRuntimeProcessDelivery>,
    never,
    Scope.Scope
  >;
}

/** The process, pending replies, input queue and host callbacks share the caller's Scope. */
export const acquireAgentRuntimeProcess = Effect.fn("AgentRuntimeProcess.acquire")(function* (
  options: AgentRuntimeProcessOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const input = yield* Queue.make<Uint8Array, Done>({ capacity: 8 });
  // Event consumers cannot hold up control replies or the awaited Host preparation.
  // Sliding delivery is bounded; its independent counter makes every gap observable.
  const notifications = yield* PubSub.sliding<{
    readonly delivery: number;
    readonly notification: AgentRuntimeNotification;
  }>(256);
  const notificationDelivery = yield* Ref.make(0);
  const executionNotifications = yield* PubSub.sliding<AgentRuntimeProcessDelivery>(64);
  const executionDelivery = yield* Ref.make(0);
  const hostRequests = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<void>>>(new Map());
  const ready = yield* Deferred.make<AgentRuntimeIdentity, AgentRuntimeProcessError>();
  const terminated = yield* Deferred.make<AgentRuntimeProcessError>();
  type Pending = {
    readonly reply: Deferred.Deferred<unknown, AgentRuntimeProcessError>;
    readonly admitted: Deferred.Deferred<void, AgentRuntimeProcessError>;
    readonly bypass: boolean;
    /**
     * The tick a watched read began, including its time waiting for admission. Cleared when its
     * caller stops waiting: its slot stays until the reply, but nobody is looking at it anymore.
     */
    readStartedTick: number | null;
  };
  const responsiveness = yield* SubscriptionRef.make(true);
  let receivedFrame = false;
  let receivedReady = false;
  let silentTicks = 0;
  let tick = 0;
  let pingOutstanding = false;
  const reportResponsive = (value: boolean) =>
    Effect.gen(function* () {
      if ((yield* SubscriptionRef.get(responsiveness)) === value) return;
      yield* SubscriptionRef.set(responsiveness, value);
      yield* Effect.logWarning(
        value ? "Agent Runtime became responsive" : "Agent Runtime became unresponsive",
      );
    });
  interface ProcessState {
    readonly closed: AgentRuntimeProcessError | null;
    readonly pending: ReadonlyMap<string, Pending>;
    readonly waiting: ReadonlyMap<string, Pending>;
  }
  const state = yield* Ref.make<ProcessState>({
    closed: null,
    pending: new Map(),
    waiting: new Map(),
  });
  const reportLiveness = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    let oldestReadAgeTicks = 0;
    for (const entry of [...current.pending.values(), ...current.waiting.values()])
      if (entry.readStartedTick !== null)
        oldestReadAgeTicks = Math.max(oldestReadAgeTicks, tick - entry.readStartedTick);
    yield* reportResponsive(isAgentRuntimeResponsive(silentTicks, oldestReadAgeTicks));
  });
  /** A frame can only restore responsiveness, so the common responsive path stays free. */
  const recheckLiveness = SubscriptionRef.get(responsiveness).pipe(
    Effect.flatMap((responsive) => (responsive ? Effect.void : reportLiveness)),
  );
  const scope = yield* Effect.scope;
  const encode = (value: unknown) => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    if (bytes.byteLength > MAXIMUM_FRAME_BYTES)
      throw new Error("Agent Runtime request exceeds the transport budget");
    return bytes;
  };
  const send = (value: unknown) =>
    Effect.try({
      try: () => encode(value),
      catch: (cause) =>
        new AgentRuntimeProcessError({
          reason: "protocol",
          message: "Invalid runtime request",
          cause,
        }),
    }).pipe(
      Effect.flatMap((bytes) => Queue.offer(input, bytes)),
      Effect.asVoid,
    );

  const close = Effect.fn("AgentRuntimeProcess.close")(function* (error: AgentRuntimeProcessError) {
    const previous = yield* Ref.getAndUpdate(state, (current) => ({
      closed: current.closed ?? error,
      pending: new Map(),
      waiting: new Map(),
    }));
    yield* Deferred.fail(ready, error);
    yield* Deferred.succeed(terminated, previous.closed ?? error);
    yield* Effect.forEach(
      [...previous.pending.values(), ...previous.waiting.values()],
      (entry) =>
        Deferred.fail(entry.admitted, error).pipe(
          Effect.andThen(Deferred.fail(entry.reply, error)),
        ),
      { discard: true },
    );
    yield* Effect.forEach(
      (yield* Ref.get(hostRequests)).values(),
      (cancelled) => Deferred.succeed(cancelled, undefined),
      { discard: true },
    ).pipe(Effect.uninterruptible);
  });

  // The first frame configures providers before readiness; it is queued ahead of every request.
  yield* send({
    type: "bootstrap",
    automaticWorkAtOnce: options.configuration.automaticWorkAtOnce,
    pausedThreadIds: options.configuration.pausedThreadIds,
    providers: options.configuration.providers,
    modelPolicy: options.configuration.modelPolicy,
    ...(options.configuration.host ? { hostTools: options.configuration.host.tools } : {}),
  } satisfies AgentRuntimeBootstrap);
  const launch = agentProcessLaunch(
    options.executable,
    [
      ...AGENT_RUNTIME_NODE_FLAGS,
      options.entryPath,
      "--home",
      options.configuration.home,
      "--cwd",
      options.configuration.cwd,
    ],
    options.agentRunner,
  );
  const processScope = yield* Scope.fork(scope);
  const process = yield* spawner
    .spawn(
      ChildProcess.make(launch.executable, launch.args, {
        cwd: options.configuration.cwd,
        detached: true,
        killSignal: "SIGTERM",
        forceKillAfter: Duration.millis(AGENT_RUNTIME_FORCE_KILL_AFTER_MS),
        // Exactly the composed environment; provider credentials arrive over stdin instead.
        env: {
          ...withoutAgentShell({ ...options.environment }),
          NODEX_AGENT_PROFILE_HOME: options.profileHome,
        },
        extendEnv: false,
        stdin: Stream.fromQueue(input),
        stdout: "pipe",
        stderr: "inherit",
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, processScope),
      Effect.mapError(
        (cause) =>
          new AgentRuntimeProcessError({
            reason: "start",
            message: "Agent Runtime could not start",
            cause,
          }),
      ),
    );

  // A slot belongs to engine work until its reply, even if its caller stops waiting.
  const release = (id: string) =>
    Effect.gen(function* () {
      const promoted = yield* Ref.modify(state, (current) => {
        const entry = current.pending.get(id);
        const pending = new Map(current.pending);
        const waiting = new Map(current.waiting);
        pending.delete(id);
        waiting.delete(id);
        const next = entry && !entry.bypass ? waiting.entries().next().value : undefined;
        if (next) {
          waiting.delete(next[0]);
          pending.set(...next);
        }
        return [next?.[1], { ...current, pending, waiting }] as const;
      });
      if (promoted) yield* Deferred.succeed(promoted.admitted, undefined);
    });

  const accept = Effect.fn("AgentRuntimeProcess.accept")(function* (value: unknown) {
    receivedFrame = true;
    silentTicks = 0;
    yield* recheckLiveness;
    if (pongSchema.safeParse(value).success) {
      pingOutstanding = false;
      return;
    }
    const reply = replySchema.safeParse(value);
    if (reply.success) {
      const waiter = yield* Ref.get(state).pipe(
        Effect.map((current) => current.pending.get(reply.data.id)),
      );
      if (!waiter) return;
      yield* release(reply.data.id);
      yield* recheckLiveness;
      if (reply.data.success) {
        yield* Deferred.succeed(waiter.reply, reply.data.output);
        return;
      }
      yield* Deferred.fail(
        waiter.reply,
        new AgentRuntimeProcessError({
          reason: "rejected",
          message: reply.data.error.message,
          ...(reply.data.error.code === undefined ? {} : { code: reply.data.error.code }),
          ...(reply.data.error.retryable === undefined
            ? {}
            : { retryable: reply.data.error.retryable }),
          ...(reply.data.error.tag === undefined ? {} : { engineTag: reply.data.error.tag }),
          ...(reply.data.error.reason === undefined
            ? {}
            : { engineReason: reply.data.error.reason }),
          ...(reply.data.error.acp === undefined ? {} : { acp: reply.data.error.acp }),
        }),
      );
      return;
    }
    const busy = runtimeHomeBusyFrame.safeParse(value);
    if (busy.success && !receivedReady) {
      const { pid, startedAt } = busy.data;
      const owner = [pid === null ? null : `pid ${pid}`, startedAt ? `started ${startedAt}` : null]
        .filter(Boolean)
        .join(", ");
      const message =
        pid === null
          ? "Another Nodex is starting or stopping Agents for this Profile. Try again shortly."
          : `Another Nodex is already running Agents for this Profile (${owner}). Quit it and try again.`;
      yield* close(
        new AgentRuntimeProcessError({ reason: "start", code: RUNTIME_HOME_BUSY, message }),
      );
      return;
    }
    const decoded = notificationSchema.safeParse(value);
    if (!decoded.success)
      return yield* new AgentRuntimeProcessError({
        reason: "protocol",
        message: "Agent Runtime returned an invalid transport frame",
      });
    const notification = decoded.data as AgentRuntimeNotification;
    if (notification.type === "ready") {
      receivedReady = true;
      yield* Deferred.succeed(ready, notification.identity);
      return;
    }
    if (notification.type === "product-analytics") {
      if (options.productEvent)
        yield* options.productEvent(notification.name, notification.properties);
      return;
    }
    if (notification.type === "host.cancel") {
      const identity = yield* Deferred.await(ready);
      if (
        notification.runtimeId !== identity.runtimeId ||
        notification.runtimeGeneration !== identity.runtimeGeneration
      )
        return;
      const cancelled = (yield* Ref.get(hostRequests)).get(notification.id);
      if (cancelled) yield* Deferred.succeed(cancelled, undefined);
      return;
    }
    if (notification.type !== "host.request") {
      if (
        notification.type === "execution.lifecycle" ||
        notification.type === "execution.native-session.closed" ||
        notification.type === "activity" ||
        notification.type === "event.error"
      ) {
        const delivery = yield* Ref.updateAndGet(executionDelivery, (current) => current + 1);
        yield* PubSub.publish(executionNotifications, { delivery, notification });
      }
      const delivery = yield* Ref.updateAndGet(notificationDelivery, (current) => current + 1);
      yield* PubSub.publish(notifications, { delivery, notification });
      return;
    }
    const cancelled = yield* Deferred.make<void>();
    const admitted = yield* Ref.modify(hostRequests, (current) => {
      if (current.has(notification.id) || current.size >= MAXIMUM_PENDING_HOST_REQUESTS)
        return [false, current] as const;
      return [true, new Map(current).set(notification.id, cancelled)] as const;
    });
    if (!admitted)
      return yield* new AgentRuntimeProcessError({
        reason: "pressure",
        message: "Agent Runtime Host request capacity is exhausted",
      });
    const work =
      notification.operation === "tool.call"
        ? options.host(notification).pipe(
            Effect.timeoutOrElse({
              duration: appToolsHostCallTimeoutMs(
                notification.tool,
                notification.input !== null &&
                  typeof notification.input === "object" &&
                  !Array.isArray(notification.input)
                  ? (notification.input as Record<string, unknown>)
                  : {},
              ),
              orElse: () =>
                Effect.fail(
                  new AgentRuntimeProcessError({
                    reason: "host-deadline",
                    message: "Application tool host deadline elapsed",
                  }),
                ),
            }),
          )
        : options.host(notification);
    yield* Effect.raceFirst(
      work.pipe(
        Effect.matchEffect({
          onSuccess: (output) =>
            send({
              type: "host.result",
              id: notification.id,
              success: true,
              output,
            } satisfies AgentHostResult),
          onFailure: (error) =>
            send({
              type: "host.result",
              id: notification.id,
              success: false,
              error: { message: error.message },
            } satisfies AgentHostResult),
        }),
        Effect.catch((error) => close(error)),
      ),
      Deferred.await(cancelled),
    ).pipe(
      Effect.ensuring(
        Ref.update(hostRequests, (current) => {
          const next = new Map(current);
          next.delete(notification.id);
          return next;
        }),
      ),
      Effect.forkIn(scope),
    );
  });
  const frames = createAgentRuntimeFrameDecoder(MAXIMUM_FRAME_BYTES);
  const output = yield* process.stdout.pipe(
    Stream.mapEffect((chunk) =>
      Effect.try({
        try: () => frames.push(chunk),
        catch: (cause) =>
          new AgentRuntimeProcessError({
            reason: "protocol",
            message: "Agent Runtime stream could not be decoded",
            cause,
          }),
      }),
    ),
    Stream.flatMap(Stream.fromIterable),
    Stream.runForEach(accept),
    Effect.andThen(
      Effect.try({
        try: () => frames.finish(),
        catch: (cause) =>
          new AgentRuntimeProcessError({
            reason: "protocol",
            message: "Agent Runtime ended with an incomplete frame",
            cause,
          }),
      }),
    ),
    Effect.catchCause((cause) =>
      close(
        new AgentRuntimeProcessError({
          reason: "protocol",
          message: "Agent Runtime connection ended",
          cause,
        }),
      ),
    ),
    Effect.forkIn(scope),
  );
  const reapServers = reapAgentRuntimeServers(options.configuration.home, Number(process.pid));
  yield* Effect.exit(process.exitCode).pipe(
    Effect.flatMap((exit) =>
      // A child may exit before the final startup failure frame reaches the pipe reader.
      (receivedReady
        ? Effect.void
        : Fiber.await(output).pipe(Effect.timeoutOption("500 millis"), Effect.asVoid)
      ).pipe(
        Effect.andThen(reapServers),
        Effect.andThen(
          close(
            new AgentRuntimeProcessError({
              reason: "closed",
              message: "Agent Runtime process exited",
              ...(Exit.isFailure(exit) ? { cause: exit.cause } : {}),
            }),
          ),
        ),
      ),
    ),
    Effect.forkIn(scope),
  );

  /**
   * Settles on its reply or on the end of the process. A local pipe does not lose frames, so elapsed
   * time cannot tell slow from stuck here; a caller that needs a bound applies its own.
   */
  const request = Effect.fn("AgentRuntimeProcess.request")(function* <M extends AgentRuntimeMethod>(
    method: M,
    payload: AgentRuntimeOperations[M]["input"],
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    const id = yield* Effect.sync(randomUUID);
    const reply = yield* Deferred.make<unknown, AgentRuntimeProcessError>();
    const admitted = yield* Deferred.make<void, AgentRuntimeProcessError>();
    const entry: Pending = {
      reply,
      admitted,
      // Releasing an observer frees engine work, so it must not wait behind that work.
      bypass: method === "shutdown" || method === "events.unobserve",
      readStartedTick: WATCHED_READS.has(method) ? tick : null,
    };
    let sent = false;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const admission = yield* Ref.modify(
          state,
          (current): readonly [boolean | AgentRuntimeProcessError, ProcessState] => {
            if (current.closed) return [current.closed, current] as const;
            const active = [...current.pending.values()].filter((value) => !value.bypass).length;
            if (entry.bypass || active < MAXIMUM_PENDING_REQUESTS)
              return [
                true,
                { ...current, pending: new Map(current.pending).set(id, entry) },
              ] as const;
            if (current.waiting.size >= MAXIMUM_WAITING_REQUESTS)
              return [
                new AgentRuntimeProcessError({
                  reason: "pressure",
                  message: "Agent Runtime request capacity is exhausted",
                }),
                current,
              ] as const;
            return [
              false,
              { ...current, waiting: new Map(current.waiting).set(id, entry) },
            ] as const;
          },
        );
        if (admission instanceof AgentRuntimeProcessError) return yield* admission;
        const work = Effect.uninterruptibleMask((resume) =>
          Effect.gen(function* () {
            if (!admission) yield* resume(Deferred.await(admitted));
            // Queue admission and the sent flag are atomic with respect to caller interruption.
            yield* resume(send({ id, method, input: payload })).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  sent = true;
                }),
              ),
            );
            return yield* resume(Deferred.await(reply));
          }),
        );
        return yield* restore(
          Effect.raceFirst(work, Deferred.await(terminated).pipe(Effect.flatMap(Effect.fail))),
        ).pipe(
          Effect.map((output) => output as AgentRuntimeOperations[M]["output"]),
          Effect.onInterrupt(() => {
            if (!sent) return Effect.void;
            const abandon =
              method === "text.generate-structured"
                ? send({ type: "request.cancel", id })
                : method === "events.observe"
                  ? // An observer's subscription is its request ID, known even without the reply.
                    send({
                      id: randomUUID(),
                      method: "events.unobserve",
                      input: { subscriptionId: id },
                    })
                  : null;
            return abandon
              ? abandon.pipe(
                  Effect.catchCause(() => Effect.void),
                  Effect.forkIn(scope, { startImmediately: true }),
                  Effect.asVoid,
                )
              : Effect.void;
          }),
          Effect.ensuring(
            Effect.gen(function* () {
              entry.readStartedTick = null;
              if (!sent) yield* release(id);
              yield* recheckLiveness;
              const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
              if (elapsedMs >= SLOW_REQUEST_MS)
                yield* Effect.logWarning("Agent Runtime request settled slowly").pipe(
                  Effect.annotateLogs({ method, elapsedMs }),
                );
            }),
          ),
        );
      }),
    );
  });

  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(options.livenessTickMs ?? LIVENESS_TICK_MS);
      const current = yield* Ref.get(state);
      if (current.closed) return;
      tick += 1;
      silentTicks = nextAgentRuntimeSilentTicks(
        silentTicks,
        current.pending.size > 0,
        receivedFrame,
      );
      receivedFrame = false;
      yield* reportLiveness;
      if (current.pending.size === 0 || pingOutstanding) continue;
      pingOutstanding = Queue.offerUnsafe(input, encode({ type: "ping" }));
    }
  }).pipe(Effect.forkIn(scope));

  yield* Effect.addFinalizer(() =>
    request("shutdown", {}).pipe(
      Effect.timeout(SHUTDOWN_TIMEOUT),
      Effect.catchCause(() => Effect.void),
      Effect.andThen(
        close(new AgentRuntimeProcessError({ reason: "closed", message: "Runtime Scope closed" })),
      ),
      Effect.andThen(Queue.end(input)),
      Effect.andThen(Scope.close(processScope, Exit.void)),
      Effect.andThen(reapServers),
      Effect.andThen(PubSub.shutdown(notifications)),
      Effect.andThen(PubSub.shutdown(executionNotifications)),
    ),
  );
  const identity = yield* Deferred.await(ready);
  return {
    identity,
    terminated: Deferred.await(terminated),
    responsive: SubscriptionRef.changes(responsiveness),
    request,
    notifications: Stream.fromPubSub(notifications),
    subscribeNotifications: PubSub.subscribe(notifications).pipe(
      Effect.map(Stream.fromSubscription),
    ),
    subscribeExecutionNotifications: PubSub.subscribe(executionNotifications).pipe(
      Effect.map(Stream.fromSubscription),
    ),
  } satisfies AgentRuntimeProcessConnection;
});
