import { getIntl, type IntlShape } from "@/lib/i18n";
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
export function marketplaceLabel(
  marketplace: PluginMarketplaceIdentity,
  intl: IntlShape = getIntl(),
): string {
  if (isOfficialMarketplace(marketplace))
    return intl.formatMessage({
      id: "plugins.marketplaceModel.builtByOpenAi",
      defaultMessage: "Built by OpenAI",
    });
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

export function marketplaceUpgradeTooltip(
  marketplace: ConfiguredMarketplace,
  intl: IntlShape = getIntl(),
): string {
  if (marketplace.canUpgrade)
    return intl.formatMessage({
      id: "plugins.marketplaceModel.upgrade",
      defaultMessage: "Upgrade marketplace",
    });
  return marketplace.builtIn
    ? intl.formatMessage({
        id: "plugins.marketplaceModel.builtInUpgrade",
        defaultMessage: "Built-in marketplaces update automatically",
      })
    : intl.formatMessage({
        id: "plugins.marketplaceModel.gitOnlyUpgrade",
        defaultMessage: "Only Git marketplaces can be upgraded",
      });
}

export function marketplaceRemoveTooltip(
  marketplace: ConfiguredMarketplace,
  intl: IntlShape = getIntl(),
): string {
  if (marketplace.canRemove)
    return intl.formatMessage({
      id: "plugins.marketplaceModel.remove",
      defaultMessage: "Remove marketplace",
    });
  return marketplace.builtIn
    ? intl.formatMessage({
        id: "plugins.marketplaceModel.builtInRemove",
        defaultMessage: "Built-in marketplaces cannot be removed",
      })
    : intl.formatMessage({
        id: "plugins.marketplaceModel.addedOnlyRemove",
        defaultMessage: "Only marketplaces you added can be removed",
      });
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
  readonly confirmLabel: string;
}

/**
 * What the Remove marketplace dialog shows: the plugins it uninstalls first, each one's
 * progress while removal runs, and where a failed removal resumes.
 */
export function marketplaceRemovalState(
  {
    preview,
    progress,
    isRemoving,
  }: {
    readonly preview: MarketplaceRemovalPreview | undefined;
    readonly progress: MarketplaceRemovalProgress | null;
    readonly isRemoving: boolean;
  },
  intl: IntlShape = getIntl(),
): MarketplaceRemovalState {
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
      ? intl.formatMessage(
          {
            id: "plugins.marketplaceModel.uninstallFailed",
            defaultMessage: "Unable to uninstall {plugin}. Retry to continue",
          },
          { plugin: pluginDisplayName(failedPlugin) },
        )
      : intl.formatMessage({
          id: "plugins.marketplaceModel.removeFailed",
          defaultMessage: "Unable to remove the marketplace. Retry to continue",
        });
  return {
    plugins,
    isRemoving,
    error,
    canSubmit: plugins != null && !isRemoving && source?.protected !== true,
    confirmLabel: failed
      ? intl.formatMessage({ id: "plugins.marketplaceModel.retry", defaultMessage: "Retry" })
      : plugins != null && plugins.length > 0
        ? intl.formatMessage({
            id: "plugins.marketplaceModel.uninstallAndRemove",
            defaultMessage: "Uninstall & remove",
          })
        : intl.formatMessage({
            id: "plugins.marketplaceModel.confirmRemove",
            defaultMessage: "Remove",
          }),
  };
}

/** The toast after upgrading one marketplace or all of them. */
export function marketplaceUpgradeToast(
  label: string | null,
  errorCount: number,
): { readonly tone: "success" | "danger"; readonly message: string } {
  if (errorCount > 0) {
    return label == null
      ? {
          tone: "danger",
          message: getIntl().formatMessage({
            id: "plugins.marketplaceModel.partialUpgradeFailed",
            defaultMessage: "Some marketplaces failed to upgrade",
          }),
        }
      : {
          tone: "danger",
          message: getIntl().formatMessage({
            id: "plugins.marketplaceModel.upgradeFailed",
            defaultMessage: "Failed to upgrade marketplace",
          }),
        };
  }
  return label == null
    ? {
        tone: "success",
        message: getIntl().formatMessage({
          id: "plugins.marketplaceModel.upgraded",
          defaultMessage: "Marketplaces upgraded",
        }),
      }
    : {
        tone: "success",
        message: getIntl().formatMessage(
          {
            id: "plugins.marketplaceModel.marketplaceUpgraded",
            defaultMessage: "{label} marketplace upgraded",
          },
          { label },
        ),
      };
}
