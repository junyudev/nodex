import {
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { assertCallerLifetime, type Caller, loadCaller, readCaller } from "./threadAccess.ts";

// Only the classes below assign these, from their static blocks, so nothing
// outside this module can build a declaration or a handlers layer.

/**
 * Both constructors demand this. Their private constructors only stop the type
 * checker; this also stops `Reflect.construct` and friends at runtime.
 */
const builtHere: unique symbol = Symbol("t3/mcp/McpToolAccess/builtHere");

const refuseOutsideConstruction = (token: symbol) => {
  if (token !== builtHere) {
    throw new TypeError("Only McpToolAccess builds MCP tool declarations and handler layers.");
  }
};

/** Builds a declaration; only the declaration functions below call it. */
let declare: <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;

/** Turns each declaration back into the handler it checks, keeping its type. */
interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

/** Only `toLayer` below builds one. */
let handlersLayer: <Tools extends Record<string, Tool.Any>, EX, RX>(
  layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
) => HandlersLayer<Tools, EX, RX>;

/** Toolkit declarations resolve caller identity before executing semantic operations. */
export class Declaration<out Handler> {
  // A private field makes the class nominal, and only this module can build
  // one: its constructor is private and the static block hands the only way
  // in to module-scoped functions. Copying a declaration's fields onto
  // anything else fails to typecheck and, at runtime, to run.
  readonly #handle: Handler;
  private constructor(token: typeof builtHere, handle: Handler) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
  }
  static {
    declare = (handle) => new Declaration(builtHere, handle);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
  }
}

const writingCaller = loadCaller().pipe(Effect.tap(assertCallerLifetime));
const orchestratingCaller = readCaller().pipe(Effect.tap(assertCallerLifetime));

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

/** Changes nothing, so every caller may call it. */
export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => handle(params));

/** Reads what belongs to the calling T3 thread, such as its preview tabs or devices. */
export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * Acts as the calling T3 thread (its subagents, preview tabs, devices,
 * worktree) while its native execution is valid. Only an agent running inside a
 * T3 thread has one.
 */
export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    requireThreadCaller.pipe(
      Effect.flatMap(() => writingCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

/** Changes something that belongs to no thread, such as a pending upload or a scheduled task. */
export const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => orchestratingCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * Changes something that belongs to no thread under a capability of the tool's own, such as
 * writing a pull request's review guide. Unlike `writes` it does not need thread control; the
 * handler checks its capability, as the capability toolkits do.
 */
export const writesWithCapability = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => writingCaller.pipe(Effect.flatMap(() => handle(params))));

/** Resolve the caller before mutating a target Session. The handler owns target routing. */
export const writesThreads = <P, A, E, R>(
  _threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) => declare((params: P) => writingCaller.pipe(Effect.flatMap(() => handle(params))));

/** The modes a started thread runs with: those requested, else the caller's own. */
export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** Starts threads with the modes `modes` requests, which preserve planning intent. */
export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const { caller } = yield* writingCaller;
      const requested = modes(params);
      const started: StartedModes = {
        runtimeMode: "full-access",
        interactionMode: requested.interactionMode ?? caller?.interactionMode ?? "default",
      };
      return yield* handle(params, started);
    }),
  );

/** Revalidate captured execution after waits before changing environment state. */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    orchestratingCaller.pipe(Effect.flatMap(() => handle(params, orchestratingCaller))),
  );

/** What a declaration's own check needs. */
type CheckServices = Effect.Services<typeof orchestratingCaller>;

/**
 * Each handler of `Handlers`, built by one of the declarations above. A
 * declaration is never callable, which rules out a handler function wearing a
 * declaration's fields.
 */
type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]> & NotCallable;
};

/** Anything but a function. */
type NotCallable = { readonly call?: never } & { readonly apply?: never };

/** A toolkit's handlers, each built by one of the declarations above. */
export type Handlers<Tools extends Record<string, Tool.Any>> = Declarations<
  Toolkit.HandlersFrom<Tools>
>;

/**
 * A toolkit's handler layer built by `toLayer`, the only kind `/mcp`
 * registers. Like a declaration it is nominal, so nothing else passes for one.
 */
export class HandlersLayer<Tools extends Record<string, Tool.Any>, EX = never, RX = never> {
  readonly #layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>;
  private constructor(
    token: typeof builtHere,
    layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
  ) {
    refuseOutsideConstruction(token);
    this.#layer = layer;
  }
  static {
    handlersLayer = (layer) => new HandlersLayer(builtHere, layer);
  }
  /** The handlers, for registering this toolkit on the MCP server. */
  static layer<Tools extends Record<string, Tool.Any>, EX, RX>(
    handlers: HandlersLayer<Tools, EX, RX>,
  ) {
    return handlers.#layer;
  }
}

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers =>
  Struct.map(declarations, checkedHandler);

/** `Toolkit.toLayer` for handlers that all declare their access. */
export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> =>
  handlersLayer(
    toolkit.toLayer(
      Effect.isEffect(build)
        ? Effect.map(build, checkedHandlers<Toolkit.HandlersFrom<Tools>>)
        : checkedHandlers(build),
    ),
  );
