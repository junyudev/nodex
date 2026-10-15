import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Engine modules may record anonymous product events. Nodex does not send execution analytics
 * anywhere, so every recording is discarded and the service holds no network client.
 */
export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
  }
>()("nodex/agent-runtime/AnalyticsService") {
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({ record: () => Effect.void, flush: Effect.void }),
  );
}

export const layer = AnalyticsService.layerTest;
