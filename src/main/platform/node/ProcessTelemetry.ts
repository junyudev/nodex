import { Worker } from "node:worker_threads";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ProcessSample, ProcessSampleRequest } from "../../process-telemetry/process-sampler";
import {
  isProcessTelemetryWorkerMessage,
  type ProcessTelemetryHostMessage,
} from "../../process-telemetry/process-telemetry-protocol";

/** A sampler nobody asked for in this long releases its thread. */
const IDLE_RELEASE_MS = 30_000;
/** Longer than the worker's own `ps` and PowerShell timeouts. */
const SAMPLE_TIMEOUT_MS = 15_000;
/** Requests within one Process Manager refresh share a table; the next refresh reads anew. */
const TERMINAL_TABLE_MAX_AGE_MS = 750;

export class ProcessTelemetryError extends Schema.TaggedError<ProcessTelemetryError>()(
  "ProcessTelemetryError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * Process CPU and memory, read off Main by one shared worker. The worker exists only while
 * someone samples, and concurrent requests share one read of the process table.
 */
export class ProcessTelemetry extends Context.Service<
  ProcessTelemetry,
  {
    readonly sample: (
      request: ProcessSampleRequest,
    ) => Effect.Effect<ProcessSample, ProcessTelemetryError>;
  }
>()("nodex/main/platform/node/ProcessTelemetry") {}

export interface ProcessTelemetryWorker {
  readonly send: (message: ProcessTelemetryHostMessage) => void;
  readonly onMessage: (listener: (message: unknown) => void) => void;
  readonly onError: (listener: (error: Error) => void) => void;
  readonly onExit: (listener: (code: number) => void) => void;
  readonly terminate: () => void;
}

interface Pending {
  readonly resolve: (sample: ProcessSample) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Session {
  readonly worker: ProcessTelemetryWorker;
  readonly pending: Map<number, Pending>;
  idle: ReturnType<typeof setTimeout> | null;
}

export function createProcessTelemetryClient(options: {
  readonly create: () => ProcessTelemetryWorker;
  readonly idleReleaseMs?: number;
  readonly sampleTimeoutMs?: number;
}) {
  const idleReleaseMs = options.idleReleaseMs ?? IDLE_RELEASE_MS;
  const sampleTimeoutMs = options.sampleTimeoutMs ?? SAMPLE_TIMEOUT_MS;
  let current: Session | null = null;
  let nextId = 1;
  let closed = false;

  const release = (session: Session, error: Error) => {
    if (current === session) current = null;
    if (session.idle) clearTimeout(session.idle);
    for (const entry of session.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    session.pending.clear();
    session.worker.terminate();
  };

  const open = (): Session => {
    if (current) return current;
    const session: Session = { worker: options.create(), pending: new Map(), idle: null };
    session.worker.onMessage((message) => {
      if (!isProcessTelemetryWorkerMessage(message))
        return release(session, new Error("Process telemetry sent an invalid message"));
      const entry = session.pending.get(message.id);
      if (!entry) return;
      session.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.type === "sampled") entry.resolve(message.sample);
      else entry.reject(new Error(message.message));
      if (session.pending.size === 0 && current === session)
        session.idle = setTimeout(
          () => release(session, new Error("Process telemetry was released")),
          idleReleaseMs,
        );
    });
    session.worker.onError((error) => release(session, error));
    session.worker.onExit((code) =>
      release(session, new Error(`Process telemetry stopped with code ${String(code)}`)),
    );
    current = session;
    return session;
  };

  return {
    sample(request: ProcessSampleRequest): Promise<ProcessSample> {
      if (closed) return Promise.reject(new Error("Process telemetry is shutting down"));
      const session = open();
      if (session.idle) clearTimeout(session.idle);
      session.idle = null;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => release(session, new Error("Process telemetry did not answer")),
          sampleTimeoutMs,
        );
        session.pending.set(id, { resolve, reject, timer });
        try {
          session.worker.send({ type: "sample", id, request });
        } catch (cause) {
          release(session, cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
    },
    close() {
      closed = true;
      if (current) release(current, new Error("Process telemetry is shutting down"));
    },
  };
}

const createNodeWorker = (workerPath: string): ProcessTelemetryWorker => {
  const worker = new Worker(workerPath, {
    name: "process-telemetry",
    resourceLimits: { maxOldGenerationSizeMb: 64 },
  });
  // Main's exit never waits for an idle sampler.
  worker.unref();
  return {
    send: (message) => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads messages do not accept a target origin.
      worker.postMessage(message);
    },
    onMessage: (listener) => void worker.on("message", listener),
    onError: (listener) => void worker.on("error", listener),
    onExit: (listener) => void worker.on("exit", listener),
    terminate: () => void worker.terminate(),
  };
};

export const layer = (options: {
  readonly create: () => ProcessTelemetryWorker;
}): Layer.Layer<ProcessTelemetry> =>
  Layer.effect(
    ProcessTelemetry,
    Effect.acquireRelease(
      Effect.sync(() => createProcessTelemetryClient(options)),
      (client) => Effect.sync(() => client.close()),
    ).pipe(
      Effect.map((client) =>
        ProcessTelemetry.of({
          sample: (request) =>
            Effect.tryPromise({
              try: () => client.sample(request),
              catch: (cause) =>
                new ProcessTelemetryError({ message: "Could not read process telemetry", cause }),
            }),
        }),
      ),
    ),
  );

export const live: Layer.Layer<ProcessTelemetry> = layer({
  create: () => createNodeWorker(`${__dirname}/process-telemetry-worker.js`),
});

export interface TerminalProcessMetricsSnapshot {
  readonly cpuPercent: number | null;
  readonly rssKb: bigint | null;
  readonly childProcessCount: number;
  readonly sampledAtMs: number;
}

/** What runs under each Terminal's shell, excluding the shell itself. */
export const readTerminalProcessMetrics = (
  telemetry: ProcessTelemetry["Service"],
  rootPids: readonly number[],
): Effect.Effect<ReadonlyMap<number, TerminalProcessMetricsSnapshot>, ProcessTelemetryError> =>
  telemetry
    .sample({
      baseline: "terminals",
      maxAgeMs: TERMINAL_TABLE_MAX_AGE_MS,
      groups: [...new Set(rootPids)].map((pid) => ({
        key: String(pid),
        roots: [{ pid, self: false, descendants: true }],
      })),
    })
    .pipe(
      Effect.map(
        (sample) =>
          new Map(
            sample.groups.map((group) => [
              Number(group.key),
              {
                cpuPercent: group.cpuPercent,
                rssKb: group.rssKb === null ? null : BigInt(group.rssKb),
                childProcessCount: group.processes,
                sampledAtMs: sample.sampledAtMs,
              },
            ]),
          ),
      ),
    );
