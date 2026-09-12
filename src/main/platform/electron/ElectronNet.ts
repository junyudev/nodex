import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Buffer } from "node:buffer";
import { app, net } from "electron";

export class ElectronNetError extends Schema.TaggedError<ElectronNetError>()("ElectronNetError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export class ElectronNet extends Context.Service<
  ElectronNet,
  {
    readonly appVersion: string;
    readonly fetch: (input: string, init: RequestInit) => Effect.Effect<Response, ElectronNetError>;
    readonly readBase64: (response: Response) => Effect.Effect<string, ElectronNetError>;
  }
>()("nodex/main/platform/electron/ElectronNet") {}

export const live: Layer.Layer<ElectronNet> = Layer.effect(
  ElectronNet,
  Effect.sync(() =>
    ElectronNet.of({
      appVersion: app.getVersion(),
      fetch: (input, init) =>
        Effect.tryPromise({
          try: (signal) => {
            const externalSignal = init.signal;
            const combinedSignal = externalSignal
              ? AbortSignal.any([signal, externalSignal])
              : signal;
            return net.fetch(input, { ...init, signal: combinedSignal });
          },
          catch: (cause) => new ElectronNetError({ operation: "fetch", cause }),
        }),
      readBase64: (response) =>
        Effect.tryPromise({
          try: () => response.arrayBuffer().then((bytes) => Buffer.from(bytes).toString("base64")),
          catch: (cause) => new ElectronNetError({ operation: "read-response-bytes", cause }),
        }),
    }),
  ),
);
