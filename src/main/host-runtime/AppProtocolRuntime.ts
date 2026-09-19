import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { lookup as lookupMimeType } from "mime-types";
import { registerAppProtocol } from "../app-protocol";
import { buildAppHostAssetUrl } from "../../shared/app-protocol";
import { isAbsoluteSearchPath } from "../../shared/file-search-paths";
import { MainConfig } from "../app/MainConfig";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";

export type HostFileReader = (input: {
  readonly hostId: string;
  readonly path: string;
  readonly signal: AbortSignal;
}) => Promise<Uint8Array | null>;

interface AuthorizedHostAsset {
  readonly id: string;
  readonly key: string;
  readonly hostId: string;
  readonly path: string;
  readonly mimeType: string;
}

const MAX_AUTHORIZED_HOST_ASSETS = 4_096;

export class AppProtocolRuntime extends Context.Service<
  AppProtocolRuntime,
  {
    readonly installed: true;
    readonly registerHostFileReader: (
      reader: HostFileReader,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly authorizeHostFile: (input: {
      readonly hostId: string;
      readonly path: string;
    }) => string | null;
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
      const assetsById = new Map<string, AuthorizedHostAsset>();
      const assetIdByKey = new Map<string, string>();
      const authorizeHostFile = (input: { readonly hostId: string; readonly path: string }) => {
        const hostId = input.hostId.trim();
        const path = input.path.trim();
        const mimeType = lookupMimeType(path);
        if (
          !hostId ||
          !path ||
          !isAbsoluteSearchPath(path) ||
          typeof mimeType !== "string" ||
          !mimeType.startsWith("image/")
        ) {
          return null;
        }
        const key = `${hostId}\u0000${path}`;
        const existingId = assetIdByKey.get(key);
        if (existingId) return buildAppHostAssetUrl(existingId);

        const id = randomUUID();
        const asset = { id, key, hostId, path, mimeType } satisfies AuthorizedHostAsset;
        assetsById.set(id, asset);
        assetIdByKey.set(key, id);
        if (assetsById.size > MAX_AUTHORIZED_HOST_ASSETS) {
          const oldest = assetsById.values().next().value as AuthorizedHostAsset | undefined;
          if (oldest) {
            assetsById.delete(oldest.id);
            assetIdByKey.delete(oldest.key);
          }
        }
        return buildAppHostAssetUrl(id);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const release = registerAppProtocol(defaultSession, {
            readHostAsset: async ({ assetId, signal }) => {
              const asset = assetsById.get(assetId);
              if (!asset || !hostFileReader) return null;
              const bytes = await hostFileReader({
                hostId: asset.hostId,
                path: asset.path,
                signal,
              });
              return bytes ? { bytes, mimeType: asset.mimeType } : null;
            },
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
        authorizeHostFile,
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
