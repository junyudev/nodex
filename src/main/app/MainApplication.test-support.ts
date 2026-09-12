import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { BootstrapRuntimeEvent } from "../bootstrap-events";
import { MainApplication, type MainApplicationError } from "./MainApplication";

export interface MainApplicationTestHooks {
  readonly acquire: Effect.Effect<void, MainApplicationError>;
  readonly activate?: Effect.Effect<void, MainApplicationError>;
  readonly handleBootstrapEvent: (
    event: BootstrapRuntimeEvent,
  ) => Effect.Effect<void, MainApplicationError>;
  readonly readiness?: MainApplication["Service"]["readiness"];
  readonly prepareShutdown?: Effect.Effect<void>;
  readonly release?: Effect.Effect<void>;
}

export const mainApplicationTestLayer = (
  hooks: MainApplicationTestHooks,
): Layer.Layer<MainApplication, MainApplicationError> =>
  Layer.effect(
    MainApplication,
    Effect.gen(function* () {
      if (hooks.release) yield* Effect.addFinalizer(() => hooks.release ?? Effect.void);
      yield* hooks.acquire;
      return MainApplication.of({
        activate: hooks.activate ?? Effect.void,
        handleBootstrapEvent: hooks.handleBootstrapEvent,
        prepareShutdown: hooks.prepareShutdown ?? Effect.void,
        readiness: hooks.readiness ?? "ready",
      });
    }),
  );
