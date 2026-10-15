/**
 * ModelManifest — remote provider-model metadata with a bundled offline
 * fallback.
 *
 * Provider catalogs and legacy classification live in `model-manifest.json`.
 * The bundled copy ships with every release; at runtime the service refreshes
 * it from the same file on `main`. Preference order is remote, then the last
 * successful on-disk copy, then the bundle. A failed fetch never fails a
 * provider check.
 *
 * Providers with authoritative discovery can use only the classification
 * overlay. Providers with static catalogs can resolve presentation and
 * capabilities from `providers`, then decode their own allowlisted adapter
 * payload separately.
 */
import {
  ModelCapabilities,
  TrimmedNonEmptyString,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import bundledManifestJson from "./model-manifest.json" with { type: "json" };
import { ProviderCompatibilityPolicy } from "./providerCompatibility.ts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";

const ManifestModelStatus = Schema.Literals(["current", "legacy"]);

const ManifestModelProfile = Schema.Struct({
  capabilities: Schema.optional(ModelCapabilities),
  adapter: Schema.optional(Schema.Unknown),
});

const ManifestProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  aliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  status: ManifestModelStatus,
  badge: Schema.optional(Schema.Literal("new")),
  profile: Schema.optional(TrimmedNonEmptyString),
  adapter: Schema.optional(Schema.Unknown),
});

const ManifestProviderCatalog = Schema.Struct({
  defaults: Schema.optional(
    Schema.Struct({
      chat: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  profiles: Schema.Record(Schema.String, ManifestModelProfile),
  models: Schema.Array(ManifestProviderModel),
});

/**
 * `version` gates breaking schema changes. Provider catalogs are additive so
 * clients that only understand `currentModels` keep accepting this v1 file.
 */
const ModelManifestEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  /**
   * ISO date of the last edit. A release bundles its manifest, and a disk
   * cache of an older edit must not outrank it. Optional so older remote
   * files still decode; they count as older than any dated bundle.
   */
  updatedAt: Schema.optional(Schema.String),
  compatibility: Schema.optional(Schema.Array(ProviderCompatibilityPolicy)),
  currentModels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  providers: Schema.optional(Schema.Record(Schema.String, ManifestProviderCatalog)),
});

const hasValidProviderCatalogReferences = (
  manifest: typeof ModelManifestEnvelopeSchema.Type,
): boolean =>
  Object.values(manifest.providers ?? {}).every((catalog) => {
    const slugs = new Set<string>();
    const modelsAreValid = catalog.models.every((model) => {
      if (slugs.has(model.slug)) return false;
      slugs.add(model.slug);
      return model.profile === undefined || catalog.profiles[model.profile] !== undefined;
    });
    return (
      modelsAreValid && (catalog.defaults?.chat === undefined || slugs.has(catalog.defaults.chat))
    );
  });

const ModelManifestSchema = ModelManifestEnvelopeSchema.pipe(
  Schema.check(
    Schema.makeFilter(hasValidProviderCatalogReferences, {
      expected: "unique model slugs and existing model and profile references",
    }),
    Schema.makeFilter(hasValidClaudeManifestAdapters, {
      expected: "valid Claude adapter metadata",
    }),
  ),
);
export type ModelManifestData = typeof ModelManifestSchema.Type;

export const BUNDLED_MODEL_MANIFEST: ModelManifestData =
  Schema.decodeUnknownSync(ModelManifestSchema)(bundledManifestJson);

/**
 * A driver's catalog entry as provider packages see it, or `null` when the
 * manifest has none or its references are invalid.
 */
export function resolveProviderCatalog(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ModelCatalog.ProviderCatalog | null {
  const catalog = manifest.providers?.[driverKind];
  if (!catalog) return null;

  const seen = new Set<string>();
  const models: Array<ModelCatalog.ProviderCatalogModel> = [];
  for (const entry of catalog.models) {
    if (seen.has(entry.slug)) return null;
    seen.add(entry.slug);

    const profile = entry.profile ? catalog.profiles[entry.profile] : undefined;
    if (entry.profile && !profile) return null;

    models.push({
      slug: entry.slug,
      name: entry.name,
      ...(entry.shortName ? { shortName: entry.shortName } : {}),
      ...(entry.subProvider ? { subProvider: entry.subProvider } : {}),
      ...(entry.aliases ? { aliases: entry.aliases } : {}),
      ...(entry.badge ? { badge: entry.badge } : {}),
      status: entry.status,
      capabilities: profile?.capabilities ?? null,
      adapter: entry.adapter,
      profileAdapter: profile?.adapter,
    });
  }

  if (catalog.defaults?.chat !== undefined && !seen.has(catalog.defaults.chat)) return null;

  return { models, defaultChatModel: catalog.defaults?.chat };
}

export class ModelManifest extends Context.Service<
  ModelManifest,
  {
    /** The manifest in effect; snapshot classification reads it without waiting. */
    readonly current: Effect.Effect<ModelManifestData>;
    /** The manifest after any refresh the service supports; never fails. */
    readonly refresh: Effect.Effect<ModelManifestData>;
    /** An explicit refresh; retains last-good data. */
    readonly forceRefresh: Effect.Effect<ModelManifestData>;
    /** Refresh without waiting; drivers call this from provider checks. */
    readonly refreshInBackground: Effect.Effect<void>;
  }
>()("t3/provider/ModelManifest") {}

/** The release's manifest; every read and refresh returns it unchanged. */
const BundledOnlyModelManifest: ModelManifest["Service"] = {
  current: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  forceRefresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refreshInBackground: Effect.void,
};

const layerBundledOnly = Layer.succeed(ModelManifest, BundledOnlyModelManifest);

/**
 * Nodex ships the manifest with each release and never fetches or caches a remote copy, so
 * model availability changes only with an application update.
 */
export const layer = layerBundledOnly;

/** Bundled data with the provider catalog port drivers read. */
export const layerTest = Layer.suspend(() =>
  layerModelCatalog.pipe(Layer.provideMerge(layerBundledOnly)),
);

/** Exposes the manifest to provider packages as their per-driver catalogs. */
export const layerModelCatalog = Layer.effect(
  ModelCatalog.ModelCatalog,
  Effect.gen(function* () {
    const manifest = yield* ModelManifest;
    return ModelCatalog.ModelCatalog.of({
      current: (driverKind) =>
        manifest.current.pipe(
          Effect.map((data) => resolveProviderCatalog(data, driverKind) ?? undefined),
        ),
      bundled: (driverKind) =>
        resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, driverKind) ?? undefined,
      refreshInBackground: manifest.refreshInBackground,
    });
  }),
);
