import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { BootstrapRuntimeEvent } from "../bootstrap-events";
import type { MainApplicationError } from "./MainExit";

export { MainApplicationError } from "./MainExit";

/** A fully acquired desktop application. Layer acquisition is the readiness boundary. */
export class MainApplication extends Context.Service<
  MainApplication,
  {
    readonly activate: Effect.Effect<void, MainApplicationError>;
    readonly handleBootstrapEvent: (
      event: BootstrapRuntimeEvent,
    ) => Effect.Effect<void, MainApplicationError>;
    /** Finish renderer persistence while its application services are still admitted. */
    readonly prepareShutdown: Effect.Effect<void>;
    readonly readiness: "ready" | "startup-failed";
  }
>()("nodex/main/app/MainApplication") {}
