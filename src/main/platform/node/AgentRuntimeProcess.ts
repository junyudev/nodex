import { randomUUID } from "node:crypto";
import type {
  AgentHostRequest,
  AgentHostResult,
  AgentRuntimeConfiguration,
  AgentRuntimeIdentity,
  AgentRuntimeMethod,
  AgentRuntimeNotification,
  AgentRuntimeOperations,
} from "@nodex/agent-runtime/contracts";
import * as Deferred from "effect/Deferred";
import type { Done } from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { z } from "zod";
import { createAgentRuntimeFrameDecoder } from "./agent-runtime-framing";

const MAXIMUM_FRAME_BYTES = 16 * 1024 * 1024;
const MAXIMUM_PENDING_REQUESTS = 64;
const MAXIMUM_PENDING_HOST_REQUESTS = 128;
const identitySchema = z.object({
  runtimeId: z.string().min(1),
  runtimeGeneration: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  databasePath: z.string().min(1),
  mcpEndpoint: z.string().url(),
  lastSequence: z.number().int().nonnegative(),
});
const replySchema = z.discriminatedUnion("success", [
  z.object({ id: z.string(), success: z.literal(true), output: z.unknown() }),
  z.object({
    id: z.string(),
    success: z.literal(false),
    error: z.object({ message: z.string(), tag: z.string().optional() }),
  }),
]);
const notificationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), identity: identitySchema }),
  z.object({
    type: z.literal("event"),
    subscriptionId: z.string(),
    event: z.object({ sequence: z.number().int().nonnegative(), event: z.unknown() }).passthrough(),
  }),
  z.object({ type: z.literal("event.error"), subscriptionId: z.string(), message: z.string() }),
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
  z
    .object({
      type: z.literal("host.request"),
      id: z.string().min(1),
      operation: z.enum(["turn.prepare", "tool.call"]),
      identity: z
        .object({
          runtimeId: z.string().min(1),
          runtimeGeneration: z.string().min(1),
          threadId: z.string().min(1),
          runId: z.string().min(1),
        })
        .passthrough(),
    })
    .passthrough(),
]);

export class AgentRuntimeProcessError extends Schema.TaggedError<AgentRuntimeProcessError>()(
  "AgentRuntimeProcessError",
  {
    reason: Schema.Literals(["closed", "protocol", "pressure", "request", "start"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AgentRuntimeProcessOptions {
  readonly executable: string;
  readonly entryPath: string;
  readonly configuration: AgentRuntimeConfiguration;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly requestTimeoutMs?: number;
  readonly host: (request: AgentHostRequest) => Effect.Effect<unknown, Error>;
}

export interface AgentRuntimeProcessDelivery {
  readonly delivery: number;
  readonly notification: AgentRuntimeNotification;
}

export interface AgentRuntimeProcessConnection {
  readonly identity: AgentRuntimeIdentity;
  readonly terminated: Effect.Effect<AgentRuntimeProcessError>;
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
  const hostRequests = yield* Ref.make<ReadonlySet<string>>(new Set());
  const ready = yield* Deferred.make<AgentRuntimeIdentity, AgentRuntimeProcessError>();
  const terminated = yield* Deferred.make<AgentRuntimeProcessError>();
  const state = yield* Ref.make<{
    readonly closed: AgentRuntimeProcessError | null;
    readonly pending: ReadonlyMap<string, Deferred.Deferred<unknown, AgentRuntimeProcessError>>;
  }>({ closed: null, pending: new Map() });
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
    }));
    yield* Deferred.fail(ready, error);
    yield* Deferred.succeed(terminated, previous.closed ?? error);
    yield* Effect.forEach(previous.pending.values(), (reply) => Deferred.fail(reply, error), {
      discard: true,
    });
  });

  const process = yield* spawner
    .spawn(
      ChildProcess.make(
        options.executable,
        [
          options.entryPath,
          "--home",
          options.configuration.home,
          "--cwd",
          options.configuration.cwd,
        ],
        {
          cwd: options.configuration.cwd,
          detached: true,
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(5),
          env: {
            ...options.environment,
            NODEX_AGENT_RUNTIME_PROVIDER_INSTANCES: JSON.stringify(options.configuration.providers),
            ...(options.configuration.host
              ? {
                  NODEX_AGENT_RUNTIME_HOST_TOOLS: JSON.stringify(options.configuration.host.tools),
                }
              : {}),
          },
          extendEnv: true,
          stdin: Stream.fromQueue(input),
          stdout: "pipe",
          stderr: "inherit",
        },
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new AgentRuntimeProcessError({
            reason: "start",
            message: "Agent Runtime could not start",
            cause,
          }),
      ),
    );

  const accept = Effect.fn("AgentRuntimeProcess.accept")(function* (value: unknown) {
    const reply = replySchema.safeParse(value);
    if (reply.success) {
      const waiter = yield* Ref.get(state).pipe(
        Effect.map((current) => current.pending.get(reply.data.id)),
      );
      if (!waiter) return;
      if (reply.data.success) {
        yield* Deferred.succeed(waiter, reply.data.output);
        return;
      }
      yield* Deferred.fail(
        waiter,
        new AgentRuntimeProcessError({
          reason: "request",
          message: reply.data.error.message,
        }),
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
      yield* Deferred.succeed(ready, notification.identity);
      return;
    }
    if (notification.type !== "host.request") {
      const delivery = yield* Ref.updateAndGet(notificationDelivery, (current) => current + 1);
      yield* PubSub.publish(notifications, { delivery, notification });
      return;
    }
    const admitted = yield* Ref.modify(hostRequests, (current) => {
      if (current.has(notification.id) || current.size >= MAXIMUM_PENDING_HOST_REQUESTS)
        return [false, current] as const;
      return [true, new Set(current).add(notification.id)] as const;
    });
    if (!admitted)
      return yield* new AgentRuntimeProcessError({
        reason: "pressure",
        message: "Agent Runtime Host request capacity is exhausted",
      });
    yield* options.host(notification).pipe(
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
      Effect.ensuring(
        Ref.update(hostRequests, (current) => {
          const next = new Set(current);
          next.delete(notification.id);
          return next;
        }),
      ),
      Effect.forkIn(scope),
    );
  });
  const frames = createAgentRuntimeFrameDecoder(MAXIMUM_FRAME_BYTES);
  yield* process.stdout.pipe(
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
  yield* process.exitCode.pipe(
    Effect.flatMap(() =>
      close(
        new AgentRuntimeProcessError({
          reason: "closed",
          message: "Agent Runtime process exited",
        }),
      ),
    ),
    Effect.catchCause((cause) =>
      close(
        new AgentRuntimeProcessError({
          reason: "closed",
          message: "Agent Runtime process became unavailable",
          cause,
        }),
      ),
    ),
    Effect.forkIn(scope),
  );

  const request = Effect.fn("AgentRuntimeProcess.request")(function* <M extends AgentRuntimeMethod>(
    method: M,
    payload: AgentRuntimeOperations[M]["input"],
  ) {
    const id = yield* Effect.sync(randomUUID);
    const waiter = yield* Deferred.make<unknown, AgentRuntimeProcessError>();
    const refused = yield* Ref.modify(state, (current) => {
      if (current.closed) return [current.closed, current] as const;
      if (current.pending.size >= MAXIMUM_PENDING_REQUESTS)
        return [
          new AgentRuntimeProcessError({
            reason: "pressure",
            message: "Agent Runtime request capacity is exhausted",
          }),
          current,
        ] as const;
      return [null, { ...current, pending: new Map(current.pending).set(id, waiter) }] as const;
    });
    if (refused) return yield* refused;
    return yield* send({ id, method, input: payload }).pipe(
      Effect.andThen(Deferred.await(waiter)),
      Effect.timeout(Duration.millis(options.requestTimeoutMs ?? 30_000)),
      Effect.mapError((cause) =>
        cause instanceof AgentRuntimeProcessError
          ? cause
          : new AgentRuntimeProcessError({
              reason: "request",
              message: "Agent Runtime request timed out",
              cause,
            }),
      ),
      Effect.map((output) => output as AgentRuntimeOperations[M]["output"]),
      Effect.ensuring(
        Ref.update(state, (current) => {
          const next = new Map(current.pending);
          next.delete(id);
          return { ...current, pending: next };
        }),
      ),
    );
  });

  yield* Effect.addFinalizer(() =>
    request("shutdown", {}).pipe(
      Effect.timeout(Duration.seconds(2)),
      Effect.catchCause(() => Effect.void),
      Effect.andThen(
        close(new AgentRuntimeProcessError({ reason: "closed", message: "Runtime Scope closed" })),
      ),
      Effect.andThen(Queue.end(input)),
      Effect.andThen(PubSub.shutdown(notifications)),
    ),
  );
  const identity = yield* Deferred.await(ready).pipe(
    Effect.timeout(Duration.seconds(30)),
    Effect.mapError((cause) =>
      cause instanceof AgentRuntimeProcessError
        ? cause
        : new AgentRuntimeProcessError({
            reason: "start",
            message: "Agent Runtime readiness timed out",
            cause,
          }),
    ),
  );
  return {
    identity,
    terminated: Deferred.await(terminated),
    request,
    notifications: Stream.fromPubSub(notifications),
    subscribeNotifications: PubSub.subscribe(notifications).pipe(
      Effect.map(Stream.fromSubscription),
    ),
  } satisfies AgentRuntimeProcessConnection;
});
