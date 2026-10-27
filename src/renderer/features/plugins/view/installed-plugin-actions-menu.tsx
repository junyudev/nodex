import { GearIcon, TrashIcon, TryNowIcon } from "@/components/shared/icons/customize-action-icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import type { CustomizeNavigation } from "../customize-navigation";
import { usePendingPluginActions } from "../model/install-sessions";
import { selectorToRouteTarget, type PluginContext, type PluginRow } from "../plugin-management";
import {
  MoreActionsButton,
  ToolbarButton,
  type MoreActionsVariant,
} from "@/components/ui/toolbar-button";
import { usePluginRowActions } from "./use-plugin-row-actions";

/** Why an installed plugin cannot be uninstalled, or null when it can. */
export function forcedInstallLabel(row: PluginRow): string | null {
  const summary = row.summary;
  if (summary.installPolicy !== "INSTALLED_BY_DEFAULT") return null;
  return summary.installPolicySource === "IMPLICIT_CANONICAL_APP"
    ? "Required by ChatGPT"
    : "Installed by admin";
}

/**
 * The "More actions" menu of an installed plugin: Try now, Manage (its settings), then
 * Uninstall. While an uninstall runs, the trigger becomes an "Uninstalling" label.
 */
export function InstalledPluginActionsMenu({
  row,
  context,
  navigation,
  variant,
  onOpenChange,
}: {
  readonly row: PluginRow;
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
  readonly variant: MoreActionsVariant;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const actions = usePluginRowActions(context, navigation);
  const pending = usePendingPluginActions().get(row.stableIdentity);
  const isDisabledByAdmin = row.summary.availability === "DISABLED_BY_ADMIN";
  const forcedLabel = forcedInstallLabel(row);
  const canTry = row.summary.enabled && !isDisabledByAdmin;
  const uninstallDisabled = forcedLabel !== null || !row.canUninstall;

  if (pending === "uninstalling") {
    return (
      <ToolbarButton color="ghost" disabled className="disabled:opacity-100">
        Uninstalling
      </ToolbarButton>
    );
  }

  return (
    <div
      role="presentation"
      className="flex h-token-button-composer shrink-0 items-center justify-end gap-2"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <NodexDropdownMenu
        align="end"
        contentWidth="icon"
        onOpenChange={onOpenChange}
        triggerButton={<MoreActionsButton variant={variant} />}
      >
        {canTry ? (
          <NodexDropdownItem leftSlot={<TryNowIcon />} onSelect={() => actions.tryNow(row)}>
            Try now
          </NodexDropdownItem>
        ) : null}
        <NodexDropdownItem
          leftSlot={<GearIcon />}
          onSelect={() => navigation.onOpenSettings(selectorToRouteTarget(row))}
        >
          Manage
        </NodexDropdownItem>
        {variant === "settings" ? null : <NodexDropdownSeparator />}
        <NodexDropdownItem
          leftSlot={<TrashIcon />}
          disabled={uninstallDisabled}
          className="text-danger"
          onSelect={() => void actions.uninstall(row)}
        >
          {forcedLabel ?? "Uninstall"}
        </NodexDropdownItem>
      </NodexDropdownMenu>
    </div>
  );
}
