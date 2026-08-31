/* oxlint-disable effecttsgo/async-function -- Probe consumers are Promise/EventEmitter based external harnesses; this adapter is the one conversion seam around an Effect-owned session. */
import { EventEmitter } from "node:events";
import { delimiter as pathDelimiter } from "node:path";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { V1InitializeResponse } from "@nodex/effect-codex-app-server/schema";
import {
  ScopedCallbackRuntime,
  layer as scopedCallbackRuntimeLive,
} from "../src/main/app/ScopedCallbackRuntime";
import {
  CodexAppServerSession,
  live as codexAppServerSessionLive,
} from "../src/main/codex-runtime/CodexAppServerSession";
import { CodexRpcError } from "../src/main/codex-runtime/CodexRpcError";
import type { CodexRuntimeError } from "../src/main/codex-runtime/CodexRuntimeError";
import * as CodexSessionTransport from "../src/main/platform/node/CodexSessionTransport";
import { standaloneCodexAppServerArgs } from "../src/shared/codex-app-server-launch";

export interface CodexProbeSessionOptions {
  readonly additionalSearchPaths?: readonly string[];
  readonly args?: readonly string[];
  readonly binaryPath: string;
  readonly clientInfo: {
    readonly name: string;
    readonly title: string;
    readonly version: string;
  };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly expectedCodexHome?: string;
  readonly initializeTimeout?: Duration.Input;
  readonly requestTimeout?: Duration.Input;
}

export interface CodexProbeClient {
  readonly getInitializeResponse: () => V1InitializeResponse;
  request<TMethod extends string, A>(method: TMethod, params?: unknown): Promise<A>;
  request<A = unknown>(method: string, params?: unknown): Promise<A>;
  readonly notify: (method: string, params?: unknown) => Promise<void>;
  readonly on: (
    event: "notification",
    listener: (notification: ServerNotification) => void,
  ) => void;
  readonly off: (
    event: "notification",
    listener: (notification: ServerNotification) => void,
  ) => void;
}

export interface CodexProbeSessionLease extends CodexProbeClient {
  readonly pid: number;
  readonly stop: () => Promise<void>;
}

export class CodexProbeError extends Schema.TaggedError<CodexProbeError>()("CodexProbeError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

const isRequestError = Schema.is(CodexAppServerRequestError);

const toPromiseError = (error: unknown): unknown => {
  if (!isRequestError(error)) return error;
  return new CodexRpcError(error.message, error.code, error.data);
};

const withSearchPath = (
  env: Readonly<Record<string, string | undefined>>,
  additionalSearchPaths: readonly string[],
): Readonly<Record<string, string | undefined>> => {
  if (additionalSearchPaths.length === 0) return env;
  const inherited = env.PATH?.split(pathDelimiter).filter(Boolean) ?? [];
  return {
    ...env,
    PATH: [...new Set([...additionalSearchPaths, ...inherited])].join(pathDelimiter),
  };
};

class ProbeClientBridge extends EventEmitter implements CodexProbeClient {
  readonly #callbacks: ScopedCallbackRuntime["Service"];
  readonly #requestTimeout: Duration.Input;
  readonly #session: CodexAppServerSession["Service"];
  readonly pid: number;

  constructor(
    session: CodexAppServerSession["Service"],
    callbacks: ScopedCallbackRuntime["Service"],
    requestTimeout: Duration.Input,
  ) {
    super();
    this.#session = session;
    this.#callbacks = callbacks;
    this.#requestTimeout = requestTimeout;
    this.pid = session.pid;
  }

  getInitializeResponse(): V1InitializeResponse {
    return this.#session.initialize;
  }

  async request<TMethod extends string, A>(method: TMethod, params?: unknown): Promise<A>;
  async request<A = unknown>(method: string, params?: unknown): Promise<A>;
  async request<A = unknown>(method: string, params?: unknown): Promise<A> {
    return (await this.#callbacks
      .runPromise(
        this.#session.client.raw.request(method, params).pipe(Effect.timeout(this.#requestTimeout)),
      )
      .catch((error: unknown) => Promise.reject(toPromiseError(error)))) as A;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.#callbacks
      .runPromise(this.#session.client.raw.notify(method, params))
      .catch((error: unknown) => Promise.reject(toPromiseError(error)));
  }

  observeNotification(method: string, params: unknown): void {
    this.emit("notification", { method, params } as ServerNotification);
  }

  override on(event: "notification", listener: (notification: ServerNotification) => void): this {
    return super.on(event, listener);
  }

  override off(event: "notification", listener: (notification: ServerNotification) => void): this {
    return super.off(event, listener);
  }
}

const acquireProbeClient = (
  options: CodexProbeSessionOptions,
  callbacks: ScopedCallbackRuntime["Service"],
): Effect.Effect<ProbeClientBridge, CodexRuntimeError, Scope.Scope> =>
  Effect.gen(function* () {
    const sessionContext = yield* Layer.build(
      codexAppServerSessionLive({
        hostId: "probe",
        generation: 1,
        command: options.binaryPath,
        args: [...(options.args ?? standaloneCodexAppServerArgs())],
        env: withSearchPath(options.env, options.additionalSearchPaths ?? []),
        forceTermination: "2 seconds",
        initializeParams: {
          clientInfo: options.clientInfo,
          capabilities: {
            experimentalApi: true,
            extensions: { "openai/form": {} },
            requestAttestation: false,
          },
        },
        initializeTimeout: options.initializeTimeout ?? "20 seconds",
        ...(options.expectedCodexHome === undefined
          ? {}
          : { expectedCodexHome: options.expectedCodexHome }),
      }).pipe(Layer.provide(CodexSessionTransport.nodeLive)),
    );
    const session = Context.get(sessionContext, CodexAppServerSession);
    const bridge = new ProbeClientBridge(
      session,
      callbacks,
      options.requestTimeout ?? "180 seconds",
    );
    yield* session.client.notifications.pipe(
      Stream.runForEach((notification) =>
        notification.protocol === "generated"
          ? Effect.sync(() => bridge.observeNotification(notification.method, notification.params))
          : Effect.void,
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    return bridge;
  });

/**
 * Opens one app-server child in a nested Scope and closes it after the Promise harness returns.
 * The Promise callback is intentionally outside the application model: these probes exercise
 * existing external conformance helpers while process, stdio, requests and listeners stay scoped.
 */
export const withCodexProbeSession = <A>(
  callbacks: ScopedCallbackRuntime["Service"],
  options: CodexProbeSessionOptions,
  use: (client: CodexProbeClient) => Promise<A>,
): Effect.Effect<A, CodexRuntimeError | CodexProbeError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const bridge = yield* acquireProbeClient(options, callbacks);
      return yield* Effect.tryPromise({
        try: () => use(bridge),
        catch: (cause) => new CodexProbeError({ operation: "run-harness", cause }),
      });
    }),
  );

/**
 * Allocates a child Scope for legacy probes that deliberately restart the app-server mid-scenario.
 * The lease is the only close handle, is idempotent, and owns no retry or timer state itself.
 */
export const openCodexProbeSession = (
  callbacks: ScopedCallbackRuntime["Service"],
  options: CodexProbeSessionOptions,
): Effect.Effect<CodexProbeSessionLease, CodexRuntimeError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const bridge = yield* acquireProbeClient(options, callbacks).pipe(
      Scope.provide(scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    let closed = false;
    return Object.assign(bridge, {
      pid: bridge.pid,
      stop: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await callbacks.runPromise(Scope.close(scope, Exit.void));
      },
    });
  });

/** Runs a standalone probe from the process's only Effect root. */
export const runCodexProbeMain = <E>(
  program: Effect.Effect<void, E, ScopedCallbackRuntime>,
): void =>
  NodeRuntime.runMain(
    program.pipe(
      Effect.scoped,
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This is the standalone probe's unique process entry.
      Effect.provide(scopedCallbackRuntimeLive),
    ),
  );
