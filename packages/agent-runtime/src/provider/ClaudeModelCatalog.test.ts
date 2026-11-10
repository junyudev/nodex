import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@nodex/runtime-contracts";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import { resolveProviderCatalog, type ModelManifestData } from "./ModelManifest.ts";
import {
  applyClaudeModelLineup,
  parseClaudeModelLineup,
  type ClaudeModelCatalog,
  formatClaudeVersionUpgradeMessage,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  resolveClaudeUpdateRequiredModels,
  scopeClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";

/**
 * Test policy: adding or changing a real Claude model in model-manifest.json
 * must not add or update tests here. These synthetic fixtures cover resolver
 * behavior once. Add a test only when Claude adapter semantics change, such
 * as introducing a new compatibility rule or dispatch mapping type.
 */

const manifest = (): ModelManifestData => ({
  version: 1,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "extreme", label: "Extreme", isDefault: true }],
              },
              {
                id: "contextWindow",
                label: "Context Window",
                type: "select",
                options: [
                  { id: "large", label: "Large", isDefault: true },
                  { id: "small", label: "Small" },
                ],
              },
            ],
          },
          adapter: {
            claudeCode: {
              effortMap: { extreme: "high" },
              modelSuffixes: { contextWindow: { large: "[large]" } },
            },
          },
        },
      },
      models: [
        {
          slug: "claude-synthetic-next",
          name: "Claude Synthetic Next",
          aliases: ["synthetic"],
          status: "current",
          profile: "synthetic",
          adapter: { claudeCode: { minVersion: "3.2.0" } },
        },
      ],
    },
  },
});

const CLAUDE = ProviderDriverKind.make("claudeAgent");

/** Resolves Claude's catalog the way the driver does: through its manifest catalog entry. */
const catalogFromManifest = (data: ModelManifestData) =>
  resolveClaudeModelCatalog(resolveProviderCatalog(data, CLAUDE) ?? undefined);

describe("Claude model catalog", () => {
  it("resolves capacity from selected options and fixed catalog windows without guessing custom models", () => {
    const source = manifest();
    const profile = source.providers!.claudeAgent!.profiles.synthetic!;
    const catalog = catalogFromManifest({
      ...source,
      providers: {
        claudeAgent: {
          ...source.providers!.claudeAgent!,
          profiles: {
            fixed: {
              capabilities: { optionDescriptors: [] },
              adapter: { claudeCode: { fixedContextWindowTokens: 64_000 } },
            },
            synthetic: {
              ...profile,
              adapter: { claudeCode: { contextWindowTokens: { large: 1_000_000, small: 32_000 } } },
            },
          },
          models: [
            ...source.providers!.claudeAgent!.models,
            {
              slug: "fixed",
              name: "Fixed",
              status: "current",
              profile: "fixed",
            },
          ],
        },
      },
    });
    const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "synthetic" };
    assert.equal(resolveClaudeCatalogContextWindowTokens(catalog, selection), 1_000_000);
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, {
        ...selection,
        options: [{ id: "contextWindow", value: "small" }],
      }),
      32_000,
    );
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "fixed" }),
      64_000,
    );
    assert.isUndefined(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "custom" }),
    );
  });

  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = catalogFromManifest(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.1.9"), [
      { slug: "claude-synthetic-next", name: "Claude Synthetic Next", minVersion: "3.2.0" },
    ]);
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.2.0"), []);
    assert.strictEqual(
      formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      "Claude Code v3.1.9 is too old for Claude Synthetic Next. Upgrade to v3.2.0 or newer to access it.",
    );
  });

  it("resolves aliases and declarative adapter mappings", () => {
    const base = manifest();
    const input: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          models: [
            {
              slug: "claude-synthetic-collision",
              name: "Claude Synthetic Collision",
              aliases: ["claude-synthetic-next"],
              status: "current",
            },
            ...base.providers!.claudeAgent!.models,
          ],
        },
      },
    };
    const catalog = catalogFromManifest(input);
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-next");
    assert.strictEqual(
      resolveClaudeModelSlug(catalog, "claude-synthetic-next"),
      "claude-synthetic-next",
    );
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "synthetic"), "high");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
      "claude-synthetic-next[large]",
    );
  });

  it("rejects malformed adapter mappings", () => {
    const base = manifest();
    const malformed: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          profiles: {
            ...base.providers!.claudeAgent!.profiles,
            synthetic: {
              ...base.providers!.claudeAgent!.profiles.synthetic!,
              adapter: { claudeCode: { effortMap: { extreme: 123 } } },
            },
          },
        },
      },
    };
    assert.isFalse(hasValidClaudeManifestAdapters(malformed));
  });

  it("appends custom models with their own descriptors and keeps bare slugs opaque", () => {
    const catalog = scopeClaudeModelCatalog(catalogFromManifest(manifest()), [
      "synthetic",
      {
        slug: "claude-custom-tuned",
        name: "Tuned",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "gentle", label: "Gentle", isDefault: true },
                { id: "brutal", label: "Brutal" },
              ],
            },
          ],
        },
      },
    ]);

    // The bare custom slug shadows the built-in alias, so it no longer resolves to it.
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "synthetic");
    assert.strictEqual(resolveClaudeCatalogEffort(catalog, "synthetic", "extreme"), undefined);

    // The entry with descriptors resolves user-defined effort ids and passes
    // them through untouched (no effortMap, no model suffix).
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "brutal"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "bogus"),
      "gentle",
    );
    assert.strictEqual(
      normalizeClaudeCatalogEffort(catalog, "brutal", "claude-custom-tuned"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-custom-tuned",
        options: [{ id: "effort", value: "brutal" }],
      }),
      "claude-custom-tuned",
    );
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next", "claude-custom-tuned"],
    );
  });
});

// Deliberately unordered siblings: profile inheritance follows model version, not array order.
const discoveryCatalog = (): ClaudeModelCatalog => ({
  models: [
    {
      model: {
        slug: "claude-fable-5-1",
        name: "Fable 5.1",
        aliases: [],
        isLegacy: true,
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
      runtime: {},
      compatibility: {},
    },
    {
      model: {
        slug: "claude-fable-5-2",
        name: "Fable 5.2",
        aliases: ["fable"],
        isDefault: true,
        isCustom: false,
        capabilities: {
          inputModalities: ["text", "image"],
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "xhigh", label: "Extra High" },
              ],
            },
            { id: "fastMode", label: "Fast Mode", type: "boolean" },
            { id: "ultracode", label: "Ultracode", type: "boolean" },
          ],
        },
      },
      runtime: { effortMap: { xhigh: "max" }, fixedContextWindowTokens: 1_000_000 },
      compatibility: { minVersion: "2.1.321" },
    },
  ],
});
const discovered = (rows: unknown) =>
  applyClaudeModelLineup(discoveryCatalog(), parseClaudeModelLineup(rows));

describe("Claude Code model lineup", () => {
  it("inherits the newest family profile and refines runtime effort and Fast Mode facts", () => {
    const catalog = discovered([
      { value: "fable", resolvedModel: "claude-fable-5-3[1m]", supportedEffortLevels: ["max"] },
    ]);
    const model = resolveClaudeModelsForVersion(catalog, "2.1.1").find(
      ({ slug }) => slug === "claude-fable-5-3",
    )!;
    assert.equal(model.name, "Claude Fable 5.3");
    assert.isFalse(model.isLegacy);
    assert.isTrue(model.isDefault);
    assert.equal(resolveClaudeModelSlug(catalog, "fable"), model.slug);
    assert.equal(resolveClaudeModelSlug(catalog, "fable-5.3"), model.slug);
    assert.deepEqual(
      model.capabilities?.optionDescriptors?.map(({ id }) => id),
      ["effort", "ultracode"],
    );
    assert.equal(resolveClaudeCatalogEffort(catalog, "fable", "medium"), "xhigh");
    assert.equal(normalizeClaudeCatalogEffort(catalog, "xhigh", "fable"), "max");
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, {
        instanceId: ProviderInstanceId.make("claude"),
        model: "fable",
      }),
      1_000_000,
    );
    assert.isBelow(
      catalog.models.findIndex(({ model }) => model.slug === "claude-fable-5-3"),
      catalog.models.findIndex(({ model }) => model.slug === "claude-fable-5-1"),
    );
  });

  it("omits inherited effort when Claude Code explicitly disables it", () => {
    const catalog = discovered([
      {
        value: "fable",
        resolvedModel: "claude-fable-5-3",
        supportsEffort: false,
        supportedEffortLevels: ["medium", "high"],
      },
    ]);
    const model = catalog.models.find(({ model }) => model.slug === "claude-fable-5-3")!.model;
    assert.isFalse(model.capabilities?.optionDescriptors?.some(({ id }) => id === "effort"));
    assert.isUndefined(resolveClaudeCatalogEffort(catalog, "fable", "medium"));
    assert.isTrue(model.capabilities?.optionDescriptors?.some(({ id }) => id === "ultracode"));
  });

  it("moves aliases and defaults backwards to the reported alias, even with a newer explicit row", () => {
    const catalog = discovered([
      { value: "claude-fable-5-3" },
      { value: "fable", resolvedModel: "claude-fable-5-1" },
    ]);
    assert.equal(resolveClaudeModelSlug(catalog, "fable"), "claude-fable-5-1");
    assert.deepEqual(
      catalog.models.filter(({ model }) => model.isDefault).map(({ model }) => model.slug),
      ["claude-fable-5-1"],
    );
    assert.deepEqual(
      catalog.models
        .filter(({ model }) => model.aliases?.includes("fable"))
        .map(({ model }) => model.slug),
      ["claude-fable-5-1"],
    );
  });

  it("lists a reported manifest model below its version gate and excludes its update advisory", () => {
    const catalog = discovered([{ value: "fable", resolvedModel: "claude-fable-5-2" }]);
    assert.equal(
      resolveClaudeModelsForVersion(catalog, "2.1.1").find(({ isDefault }) => isDefault)?.slug,
      "claude-fable-5-2",
    );
    assert.deepEqual(resolveClaudeUpdateRequiredModels(catalog, "2.1.1"), []);
    assert.isUndefined(formatClaudeVersionUpgradeMessage(catalog, "2.1.1"));
  });

  it("keeps offline catalogs unchanged and falls back to the newest listed default-family model", () => {
    const base = discoveryCatalog();
    assert.strictEqual(applyClaudeModelLineup(base, undefined), base);
    assert.strictEqual(applyClaudeModelLineup(base, []), base);
    assert.equal(
      resolveClaudeModelsForVersion(base, "2.1.316").find(({ isDefault }) => isDefault)?.slug,
      "claude-fable-5-1",
    );
    const unrelated = discovered([{ value: "opus", resolvedModel: "claude-opus-6" }]);
    assert.equal(
      resolveClaudeModelsForVersion(unrelated, "2.1.322").find(({ isDefault }) => isDefault)?.slug,
      "claude-fable-5-2",
    );
  });

  it("derives an unfamiliar family's capabilities from reported facts and rejects unknown noncanonical ids", () => {
    const catalog = discovered([
      { value: "claude-nova-10-2", supportedEffortLevels: ["low", "high"], supportsFastMode: true },
      { value: "third-party-model" },
      { value: "claude-nova-10-2-20260101" },
      { value: "custom-gateway" },
    ]);
    assert.equal(catalog.models.length, 3);
    const entry = catalog.models.find(({ model }) => model.slug === "claude-nova-10-2")!;
    assert.deepEqual(entry.runtime, {});
    assert.deepEqual(entry.model.capabilities?.inputModalities, ["text", "image"]);
    assert.deepEqual(
      entry.model.capabilities?.optionDescriptors?.map(({ id }) => id),
      ["effort", "fastMode"],
    );
    assert.equal(resolveClaudeCatalogEffort(catalog, entry.model.slug, "bad"), "low");
    const effort = entry.model.capabilities?.optionDescriptors?.find(({ id }) => id === "effort");
    assert.deepEqual(effort?.type === "select" ? effort.options.map(({ id }) => id) : [], [
      "low",
      "high",
    ]);
    const scoped = scopeClaudeModelCatalog(catalog, [
      "nova",
      { slug: "custom", name: "Custom", capabilities: { optionDescriptors: [] } },
    ]);
    assert.equal(resolveClaudeModelSlug(scoped, "nova"), "nova");
    assert.isTrue(scoped.models.at(-1)?.model.isCustom);
  });

  it("deduplicates context suffixes, keeps bare alias ownership, and ignores default and malformed rows", () => {
    assert.deepEqual(
      parseClaudeModelLineup([
        null,
        {},
        { value: "default", resolvedModel: "claude-opus-6" },
        { value: "fable", resolvedModel: "claude-fable-6" },
        { value: "claude-fable-6[1m]", supportedEffortLevels: ["high"] },
      ]),
      [
        {
          slug: "claude-fable-6",
          aliases: ["fable"],
          supportedEffortLevels: ["high"],
          supportsFastMode: false,
        },
      ],
    );
    assert.deepEqual(parseClaudeModelLineup(undefined), []);
  });
});
