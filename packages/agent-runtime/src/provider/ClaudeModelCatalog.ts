import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderOptionDescriptor,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderUpdateRequiredModel,
} from "@nodex/runtime-contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  readCustomModelEntries,
} from "@nodex/runtime-shared/model";
import { compareSemverVersions } from "@nodex/runtime-shared/semver";

import {
  type ClaudeCodeCompatibility,
  type ClaudeCodeProfile,
  decodeClaudeModelAdapter,
  decodeClaudeProfileAdapter,
} from "./ClaudeModelManifest.ts";
import * as ModelCatalog from "@nodex/provider-core/server/ModelCatalog";
import { BUNDLED_MODEL_MANIFEST, resolveProviderCatalog } from "./ModelManifest.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const EMPTY_CAPABILITIES: ModelCapabilities = { optionDescriptors: [] };

export interface ClaudeCatalogModel {
  readonly model: ServerProviderModel;
  readonly runtime: ClaudeCodeProfile;
  readonly compatibility: ClaudeCodeCompatibility;
  /** Initialization is stronger evidence than a bundled version constraint. */
  readonly reported?: boolean;
}

export interface ClaudeModelCatalog {
  readonly models: ReadonlyArray<ClaudeCatalogModel>;
}

function tryResolveClaudeModelCatalog(
  resolved: ModelCatalog.ProviderCatalog | undefined,
): ClaudeModelCatalog | null {
  if (!resolved) return null;

  const models: Array<ClaudeCatalogModel> = [];
  for (const entry of resolved.models) {
    const profile = decodeClaudeProfileAdapter(entry.profileAdapter ?? {});
    const adapter = decodeClaudeModelAdapter(entry.adapter ?? {});
    if (Option.isNone(profile) || Option.isNone(adapter)) return null;
    models.push({
      model: ModelCatalog.catalogServerModel(resolved, entry),
      runtime: profile.value.claudeCode ?? {},
      compatibility: adapter.value.claudeCode ?? {},
    });
  }

  return {
    models,
  };
}

const BUNDLED_CLAUDE_PROVIDER_CATALOG =
  resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, CLAUDE) ?? undefined;

/**
 * Claude's built-in catalog from its manifest entry, falling back to the
 * bundled entry when the current one is missing or has invalid adapters.
 */
export function resolveClaudeModelCatalog(
  catalog: ModelCatalog.ProviderCatalog | undefined,
): ClaudeModelCatalog {
  return (
    tryResolveClaudeModelCatalog(catalog) ??
    tryResolveClaudeModelCatalog(BUNDLED_CLAUDE_PROVIDER_CATALOG) ?? {
      models: [],
    }
  );
}

export const BUNDLED_CLAUDE_MODEL_CATALOG = resolveClaudeModelCatalog(
  BUNDLED_CLAUDE_PROVIDER_CATALOG,
);

/** Facts from Claude Code initialization; presentation and runtime mappings stay in the manifest. */
export interface ClaudeModelLineupEntry {
  readonly slug: string;
  readonly aliases: ReadonlyArray<string>;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
  readonly supportsEffort?: boolean;
  readonly supportsFastMode: boolean;
}

const modelParts = (slug: string) => /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(slug);
const modelFamily = (slug: string) => modelParts(slug)?.[1];
const newestFirst = (left: string, right: string) =>
  right.localeCompare(left, undefined, { numeric: true });

const decodeLineupRow = Schema.decodeUnknownOption(
  Schema.Struct({
    value: Schema.String,
    resolvedModel: Schema.optional(Schema.NullOr(Schema.String)),
    supportedEffortLevels: Schema.optional(Schema.Array(Schema.String)),
    supportsEffort: Schema.optional(Schema.Boolean),
    supportsFastMode: Schema.optional(Schema.Boolean),
  }),
);

/** Tolerate older CLIs, malformed rows and duplicate context-window spellings. */
export function parseClaudeModelLineup(input: unknown): ReadonlyArray<ClaudeModelLineupEntry> {
  if (!Array.isArray(input)) return [];
  const entries = new Map<string, ClaudeModelLineupEntry>();
  for (const candidate of input) {
    const decoded = decodeLineupRow(candidate);
    if (Option.isNone(decoded) || decoded.value.value === "default") continue;
    const row = decoded.value;
    const slug = (typeof row.resolvedModel === "string" ? row.resolvedModel : row.value).replace(
      /\[[^\]]+\]$/,
      "",
    );
    const previous = entries.get(slug);
    const aliases = new Set(previous?.aliases);
    if (row.value === modelFamily(slug)) aliases.add(row.value);
    entries.set(slug, {
      slug,
      ...previous,
      aliases: [...aliases],
      ...(Array.isArray(row.supportedEffortLevels)
        ? {
            supportedEffortLevels: row.supportedEffortLevels,
          }
        : {}),
      ...(typeof row.supportsEffort === "boolean" ? { supportsEffort: row.supportsEffort } : {}),
      supportsFastMode: row.supportsFastMode === true || previous?.supportsFastMode === true,
    });
  }
  return [...entries.values()];
}

function discoveredCapabilities(
  row: ClaudeModelLineupEntry,
  sibling: ClaudeCatalogModel | undefined,
): ModelCapabilities {
  const inherited = sibling?.model.capabilities;
  const standardEffort = BUNDLED_CLAUDE_MODEL_CATALOG.models
    .flatMap(({ model }) => model.capabilities?.optionDescriptors ?? [])
    .find(
      (option) =>
        option.id === "effort" &&
        option.type === "select" &&
        option.options.some(({ id }) => id === "xhigh"),
    );
  const inheritedOptions = inherited?.optionDescriptors ?? [];
  const effort = inheritedOptions.find((option) => option.id === "effort") ?? standardEffort;
  const offeredEffort =
    row.supportsEffort !== false &&
    effort?.type === "select" &&
    (row.supportedEffortLevels !== undefined || sibling || row.supportsEffort)
      ? effort.options.filter(
          ({ id }) =>
            row.supportedEffortLevels === undefined ||
            row.supportedEffortLevels.includes(sibling?.runtime.effortMap?.[id] ?? id),
        )
      : [];
  const defaultEffort =
    offeredEffort.find((option) => option.isDefault)?.id ??
    offeredEffort.find(({ id }) => id === "medium")?.id ??
    offeredEffort[0]?.id;
  const descriptors: Array<ProviderOptionDescriptor> = inheritedOptions.filter(
    ({ id }) => id !== "effort" && id !== "fastMode",
  );
  if (offeredEffort.length > 0 && effort?.type === "select")
    descriptors.unshift({
      ...effort,
      options: offeredEffort.map((option) => ({
        ...option,
        isDefault: option.id === defaultEffort,
      })),
    });
  if (row.supportsFastMode)
    descriptors.push(
      inheritedOptions.find(({ id }) => id === "fastMode") ?? {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
      },
    );
  return {
    ...inherited,
    inputModalities: inherited?.inputModalities ?? ["text", "image"],
    optionDescriptors: descriptors,
  };
}

/** Overlay live model identity on the manifest without removing explicit older model ids. */
export function applyClaudeModelLineup(
  catalog: ClaudeModelCatalog,
  lineup: ReadonlyArray<ClaudeModelLineupEntry> | undefined,
): ClaudeModelCatalog {
  if (!lineup?.length) return catalog;
  const reported = new Map(
    lineup
      .filter(
        ({ slug }) => catalog.models.some(({ model }) => model.slug === slug) || modelParts(slug),
      )
      .map((row) => [row.slug, row]),
  );
  if (reported.size === 0) return catalog;
  const familyOwners = new Map<string, string>();
  for (const row of [...reported.values()].toSorted((a, b) => newestFirst(a.slug, b.slug))) {
    const family = modelFamily(row.slug);
    if (family && (!familyOwners.has(family) || row.aliases.includes(family)))
      familyOwners.set(family, row.slug);
  }
  const models = catalog.models.map((entry) =>
    reported.has(entry.model.slug)
      ? { ...entry, reported: true, model: { ...entry.model, isLegacy: false } }
      : entry,
  );
  const additions = [...reported.values()].filter(
    ({ slug }) => !models.some(({ model }) => model.slug === slug),
  );
  for (const row of additions.toSorted((a, b) => newestFirst(b.slug, a.slug))) {
    const family = modelFamily(row.slug)!;
    const parts = modelParts(row.slug)!;
    const siblings = catalog.models
      .filter(({ model }) => modelFamily(model.slug) === family)
      .toSorted((a, b) => newestFirst(a.model.slug, b.model.slug));
    const version = parts.slice(2).filter(Boolean).join(".");
    const entry: ClaudeCatalogModel = {
      model: {
        slug: row.slug,
        name: `Claude ${family[0]!.toUpperCase()}${family.slice(1)} ${version}`,
        aliases: [`${family}-${version}`, `claude-${family}-${version}`],
        capabilities: discoveredCapabilities(row, siblings[0]),
        isLegacy: false,
        isCustom: false,
      },
      runtime: siblings[0]?.runtime ?? {},
      compatibility: {},
      reported: true,
    };
    const familyIndex = models.findIndex(({ model }) => modelFamily(model.slug) === family);
    const lastCurrent = models.findLastIndex(({ model }) => !model.isLegacy);
    models.splice(familyIndex >= 0 ? familyIndex : lastCurrent + 1, 0, entry);
  }
  const manifestDefault = catalog.models.find(({ model }) => model.isDefault)?.model.slug;
  const defaultSlug = familyOwners.get(modelFamily(manifestDefault ?? "") ?? "") ?? manifestDefault;
  return {
    models: models.map((entry) => {
      const family = modelFamily(entry.model.slug);
      const owner = family ? familyOwners.get(family) : undefined;
      const aliases = (entry.model.aliases ?? []).filter((alias) => alias !== family || !owner);
      if (owner === entry.model.slug) aliases.push(family!);
      return {
        ...entry,
        model: { ...entry.model, aliases, isDefault: entry.model.slug === defaultSlug },
      };
    }),
  };
}

/**
 * Scope the catalog to one instance's settings: custom model slugs stay opaque
 * (a built-in alias they shadow is dropped, canonical slugs and capabilities
 * are preserved), and custom entries that declare their own capabilities are
 * appended so the adapter resolves effort / fast mode / thinking against the
 * user's descriptors instead of the empty default. Custom entries carry no
 * runtime profile, so option values pass through to Claude Code verbatim.
 */
export function scopeClaudeModelCatalog(
  catalog: ClaudeModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
): ClaudeModelCatalog {
  const customEntries = readCustomModelEntries(customModels);
  if (customEntries.length === 0) return catalog;
  const customAliases = new Set(customEntries.map((entry) => entry.slug.toLowerCase()));

  const builtInModels = catalog.models.map((entry) => {
    if (!entry.model.aliases?.some((alias) => customAliases.has(alias.toLowerCase()))) {
      return entry;
    }
    return {
      ...entry,
      model: {
        ...entry.model,
        aliases: entry.model.aliases.filter((alias) => !customAliases.has(alias.toLowerCase())),
      },
    };
  });
  const builtInSlugs = new Set(builtInModels.map((entry) => entry.model.slug));
  const customCatalogModels: Array<ClaudeCatalogModel> = [];
  for (const entry of customEntries) {
    if (!entry.capabilities || builtInSlugs.has(entry.slug)) continue;
    customCatalogModels.push({
      model: {
        slug: entry.slug,
        name: entry.name,
        isCustom: true,
        capabilities: entry.capabilities,
      },
      runtime: {},
      compatibility: {},
    });
  }

  return { models: [...builtInModels, ...customCatalogModels] };
}

function resolveClaudeCatalogModel(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ClaudeCatalogModel | undefined {
  const value = slugOrAlias?.trim();
  if (!value) return undefined;
  return (
    catalog.models.find((entry) => entry.model.slug === value) ??
    catalog.models.find((entry) =>
      entry.model.aliases?.some((alias) => alias.toLowerCase() === value.toLowerCase()),
    )
  );
}

export function resolveClaudeModelSlug(catalog: ClaudeModelCatalog, slugOrAlias: string): string {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.slug ?? slugOrAlias;
}

export function getClaudeCatalogModelCapabilities(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ModelCapabilities {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.capabilities ?? EMPTY_CAPABILITIES;
}

function isVersionSupported(
  compatibility: ClaudeCodeCompatibility,
  version: string | null | undefined,
): boolean {
  if (!compatibility.minVersion && !compatibility.maxVersionExclusive) return true;
  if (!version) return false;
  if (compatibility.minVersion && compareSemverVersions(version, compatibility.minVersion) < 0) {
    return false;
  }
  return !(
    compatibility.maxVersionExclusive &&
    compareSemverVersions(version, compatibility.maxVersionExclusive) >= 0
  );
}

export function resolveClaudeModelsForVersion(
  catalog: ClaudeModelCatalog,
  version: string | null | undefined,
): ReadonlyArray<ClaudeCatalogModel["model"]> {
  const models = catalog.models
    .filter((entry) => entry.reported || isVersionSupported(entry.compatibility, version))
    .map((entry) => entry.model);
  if (models.some((model) => model.isDefault)) return models;
  const family = modelFamily(catalog.models.find(({ model }) => model.isDefault)?.model.slug ?? "");
  const fallback =
    models
      .filter((model) => family && modelFamily(model.slug) === family)
      .toSorted((a, b) => newestFirst(a.slug, b.slug))[0] ?? models[0];
  return models.map((model) => ({ ...model, isDefault: model === fallback }));
}

/**
 * Current catalog models the installed Claude Code is too old to run, so the
 * picker can show them as "update to use" instead of hiding them.
 */
export function resolveClaudeUpdateRequiredModels(
  catalog: ClaudeModelCatalog,
  version: string | null | undefined,
): ReadonlyArray<ServerProviderUpdateRequiredModel> {
  if (!version) return [];
  return catalog.models.flatMap(({ model, compatibility, reported }) => {
    const minVersion = compatibility.minVersion;
    if (
      reported ||
      model.isLegacy ||
      !minVersion ||
      compareSemverVersions(version, minVersion) >= 0
    ) {
      return [];
    }
    return [
      {
        slug: model.slug,
        name: model.name,
        ...(model.badge ? { badge: model.badge } : {}),
        minVersion,
      },
    ];
  });
}

export function formatClaudeVersionUpgradeMessage(
  catalog: ClaudeModelCatalog,
  version: string | null,
): string | undefined {
  const unavailable = catalog.models
    .filter(
      (entry) =>
        !entry.reported &&
        entry.compatibility.minVersion &&
        (!version || compareSemverVersions(version, entry.compatibility.minVersion) < 0),
    )
    .toSorted((left, right) =>
      compareSemverVersions(left.compatibility.minVersion!, right.compatibility.minVersion!),
    )[0];
  if (!unavailable?.compatibility.minVersion) return undefined;
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for ${unavailable.model.name}. Upgrade to v${unavailable.compatibility.minVersion} or newer to access it.`;
}

export function resolveClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  model: string | null | undefined,
  raw: string | null | undefined,
): string | undefined {
  const caps = getClaudeCatalogModelCapabilities(catalog, model);
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "effort");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function normalizeClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort) return undefined;
  const effortMap = resolveClaudeCatalogModel(catalog, model)?.runtime.effortMap;
  if (!effortMap || !Object.prototype.hasOwnProperty.call(effortMap, effort)) return effort;
  return effortMap[effort] ?? undefined;
}

function resolveClaudeCatalogContextWindow(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const caps = getClaudeCatalogModelCapabilities(catalog, modelSelection?.model);
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function resolveClaudeCatalogApiModelId(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection,
): string {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection.model);
  const slug = entry?.model.slug ?? modelSelection.model;
  const descriptors = getProviderOptionDescriptors({
    caps: entry?.model.capabilities ?? EMPTY_CAPABILITIES,
    selections: modelSelection.options,
  });
  for (const [optionId, suffixes] of Object.entries(entry?.runtime.modelSuffixes ?? {})) {
    const value = getProviderOptionCurrentValue(
      descriptors.find((descriptor) => descriptor.id === optionId),
    );
    if (typeof value === "string" && suffixes[value]) return `${slug}${suffixes[value]}`;
  }
  return slug;
}

export function resolveClaudeCatalogContextWindowTokens(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): number | undefined {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection?.model);
  if (!entry) return undefined;
  if (entry.runtime.fixedContextWindowTokens) return entry.runtime.fixedContextWindowTokens;
  const contextWindow = resolveClaudeCatalogContextWindow(catalog, modelSelection);
  return contextWindow ? entry.runtime.contextWindowTokens?.[contextWindow] : undefined;
}
