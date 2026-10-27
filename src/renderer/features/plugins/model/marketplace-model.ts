import type {
  MarketplaceRemovalPreview,
  MarketplaceRemovalProgress,
  PluginMarketplaceIdentity,
  PluginRow,
} from "../../../../shared/codex-plugin-management";
import type { ConfiguredMarketplace } from "../../../../shared/codex-plugin-settings";
import { pluginDisplayName } from "./plugin-labels";
import { isOfficialMarketplace, normalizePluginSearch } from "./selectors";

/** A marketplace's name as people read it; official marketplaces are labeled as such. */
export function marketplaceLabel(marketplace: PluginMarketplaceIdentity): string {
  if (isOfficialMarketplace(marketplace)) return "Built by OpenAI";
  const displayName = marketplace.displayName?.trim() ?? "";
  return displayName.length > 0 ? displayName : marketplace.name;
}

/** The marketplaces you added, matching the search by label, name, or path. */
export function manageableMarketplaces(
  marketplaces: readonly ConfiguredMarketplace[],
  search: string,
): ConfiguredMarketplace[] {
  const query = normalizePluginSearch(search);
  return marketplaces.filter(
    (marketplace) =>
      !marketplace.builtIn &&
      marketplace.configured &&
      (query.length === 0 ||
        [marketplaceLabel(marketplace), marketplace.name, marketplace.path ?? ""].some((value) =>
          normalizePluginSearch(value).includes(query),
        )),
  );
}

export function marketplaceUpgradeTooltip(marketplace: ConfiguredMarketplace): string {
  if (marketplace.canUpgrade) return "Upgrade marketplace";
  return marketplace.builtIn
    ? "Built-in marketplaces update automatically"
    : "Only Git marketplaces can be upgraded";
}

export function marketplaceRemoveTooltip(marketplace: ConfiguredMarketplace): string {
  if (marketplace.canRemove) return "Remove marketplace";
  return marketplace.builtIn
    ? "Built-in marketplaces cannot be removed"
    : "Only marketplaces you added can be removed";
}

export type RemovalPluginStatus = "pending" | "uninstalling" | "uninstalled";

export interface MarketplaceRemovalState {
  /** The installed plugins removal uninstalls, in order; unknown until the preview loads. */
  readonly plugins:
    | readonly { readonly row: PluginRow; readonly status: RemovalPluginStatus }[]
    | null;
  readonly isRemoving: boolean;
  /** Why removal stopped, naming the plugin it couldn't uninstall. */
  readonly error: string | null;
  readonly canSubmit: boolean;
  readonly confirmLabel: "Retry" | "Uninstall & remove" | "Remove";
}

/**
 * What the Remove marketplace dialog shows: the plugins it uninstalls first, each one's
 * progress while removal runs, and where a failed removal resumes.
 */
export function marketplaceRemovalState({
  preview,
  progress,
  isRemoving,
}: {
  readonly preview: MarketplaceRemovalPreview | undefined;
  readonly progress: MarketplaceRemovalProgress | null;
  readonly isRemoving: boolean;
}): MarketplaceRemovalState {
  const source = progress ?? preview;
  const rows = new Map((source?.plugins ?? []).map((row) => [row.nativeId, row]));
  const completed = new Set(progress?.completedPluginIds ?? []);
  const current =
    isRemoving && progress?.phase !== "removing" ? progress?.remainingPluginIds[0] : null;
  const plugins =
    source == null
      ? null
      : source.pluginIds.flatMap((id) => {
          const row = rows.get(id);
          if (row == null) return [];
          const status: RemovalPluginStatus = completed.has(id)
            ? "uninstalled"
            : id === current
              ? "uninstalling"
              : "pending";
          return [{ row, status }];
        });
  const failed = !isRemoving && progress != null && progress.phase === "failed";
  const failedPlugin = failed ? rows.get(progress.remainingPluginIds[0] ?? "") : undefined;
  const error = !failed
    ? null
    : failedPlugin != null
      ? `Unable to uninstall ${pluginDisplayName(failedPlugin)}. Retry to continue`
      : "Unable to remove the marketplace. Retry to continue";
  return {
    plugins,
    isRemoving,
    error,
    canSubmit: plugins != null && !isRemoving && source?.protected !== true,
    confirmLabel: failed
      ? "Retry"
      : plugins != null && plugins.length > 0
        ? "Uninstall & remove"
        : "Remove",
  };
}

/** The toast after upgrading one marketplace or all of them. */
export function marketplaceUpgradeToast(
  label: string | null,
  errorCount: number,
): { readonly tone: "success" | "danger"; readonly message: string } {
  if (errorCount > 0) {
    return label == null
      ? { tone: "danger", message: "Some marketplaces failed to upgrade" }
      : { tone: "danger", message: "Failed to upgrade marketplace" };
  }
  return label == null
    ? { tone: "success", message: "Marketplaces upgraded" }
    : { tone: "success", message: `${label} marketplace upgraded` };
}
