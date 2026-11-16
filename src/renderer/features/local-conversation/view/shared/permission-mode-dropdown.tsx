import { useIntl } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
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
} from "@/components/composer/composer-footer-controls";
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
  const intl = useIntl();
  const appHandle = useScopeHandle(appScope);
  const pendingConfirmationRef = useRef(false);
  const [pending, setPending] = useState(false);
  const currentLabel = intl.formatMessage(permissionModePresentation(mode).label);

  const select = async (next: RuntimeMode) => {
    if (pending || next === mode) return;
    setPending(true);
    return runWithCleanup(
      async () => {
        await onSelect(next);
      },
      {
        onError: (error) => {
          toast.danger(
            error instanceof Error
              ? error.message
              : intl.formatMessage({
                  id: "conversation.permissionModeDropdown.changeError",
                  defaultMessage: "Could not change permissions",
                }),
          );
        },
        cleanup: () => {
          setPending(false);
        },
      },
    );
  };

  const showLabel = triggerStyle === "settings" || emphasized;
  const trigger =
    triggerStyle === "settings" ? (
      <NodexSettingsDropdownTrigger
        aria-label={intl.formatMessage({
          id: "conversation.permissionModeDropdown.defaults",
          defaultMessage: "Default permissions",
        })}
        className="min-w-48"
      >
        <PermissionModeIcon mode={mode} />
        <span className={cn("max-w-40 truncate text-left", accentFor(mode))}>{currentLabel}</span>
      </NodexSettingsDropdownTrigger>
    ) : (
      <button
        type="button"
        aria-label={intl.formatMessage(
          {
            id: "conversation.permissionModeDropdown.permissionsLabel",
            defaultMessage: "Permissions: {permission}",
          },
          { permission: currentLabel },
        )}
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
            {currentLabel}
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
            {intl.formatMessage({
              id: "conversation.permissionModeDropdown.permissions",
              defaultMessage: "Permissions",
            })}{" "}
            <span className="text-token-description-foreground">{currentLabel}</span>
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
          ? intl.formatMessage({
              id: "conversation.permissionModeDropdown.newChats",
              defaultMessage: "New chats start with",
            })
          : appliesNextMessage
            ? intl.formatMessage({
                id: "conversation.permissionModeDropdown.nextMessage",
                defaultMessage: "Permissions · from your next message",
              })
            : intl.formatMessage({
                id: "conversation.permissionModeDropdown.permissions",
                defaultMessage: "Permissions",
              })}
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
              supported
                ? undefined
                : intl.formatMessage(
                    {
                      id: "conversation.permissionModeDropdown.agentUnavailable",
                      defaultMessage: "Not available for {agent}",
                    },
                    {
                      agent:
                        agentLabel?.trim() ||
                        intl.formatMessage({
                          id: "conversation.permissionModeDropdown.thisAgent",
                          defaultMessage: "this Agent",
                        }),
                    },
                  )
            }
            leftSlot={<PermissionModeIcon mode={entry.mode} className="size-4!" />}
            rightSlot={
              entry.mode === mode ? <NodexDropdownSelectedIcon className={accent} /> : null
            }
            subText={intl.formatMessage(entry.description)}
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
            <span className={accent}>{intl.formatMessage(entry.label)}</span>
          </NodexDropdownItem>
        );
      })}
    </NodexDropdownMenu>
  );
}
