import type { ThreadStartResponse } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import type * as Scope from "effect/Scope";
import type { CodexNativeSessionLaunchPreparation } from "../../shared/codex-native-thread-start";
import type { CodexThreadStartForSessionInput, CodexThreadStartForSessionResult } from "../../shared/types";
import { createUuidV7 } from "../../shared/uuid-v7";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { CodexRendererRequestOrigin, type CodexRendererNativeRequestOrigin } from "../codex-runtime/CodexRendererRequestOrigin";
import { CodexTurnPresentation } from "./CodexTurnPresentation";
import { CodexSessionThreadLaunch, CodexSessionThreadLaunchError, type CodexSessionThreadLaunchContext } from "./CodexSessionThreadLaunch";

export class CodexRendererSessionLaunch extends Context.Service<CodexRendererSessionLaunch, {
  readonly prepare: (input: CodexThreadStartForSessionInput, context: CodexSessionThreadLaunchContext) => Effect.Effect<CodexNativeSessionLaunchPreparation, CodexSessionThreadLaunchError>;
  readonly execute: (receiptId: string, ownerClientId: string, origin: CodexRendererNativeRequestOrigin) => Effect.Effect<ThreadStartResponse, CodexSessionThreadLaunchError>;
  readonly accept: (receiptId: string, ownerClientId: string) => Effect.Effect<CodexThreadStartForSessionResult, CodexSessionThreadLaunchError>;
  readonly release: (receiptId: string) => Effect.Effect<void>;
}>()("nodex/main/codex-application/CodexRendererSessionLaunch") {}

interface Entry {
  readonly input: CodexThreadStartForSessionInput;
  readonly context: CodexSessionThreadLaunchContext;
  readonly preparation: Deferred.Deferred<CodexNativeSessionLaunchPreparation, CodexSessionThreadLaunchError>;
  readonly response: Deferred.Deferred<ThreadStartResponse, CodexSessionThreadLaunchError>;
  readonly acceptance: Deferred.Deferred<void>;
  prepared?: CodexNativeSessionLaunchPreparation;
  fiber?: Fiber.Fiber<CodexThreadStartForSessionResult, CodexSessionThreadLaunchError>;
  dispatched: boolean;
}

/** Holds one admitted Session transaction while its window sends the native request. */
export const make: Effect.Effect<CodexRendererSessionLaunch["Service"], never, CodexSessionThreadLaunch | CodexGateway | CodexTurnPresentation | Scope.Scope> = Effect.gen(function* () {
  const launches = yield* CodexSessionThreadLaunch;
  const gateway = yield* CodexGateway;
  const presentation = yield* CodexTurnPresentation;
  const fibers = yield* FiberMap.make<string, CodexThreadStartForSessionResult, CodexSessionThreadLaunchError>();
  const entries = new Map<string, Entry>();
  const failure = (sessionId: string, cause: unknown) => new CodexSessionThreadLaunchError({ operation: "start", sessionId, cause });
  const lookup = (id: string, owner: string) => Effect.gen(function* () {
    const entry = entries.get(id);
    if (!entry || entry.context.ownerClientId !== owner) return yield* Effect.fail(failure(entry?.input.sessionId ?? "", new Error("Session launch receipt unavailable")));
    return entry;
  });
  const release = (id: string) => Effect.gen(function* () {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    yield* FiberMap.remove(fibers, id);
    presentation.releaseClaim(entry.context.presentationClaim);
  });
  yield* Effect.addFinalizer(() => Effect.forEach([...entries.keys()], release, { discard: true }));
  return CodexRendererSessionLaunch.of({
    prepare: (input, context) => Effect.gen(function* () {
      if (!context.ownerClientId || input.runInTarget === "newWorktree") return yield* Effect.fail(failure(input.sessionId, new Error("Native Session launch requires an immediate window target")));
      const id = createUuidV7();
      const entry: Entry = { input, context, preparation: yield* Deferred.make<CodexNativeSessionLaunchPreparation, CodexSessionThreadLaunchError>(), response: yield* Deferred.make<ThreadStartResponse, CodexSessionThreadLaunchError>(), acceptance: yield* Deferred.make<void>(), dispatched: false };
      entries.set(id, entry);
      const operation = launches.start(input, { ...context, sendNativeStart: (request, capability) => Effect.gen(function* () {
        const prepared = { receiptId: id, request, hostId: capability.hostId, generation: capability.generation };
        entry.prepared = prepared;
        yield* Deferred.succeed(entry.preparation, prepared);
        const response = yield* Deferred.await(entry.response);
        yield* Deferred.await(entry.acceptance);
        return response;
      }) }).pipe(
        Effect.mapError((cause) => failure(input.sessionId, cause)),
        Effect.onExit((exit) => Exit.isFailure(exit) ? Effect.gen(function* () {
          yield* Deferred.failCause(entry.preparation, exit.cause);
          yield* Deferred.failCause(entry.response, exit.cause);
        }) : Effect.void),
      );
      entry.fiber = yield* FiberMap.run(fibers, id, operation, { startImmediately: true });
      return yield* Deferred.await(entry.preparation).pipe(Effect.onError(() => release(id)));
    }),
    execute: (id, owner, origin) => Effect.gen(function* () {
      const entry = yield* lookup(id, owner);
      const prepared = entry.prepared;
      if (!prepared || entry.dispatched) return yield* Effect.fail(failure(entry.input.sessionId, new Error("Native Session launch was already dispatched")));
      entry.dispatched = true;
      const response = yield* gateway.requestOnHost(prepared.hostId, "thread/start", prepared.request as ClientRequestParamsByMethod["thread/start"], codexGatewayGenerationFence(prepared)).pipe(
        Effect.provideService(CodexRendererRequestOrigin, origin),
        Effect.map((value) => value as unknown as ThreadStartResponse),
        Effect.mapError((cause) => failure(entry.input.sessionId, cause)),
        Effect.onExit((exit) => Deferred.done(entry.response, exit)),
      );
      return response;
    }),
    accept: (id, owner) => Effect.gen(function* () {
      const entry = yield* lookup(id, owner);
      if (!entry.dispatched || !entry.fiber) return yield* Effect.fail(failure(entry.input.sessionId, new Error("Native Session launch has not been sent")));
      yield* Deferred.await(entry.response);
      yield* Deferred.succeed(entry.acceptance, undefined);
      return yield* Fiber.join(entry.fiber).pipe(Effect.onExit((exit) => Exit.isSuccess(exit) ? Effect.sync(() => { entries.delete(id); }) : release(id)));
    }),
    release,
  });
});
