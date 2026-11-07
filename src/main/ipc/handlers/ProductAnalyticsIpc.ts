import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { MainConfig } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { ProductAnalytics } from "../../product-analytics/ProductAnalytics";

class ProductAnalyticsIpcError extends Schema.TaggedError<ProductAnalyticsIpcError>()(
  "ProductAnalyticsIpcError",
  { cause: Schema.Defect() },
) {}

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const analytics = yield* ProductAnalytics;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => requireTrustedAppRendererSender(event, "Product analytics", config.rendererUrl),
        catch: (cause) => new ProductAnalyticsIpcError({ cause }),
      });
    yield* ipc.handlePlainCommand("product-analytics:record", (event, value: unknown) =>
      authorize(event).pipe(Effect.andThen(analytics.recordFromRenderer(value))),
    );
    yield* ipc.handleQuery("product-analytics:notice:read", (event) =>
      authorize(event).pipe(Effect.andThen(analytics.notice)),
    );
    yield* ipc.handlePlainCommand("product-analytics:notice:presented", (event) =>
      authorize(event).pipe(Effect.andThen(analytics.noticePresented)),
    );
    yield* ipc.handlePlainCommand("product-analytics:notice:acknowledge", (event) =>
      authorize(event).pipe(Effect.andThen(analytics.noticeAcknowledged)),
    );
    yield* ipc.handleQuery("product-analytics:activity:read", (event) =>
      authorize(event).pipe(Effect.andThen(analytics.activity)),
    );
  }),
);
