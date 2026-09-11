import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { registerAppProtocol } from "../app-protocol";
import { MainConfig } from "../app/MainConfig";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";

export type HostFileReader = (input: {
  readonly hostId: string;
  readonly path: string;
  readonly signal: AbortSignal;
}) => Promise<Uint8Array | null>;

export class AppProtocolRuntime extends Context.Service<
  AppProtocolRuntime,
  {
    readonly installed: true;
    readonly registerHostFileReader: (
      reader: HostFileReader,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("nodex/main/host-runtime/AppProtocolRuntime") {}

/** Installs Profile-local protocols before the first renderer is created. */
export const live: Layer.Layer<AppProtocolRuntime, never, ElectronSessionHost | MainConfig> =
  Layer.effect(
    AppProtocolRuntime,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const sessions = yield* ElectronSessionHost;
      const defaultSession = yield* sessions.defaultSession;
      let hostFileReader: HostFileReader | null = null;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const release = registerAppProtocol(defaultSession, {
            readHostFile: (input) => hostFileReader?.(input) ?? Promise.resolve(null),
            rendererRoot: join(__dirname, "../renderer"),
            getDevelopmentRendererUrl: () => (config.isPackaged ? null : config.rendererUrl),
            protocol: sessions.protocol,
          });
          return release;
        }),
        (release) => Effect.sync(release),
      ).pipe(Effect.asVoid);
      return AppProtocolRuntime.of({
        installed: true,
        registerHostFileReader: (reader) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              hostFileReader = reader;
            }),
            () =>
              Effect.sync(() => {
                if (hostFileReader === reader) hostFileReader = null;
              }),
          ),
      });
    }),
  );
