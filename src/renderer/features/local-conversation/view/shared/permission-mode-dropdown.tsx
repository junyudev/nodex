import { useRef, useState, type ComponentType } from "react";
import type { RuntimeMode } from "@nodex/agent-runtime/contracts";
import {
  PermissionAskForApprovalIcon,
  PermissionDefaultIcon,
  PermissionFullAccessIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexDropdownTitle,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import { cn } from "@/lib/utils";
import {
  COMPOSER_FOOTER_COMPACT_GHOST_BUTTON_CLASS_NAME,
  COMPOSER_FOOTER_GHOST_ICON_BUTTON_CLASS_NAME,
  COMPOSER_FOOTER_LABEL_WIDE_CLASS_NAME,
} from "./composer-footer-controls";
import { FullAccessPermissionConfirmationDialog } from "./full-access-permission-confirmation-dialog";
import {
  isAgentRuntimeModeSupported,
  requiresFullAccessConfirmation,
} from "@/lib/agent-runtime-mode";
import { PERMISSION_MODES, permissionModePresentation } from "./permission-mode";

const MODE_ICONS: Record<RuntimeMode, ComponentType<{ className?: string }>> = {
  "approval-required": PermissionAskForApprovalIcon,
  auto: PermissionDefaultIcon,
  "full-access": PermissionFullAccessIcon,
};

const FULL_ACCESS_ACCENT = "text-token-editor-warning-foreground";

function accentFor(mode: RuntimeMode): string | undefined {
  return mode === "full-access" ? FULL_ACCESS_ACCENT : undefined;
}

export function PermissionModeIcon({ mode, className }: { mode: RuntimeMode; className?: string }) {
  const Icon = MODE_ICONS[mode];
  return <Icon className={cn("icon-xs shrink-0", accentFor(mode), className)} />;
}

export interface PermissionModeDropdownProps {
  readonly mode: RuntimeMode;
  /** Modes the selected Agent enforces; absent or empty means every mode. */
  readonly supportedModes?: readonly RuntimeMode[] | null;
  /** The Agent name used to explain an unavailable mode. */
  readonly agentLabel?: string | null;
  /**
   * `composer` shows only the icon while the chat matches the Profile default and names the mode
   * once it differs; `settings` always names it.
   */
  readonly triggerStyle: "composer" | "settings";
  readonly emphasized?: boolean;
  readonly disabled?: boolean;
  /** A running turn keeps its access; the change applies from the next message. */
  readonly appliesNextMessage?: boolean;
  readonly onSelect: (mode: RuntimeMode) => void | Promise<void>;
}

export function PermissionModeDropdown({
  mode,
  supportedModes,
  agentLabel,
  triggerStyle,
  emphasized = false,
  disabled = false,
  appliesNextMessage = false,
  onSelect,
}: PermissionModeDropdownProps) {
  const appHandle = useScopeHandle(appScope);
  const pendingConfirmationRef = useRef(false);
  const [pending, setPending] = useState(false);
  const current = permissionModePresentation(mode);

  const select = async (next: RuntimeMode) => {
    if (pending || next === mode) return;
    setPending(true);
    try {
      await onSelect(next);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not change permissions");
    } finally {
      setPending(false);
    }
  };

  const showLabel = triggerStyle === "settings" || emphasized;
  const trigger =
    triggerStyle === "settings" ? (
      <NodexSettingsDropdownTrigger aria-label="Default permissions" className="min-w-48">
        <PermissionModeIcon mode={mode} />
        <span className={cn("max-w-40 truncate text-left", accentFor(mode))}>{current.label}</span>
      </NodexSettingsDropdownTrigger>
    ) : (
      <button
        type="button"
        aria-label={`Permissions: ${current.label}`}
        disabled={disabled}
        className={
          showLabel
            ? COMPOSER_FOOTER_COMPACT_GHOST_BUTTON_CLASS_NAME
            : COMPOSER_FOOTER_GHOST_ICON_BUTTON_CLASS_NAME
        }
      >
        <PermissionModeIcon mode={mode} />
        {showLabel ? (
          <span className={cn(COMPOSER_FOOTER_LABEL_WIDE_CLASS_NAME, accentFor(mode))}>
            {current.label}
          </span>
        ) : null}
      </button>
    );

  return (
    <NodexDropdownMenu
      disabled={disabled}
      triggerButton={trigger}
      triggerTooltipContent={
        triggerStyle === "composer" ? (
          <span>
            Permissions <span className="text-token-description-foreground">{current.label}</span>
          </span>
        ) : undefined
      }
      side={triggerStyle === "settings" ? "bottom" : "top"}
      align={triggerStyle === "settings" ? "end" : "start"}
      contentWidth="panel"
      finalFocus={() => {
        if (!pendingConfirmationRef.current) return true;
        pendingConfirmationRef.current = false;
        openModal(appHandle, FullAccessPermissionConfirmationDialog, {
          onConfirm: () => {
            void select("full-access");
          },
        });
        return false;
      }}
    >
      <NodexDropdownTitle>
        {triggerStyle === "settings"
          ? "New chats start with"
          : appliesNextMessage
            ? "Permissions · from your next message"
            : "Permissions"}
      </NodexDropdownTitle>
      {PERMISSION_MODES.map((entry) => {
        const supported = isAgentRuntimeModeSupported(entry.mode, supportedModes);
        const accent = accentFor(entry.mode);
        return (
          <NodexDropdownItem
            key={entry.mode}
            disabled={pending || !supported}
            focusableWhenDisabled
            tooltipText={
              supported ? undefined : `Not available for ${agentLabel?.trim() || "this Agent"}`
            }
            leftSlot={<PermissionModeIcon mode={entry.mode} className="size-4!" />}
            rightSlot={
              entry.mode === mode ? <NodexDropdownSelectedIcon className={accent} /> : null
            }
            subText={entry.description}
            subTextAllowWrap
            allowWrap
            onSelect={(event) => {
              if (!supported) {
                event.preventDefault();
                return;
              }
              if (requiresFullAccessConfirmation(mode, entry.mode)) {
                pendingConfirmationRef.current = true;
                return;
              }
              void select(entry.mode);
            }}
          >
            <span className={accent}>{entry.label}</span>
          </NodexDropdownItem>
        );
      })}
    </NodexDropdownMenu>
  );
}
