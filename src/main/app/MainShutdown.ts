import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { MainApplicationError } from "./MainExit";

export const MainShutdownReason = Schema.Union([
  Schema.TaggedStruct("UserQuit", {}),
  Schema.TaggedStruct("Signal", { signal: Schema.String }),
  Schema.TaggedStruct("UpdateInstall", {}),
  Schema.TaggedStruct("AuthorityDriftRelaunch", {}),
  Schema.TaggedStruct("StoreRestoreRelaunch", {}),
  Schema.TaggedStruct("StartupFailure", { cause: Schema.optional(Schema.Defect()) }),
  Schema.TaggedStruct("RuntimeFatal", {
    subsystem: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  }),
]);

export type MainShutdownReason = typeof MainShutdownReason.Type;
export type MainApplicationExit = Exit.Exit<void, MainApplicationError>;

export class MainShutdown extends Context.Service<
  MainShutdown,
  {
    readonly request: (reason: MainShutdownReason) => Effect.Effect<boolean>;
    readonly isRequested: Effect.Effect<boolean>;
    readonly awaitRequest: Effect.Effect<MainShutdownReason>;
    readonly markRuntimeClosed: (exit: MainApplicationExit) => Effect.Effect<boolean>;
    readonly awaitRuntimeClosed: Effect.Effect<MainApplicationExit>;
  }
>()("nodex/main/app/MainShutdown") {}

export const layer: Layer.Layer<MainShutdown> = Layer.effect(
  MainShutdown,
  Effect.gen(function* () {
    const request = yield* Deferred.make<MainShutdownReason>();
    const runtimeClosed = yield* Deferred.make<MainApplicationExit>();

    return MainShutdown.of({
      request: Effect.fn("MainShutdown.request")((reason: MainShutdownReason) =>
        Deferred.succeed(request, reason),
      ),
      isRequested: Deferred.poll(request).pipe(Effect.map(Option.isSome)),
      awaitRequest: Deferred.await(request),
      markRuntimeClosed: Effect.fn("MainShutdown.markRuntimeClosed")((exit: MainApplicationExit) =>
        Deferred.succeed(runtimeClosed, exit),
      ),
      awaitRuntimeClosed: Deferred.await(runtimeClosed),
    });
  }),
);
