import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Engine modules record anonymous execution facts here. The Runtime holds no network client for
 * them: recordings cross the private pipe to the Desktop Host, whose closed catalog decides what,
 * if anything, is reported.
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

export const layerFromHost = (
  send: (event: string, properties: Readonly<Record<string, unknown>>) => Effect.Effect<void>,
) =>
  Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: (event, properties = {}) => send(event, properties),
      flush: Effect.void,
    }),
  );
