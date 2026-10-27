import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { TrashIcon } from "@/components/shared/icons/customize-action-icons";
import {
  GearIcon20,
  PlusMdIcon,
  ProfileLockIcon,
  TryInChatIcon,
} from "@/components/shared/icons/plugin-detail-icons";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { MoreActionsButton, ToolbarButton } from "@/components/ui/toolbar-button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { usePendingPluginActions } from "../model/install-sessions";
import { pluginDisabledReasonLabel, pluginPrimaryAction } from "../model/plugin-detail-model";
import type { PluginRow } from "../plugin-management";
import { forcedInstallLabel } from "./installed-plugin-actions-menu";

const WIDTH_EASE = [0.77, 0, 0.175, 1] as const;

/** Keeps a toolbar button's width while it is disabled, so a tooltip can still explain why. */
function DisabledWithTooltip({
  label,
  tooltip,
  children,
}: {
  readonly label: string;
  readonly tooltip: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <NodexTooltip tooltipContent={tooltip} side="top">
      <span
        role="button"
        tabIndex={0}
        aria-disabled="true"
        aria-label={label}
        className="inline-flex"
      >
        {children}
      </span>
    </NodexTooltip>
  );
}

/**
 * Animates the primary action's width as its label changes (Install plugin → Installing → Try
 * now), measuring an invisible copy. The first measurement and reduced motion jump instantly.
 */
function AnimatedPrimaryAction({
  measurement,
  children,
}: {
  readonly measurement: ReactNode;
  readonly children: ReactNode;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion() ?? false;
  const [width, setWidth] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);

  useLayoutEffect(() => {
    const element = measureRef.current;
    if (element == null) return;
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div
        ref={measureRef}
        aria-hidden
        inert
        className="pointer-events-none invisible fixed top-0 left-0 min-w-max"
      >
        {measurement}
      </div>
      <motion.div
        initial={false}
        animate={{ width: width ?? "auto" }}
        transition={{ duration: reducedMotion || !settled ? 0 : 0.18, ease: WIDTH_EASE }}
        onAnimationComplete={() => {
          if (width != null) setSettled(true);
        }}
        className="inline-flex shrink-0 justify-end overflow-hidden [&>button]:w-full [&>button]:min-w-0 [&>button]:shrink-0 [&>button]:justify-center [&>button]:overflow-hidden"
      >
        {children}
      </motion.div>
    </>
  );
}

export interface PluginDetailActionHandlers {
  readonly onInstall: () => void;
  readonly onEnable: () => Promise<void>;
  readonly onTryNow: () => void;
  readonly onUninstall: () => void;
  /** Opens the plugin's settings; omitted while there is no settings page for it. */
  readonly onManage?: () => void;
}

/** The detail page's "…" menu, Manage, and the primary action for the plugin's state. */
export function PluginDetailActions({
  row,
  handlers,
}: {
  readonly row: PluginRow;
  readonly handlers: PluginDetailActionHandlers;
}) {
  const pendingActions = usePendingPluginActions();
  const pending = pendingActions.get(row.stableIdentity);
  const installLocked = [...pendingActions.values()].includes("installing");
  const [enabling, setEnabling] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const action = pluginPrimaryAction({ row, pending });
  const installed = row.summary.installed && pending !== "installing";
  const forcedLabel = forcedInstallLabel(row);

  let primary: ReactNode;
  switch (action) {
    case "uninstalling":
      primary = (
        <ToolbarButton color="primary" disabled aria-busy className="disabled:opacity-100">
          <ActivitySpinnerIcon className="icon-xs" />
          Uninstalling
        </ToolbarButton>
      );
      break;
    case "installing":
      primary = (
        <ToolbarButton color="primary" disabled aria-busy className="disabled:opacity-100">
          <ActivitySpinnerIcon className="icon-xs" />
          Installing
        </ToolbarButton>
      );
      break;
    case "disabled_by_admin": {
      const label = pluginDisabledReasonLabel(row.summary.disabledReason, "Disabled by admin");
      const tooltip =
        row.summary.disabledReason === "required_app_unavailable"
          ? "This plugin can’t be used because a required app is unavailable"
          : row.summary.disabledReason === "disabled_by_admin" || row.summary.disabledReason == null
            ? "This plugin isn’t available to you"
            : label;
      primary = (
        <DisabledWithTooltip label={label} tooltip={tooltip}>
          <ToolbarButton color="primary" disabled aria-hidden>
            <ProfileLockIcon className="icon-sm" />
            {label}
          </ToolbarButton>
        </DisabledWithTooltip>
      );
      break;
    }
    case "unavailable":
      primary = (
        <DisabledWithTooltip
          label="Unavailable"
          tooltip="This plugin isn't available to install for your account or device"
        >
          <ToolbarButton color="primary" disabled aria-hidden>
            Unavailable
          </ToolbarButton>
        </DisabledWithTooltip>
      );
      break;
    case "install":
      primary = (
        <ToolbarButton
          color="primary"
          disabled={installLocked}
          className="focus-visible:ring-inset"
          onClick={handlers.onInstall}
        >
          <PlusMdIcon />
          Install plugin
        </ToolbarButton>
      );
      break;
    case "enable":
      primary = (
        <ToolbarButton
          color="primary"
          loading={enabling}
          className="focus-visible:ring-inset"
          onClick={() => {
            setEnabling(true);
            void handlers.onEnable().finally(() => setEnabling(false));
          }}
        >
          Enable
        </ToolbarButton>
      );
      break;
    case "try":
      primary = (
        <ToolbarButton
          color="primary"
          className="focus-visible:ring-inset"
          onClick={handlers.onTryNow}
        >
          <TryInChatIcon className="icon-xs" />
          Try now
        </ToolbarButton>
      );
      break;
  }

  const canUninstall = installed && row.canUninstall;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {canUninstall ? (
        <NodexDropdownMenu
          align="end"
          contentWidth="sm"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          triggerButton={<MoreActionsButton variant="toolbar" />}
        >
          <NodexDropdownItem
            leftSlot={<TrashIcon />}
            disabled={forcedLabel != null || enabling || pending === "uninstalling"}
            className="text-danger"
            onSelect={() => {
              setMenuOpen(false);
              handlers.onUninstall();
            }}
          >
            {forcedLabel ?? "Uninstall"}
          </NodexDropdownItem>
        </NodexDropdownMenu>
      ) : null}
      {installed && handlers.onManage != null ? (
        <ToolbarButton color="secondary" onClick={handlers.onManage}>
          <GearIcon20 />
          Manage
        </ToolbarButton>
      ) : null}
      <AnimatedPrimaryAction measurement={primary}>{primary}</AnimatedPrimaryAction>
    </div>
  );
}
