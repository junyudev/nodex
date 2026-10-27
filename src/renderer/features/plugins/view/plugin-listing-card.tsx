import { useId, type ReactNode } from "react";
import { InfoCircleIcon, PlusLgIcon } from "@/components/shared/icons/customize-action-icons";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { ProfileLockIcon } from "@/components/shared/icons/plugin-detail-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CustomizeNavigation } from "../customize-navigation";
import { usePendingPluginActions } from "../model/install-sessions";
import { pluginDisplayName, pluginShortDescription } from "../model/plugin-labels";
import type { PluginContext, PluginRow } from "../plugin-management";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { InstalledPluginActionsMenu } from "./installed-plugin-actions-menu";
import { useOpenPluginDetail } from "./plugin-browse-context";
import { pluginLogoSource, PluginLogoTile } from "./plugin-logo";
import { PluginOriginBadge } from "./plugin-origin-badge";
import { usePluginRowActions } from "./use-plugin-row-actions";

const DISABLED_REASON_TEXT: Record<string, string> = {
  plan_not_eligible: "Not available on your plan",
  required_app_unavailable: "Required app unavailable",
  unknown: "Unavailable",
};

function disabledReasonText(row: PluginRow): string {
  const reason = row.summary.disabledReason;
  return (reason && DISABLED_REASON_TEXT[reason]) ?? "Access is turned off by your admin";
}

function AvailabilityIndicator({ row }: { readonly row: PluginRow }) {
  if (row.actionState === "admin_disabled") {
    const label = disabledReasonText(row);
    return (
      <NodexTooltip tooltipContent={label} side="top">
        <span
          role="img"
          aria-label={label}
          className="flex size-token-button-composer shrink-0 items-center justify-center text-tertiary"
        >
          <ProfileLockIcon className="icon-sm" />
        </span>
      </NodexTooltip>
    );
  }
  if (row.actionState === "unavailable") {
    return (
      <NodexTooltip
        tooltipContent="This plugin isn't available to install for your account or device"
        side="top"
      >
        <span
          role="img"
          aria-label="Unavailable"
          className="flex size-token-button-composer shrink-0 items-center justify-center text-tertiary"
        >
          <InfoCircleIcon />
        </span>
      </NodexTooltip>
    );
  }
  return null;
}

/**
 * One directory row: the whole row opens the plugin; its trailing action installs it, shows its
 * menu once installed, or explains why it cannot be installed.
 */
export function PluginListingCard({
  row,
  context,
  navigation,
  showDeveloper = false,
}: {
  readonly row: PluginRow;
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
  readonly showDeveloper?: boolean;
}) {
  const titleId = useId();
  const actions = usePluginRowActions(context, navigation);
  const pendingActions = usePendingPluginActions();
  const pending = pendingActions.get(row.stableIdentity);
  const installFlowIdle = ![...pendingActions.values()].includes("installing");
  const name = pluginDisplayName(row);
  const description = pluginShortDescription(row);
  const developer = showDeveloper ? row.summary.interface?.developerName?.trim() : null;
  const openPluginDetail = useOpenPluginDetail(navigation);
  const openDetail = () => openPluginDetail(row);
  const dimmed =
    row.actionState === "admin_disabled" ||
    (row.installState === "installed" && !row.summary.enabled);

  let action: ReactNode;
  if (pending === "installing") {
    action = (
      <ToolbarButton color="ghost" disabled className="disabled:opacity-100">
        <ActivitySpinnerIcon className="icon-sm" />
        Installing
      </ToolbarButton>
    );
  } else if (row.actionState === "installed_menu") {
    action = (
      <InstalledPluginActionsMenu
        row={row}
        context={context}
        navigation={navigation}
        variant="card"
      />
    );
  } else if (row.actionState === "admin_disabled" || row.actionState === "unavailable") {
    action = <AvailabilityIndicator row={row} />;
  } else if (row.actionState === "loading") {
    action = <ToolbarButton aria-label="Loading" color="ghostActive" uniform loading />;
  } else {
    action = (
      <ToolbarButton
        aria-label={`Install ${name}`}
        color="ghostActive"
        uniform
        disabled={!installFlowIdle}
        onClick={(event) => {
          event.stopPropagation();
          void actions.install(row);
        }}
      >
        <PlusLgIcon />
      </ToolbarButton>
    );
  }

  return (
    <div className="group relative flex cursor-interaction flex-col justify-center gap-2.5 rounded-2xl p-2 text-base outline-none select-none hover:bg-text/5">
      <button
        type="button"
        aria-labelledby={titleId}
        className="absolute inset-0 cursor-interaction rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-inset"
        onClick={openDetail}
      />
      <div className="pointer-events-none flex items-center gap-3">
        <span className="shrink-0">
          <PluginLogoTile source={pluginLogoSource(row)} />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col justify-center gap-0.5",
              dimmed && "opacity-60",
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <div id={titleId} className="truncate font-medium text-token-foreground">
                  <span className="inline-flex max-w-full flex-wrap items-center gap-2">
                    <span className="truncate">{name}</span>
                  </span>
                </div>
                <div className="pointer-events-auto relative z-10 flex shrink-0 items-center gap-1 empty:hidden">
                  <PluginOriginBadge row={row} />
                </div>
              </div>
            </div>
            {description || developer ? (
              <div className="flex flex-col gap-0.5 text-sm leading-relaxed text-(--color-text-secondary)">
                <div className="line-clamp-1">
                  {developer && description
                    ? `${developer} • ${description}`
                    : (developer ?? description)}
                </div>
              </div>
            ) : null}
          </div>
          <div className="pointer-events-auto relative z-10 flex shrink-0 items-center">
            {action}
          </div>
        </div>
      </div>
    </div>
  );
}
