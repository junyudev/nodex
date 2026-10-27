import { useState } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { CheckmarkIcon, TrashIcon } from "@/components/shared/icons/customize-action-icons";
import { MarketplaceGlyphIcon } from "@/components/shared/icons/plugin-detail-icons";
import { CardTile } from "@/components/ui/card-tile";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { PageEmptyState } from "@/components/ui/section-header";
import { toast } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { NodexTooltip } from "@/components/ui/tooltip";
import type {
  ConfiguredMarketplace,
  MarketplacesView,
} from "../../../../shared/codex-plugin-settings";
import {
  manageableMarketplaces,
  marketplaceLabel,
  marketplaceRemovalState,
  marketplaceRemoveTooltip,
  marketplaceUpgradeToast,
  marketplaceUpgradeTooltip,
} from "../model/marketplace-model";
import { pluginMutationSucceeded } from "../model/mutation-result";
import { pluginDisplayName } from "../model/plugin-labels";
import {
  useMarketplaceRemovalPreview,
  useMarketplaceRemovalProgress,
  useMarketplaces,
  usePluginManagement,
  type MarketplaceRemovalProgress,
  type PluginContext,
} from "../plugin-management";
import { PluginLogoImage, pluginLogoSource } from "./plugin-logo";

const LOAD_ERRORS_SHOWN = 3;

/** Marketplaces that failed to load, above the ones that did, with a Retry for all of them. */
function MarketplaceLoadErrorsBanner({
  errors,
  retrying,
  onRetry,
}: {
  readonly errors: MarketplacesView["loadErrors"];
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  if (errors.length === 0) return null;
  const remaining = errors.length - LOAD_ERRORS_SHOWN;
  return (
    <div className="rounded-md border border-(--color-border) p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Some marketplaces could not be loaded</div>
          <div className="mt-2 flex flex-col gap-2 text-xs text-(--color-text-secondary)">
            {errors.slice(0, LOAD_ERRORS_SHOWN).map((error, index) => (
              <div key={`${error.marketplacePath}:${index}`} className="min-w-0">
                <div className="truncate font-mono">{error.marketplacePath}</div>
                <div className="break-words">{error.message}</div>
              </div>
            ))}
            {remaining > 0 ? (
              <div>
                {remaining === 1
                  ? "1 more marketplace could not be loaded"
                  : `${remaining} more marketplaces could not be loaded`}
              </div>
            ) : null}
          </div>
        </div>
        <ToolbarButton color="outline" disabled={retrying} onClick={onRetry}>
          Retry
        </ToolbarButton>
      </div>
    </div>
  );
}

/**
 * Removing a marketplace uninstalls its installed plugins one at a time, then removes it. Each
 * plugin shows its progress; a failure keeps what finished and Retry resumes from there.
 */
function RemoveMarketplaceDialog({
  context,
  marketplace,
  onClose,
}: {
  readonly context: PluginContext;
  readonly marketplace: ConfiguredMarketplace;
  readonly onClose: () => void;
}) {
  const management = usePluginManagement(context);
  const preview = useMarketplaceRemovalPreview(context, marketplace.name, marketplace.path);
  const latest = useMarketplaceRemovalProgress(context).data;
  const [operationId, setOperationId] = useState<string | null>(null);
  const [staleOperationId, setStaleOperationId] = useState<string | null>(null);
  const [settled, setSettled] = useState<MarketplaceRemovalProgress | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const label = marketplaceLabel(marketplace);

  // Progress arrives while the removal runs; an earlier removal's last report doesn't count.
  const live =
    isRemoving &&
    latest != null &&
    latest.marketplaceName === marketplace.name &&
    (operationId == null
      ? latest.operationId !== staleOperationId
      : latest.operationId === operationId)
      ? latest
      : null;
  const state = marketplaceRemovalState({
    preview: preview.isFetching && settled == null ? undefined : preview.data,
    progress: live ?? settled,
    isRemoving,
  });
  const previewFailed = state.plugins == null && preview.isError && !preview.isFetching;

  const remove = async () => {
    if (!state.canSubmit) return;
    setStaleOperationId(latest?.operationId ?? null);
    setIsRemoving(true);
    try {
      const result = await management.removeMarketplace({
        marketplaceName: marketplace.name,
        marketplacePath: marketplace.path,
        ...(operationId == null ? {} : { operationId }),
      });
      setOperationId(result.operationId);
      setSettled(result);
      if (result.removed) {
        toast.success(`${label} marketplace removed`);
        onClose();
      } else {
        toast.danger("Failed to remove marketplace");
      }
    } catch {
      toast.danger("Failed to remove marketplace");
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <NodexDialog
      open
      disablePointerDismissal={isRemoving}
      onOpenChange={(open, details) => {
        if (isRemoving) {
          details.cancel();
          return;
        }
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="compact" showCloseButton={!isRemoving}>
        <NodexDialogForm
          className="max-h-[calc(100dvh-2rem)] overflow-hidden select-none"
          onSubmit={(event) => {
            event.preventDefault();
            void remove();
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>Remove “{label}”?</NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogBody className="min-h-0 gap-4">
            {previewFailed ? (
              <>
                <p role="alert" className="text-sm text-danger">
                  Unable to load installed plugins
                </p>
                <ToolbarButton
                  color="secondary"
                  className="self-start"
                  onClick={() => void preview.refetch()}
                >
                  Retry
                </ToolbarButton>
              </>
            ) : state.plugins == null ? (
              <div
                role="status"
                className="flex items-center gap-2 text-sm text-(--color-text-secondary)"
              >
                <ActivitySpinnerIcon className="icon-xs shrink-0" />
                Loading installed plugins…
              </div>
            ) : state.plugins.length === 0 ? (
              <p className="text-sm text-(--color-text-secondary)">
                Its plugins will not appear or be available for installation unless you add it again
              </p>
            ) : (
              <>
                <p className="shrink-0 text-sm text-(--color-text-secondary)">
                  The following plugins will be uninstalled, and can’t be re-installed unless you
                  add this marketplace again.
                </p>
                <ul
                  aria-live="polite"
                  className="vertical-scroll-fade-mask flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto text-sm select-text"
                >
                  {state.plugins.map(({ row, status }) => (
                    <li key={row.nativeId} className="flex items-center gap-2">
                      <PluginLogoImage source={pluginLogoSource(row)} className="size-5 shrink-0" />
                      <span className="min-w-0 flex-1 break-words">{pluginDisplayName(row)}</span>
                      {status === "pending" ? null : (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-(--color-text-secondary)">
                          {status === "uninstalled" ? (
                            <CheckmarkIcon />
                          ) : (
                            <ActivitySpinnerIcon className="icon-xs" />
                          )}
                          {status === "uninstalled" ? "Uninstalled" : "Uninstalling"}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {state.error == null ? null : (
              <p role="alert" className="text-sm text-danger">
                {state.error}
              </p>
            )}
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction disabled={isRemoving} onClick={onClose}>
              Cancel
            </NodexDialogAction>
            <NodexDialogAction
              tone="danger"
              type="submit"
              disabled={!state.canSubmit}
              aria-busy={isRemoving || undefined}
            >
              {isRemoving ? <ActivitySpinnerIcon className="icon-xs" /> : null}
              {state.confirmLabel}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

/**
 * The Marketplace tab: the marketplaces you added, how many plugins each offers and where it
 * lives, with Upgrade for Git marketplaces and Remove.
 */
export function MarketplacesTab({
  context,
  search,
}: {
  readonly context: PluginContext;
  readonly search: string;
}) {
  const query = useMarketplaces(context);
  const management = usePluginManagement(context);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ConfiguredMarketplace | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const retry = async () => {
    setRefreshing(true);
    try {
      const [result] = await Promise.all([management.refresh(), query.refetch()]);
      if (!pluginMutationSucceeded(result)) toast.danger("Failed to refresh skills and apps");
    } finally {
      setRefreshing(false);
    }
  };
  const upgrade = async (marketplace: ConfiguredMarketplace) => {
    const label = marketplaceLabel(marketplace);
    setUpgrading(marketplace.name);
    try {
      const result = await management.upgradeMarketplaces({ marketplaceName: marketplace.name });
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
      const outcome = marketplaceUpgradeToast(label, result.value.errors.length);
      toast[outcome.tone](outcome.message);
    } catch {
      toast.danger(marketplaceUpgradeToast(label, 1).message);
    } finally {
      setUpgrading(null);
    }
  };

  if (query.isPending) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center py-8">
        <div
          role="status"
          className="flex items-center gap-2 py-2 text-sm text-(--color-text-secondary)"
        >
          <ActivitySpinnerIcon className="icon-xs shrink-0" />
          Loading marketplaces…
        </div>
      </div>
    );
  }
  if (query.error != null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center py-8">
        <PageEmptyState
          title="Unable to load marketplaces"
          description={query.error.message}
          actions={
            <ToolbarButton
              color="outline"
              disabled={refreshing || query.isFetching}
              onClick={() => void retry()}
            >
              Retry
            </ToolbarButton>
          }
        />
      </div>
    );
  }

  const marketplaces = manageableMarketplaces(query.data.marketplaces, search);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <MarketplaceLoadErrorsBanner
        errors={query.data.loadErrors}
        retrying={refreshing || query.isFetching}
        onRetry={() => void retry()}
      />
      {marketplaces.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center py-8">
          <div className="text-sm text-(--color-text-secondary)">No marketplaces found</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {marketplaces.map((marketplace) => (
            <CardTile
              key={`${marketplace.name}:${marketplace.path ?? "remote"}`}
              presentation="card"
              className="group justify-center border-none"
              icon={<MarketplaceGlyphIcon className="icon-sm text-(--color-text-secondary)" />}
              title={marketplaceLabel(marketplace)}
              description={
                <>
                  <span>
                    {marketplace.pluginCount === 1
                      ? "1 plugin"
                      : `${marketplace.pluginCount} plugins`}
                  </span>
                  {marketplace.path == null ? null : (
                    <span className="truncate">{marketplace.path}</span>
                  )}
                </>
              }
              descriptionClassName="flex min-w-0 flex-col gap-0.5 leading-snug"
              actions={
                <div className="flex items-center gap-2">
                  <NodexTooltip tooltipContent={marketplaceUpgradeTooltip(marketplace)} side="top">
                    <ToolbarButton
                      color="outline"
                      aria-label="Upgrade marketplace"
                      disabled={!marketplace.canUpgrade || upgrading != null}
                      loading={upgrading === marketplace.name}
                      onClick={() => void upgrade(marketplace)}
                    >
                      Upgrade
                    </ToolbarButton>
                  </NodexTooltip>
                  <NodexTooltip tooltipContent={marketplaceRemoveTooltip(marketplace)} side="top">
                    <ToolbarButton
                      color="ghost"
                      size="icon"
                      aria-label="Remove marketplace"
                      disabled={!marketplace.canRemove || upgrading != null}
                      onClick={() => setRemoving(marketplace)}
                    >
                      <TrashIcon className="icon-xs" />
                    </ToolbarButton>
                  </NodexTooltip>
                </div>
              }
            />
          ))}
        </div>
      )}
      {removing == null ? null : (
        <RemoveMarketplaceDialog
          key={`${removing.name}:${removing.path ?? "remote"}`}
          context={context}
          marketplace={removing}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
