import { DEFAULT_MODEL, ProviderDriverKind } from "@nodex/runtime-contracts";

import { BUNDLED_MODEL_MANIFEST, resolveProviderCatalog } from "./ModelManifest.ts";
import type { PendingProviderModels } from "./ProviderInstanceRegistry.ts";

const pendingCodexModels = (
  resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, ProviderDriverKind.make("codex"))?.models ?? []
)
  .filter((model) => model.status === "current")
  .map(({ slug, name, capabilities }) => ({
    slug,
    name,
    capabilities,
    isCustom: false,
    isDefault: slug === DEFAULT_MODEL,
  }));

/** Codex lists its current catalog while its Component installs; other instances list none. */
export const pendingProviderModels: PendingProviderModels = (rawInstanceId) =>
  rawInstanceId === "codex" ? pendingCodexModels : undefined;
