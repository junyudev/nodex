import { useState, type ComponentProps, type ReactNode } from "react";
import { NODEX_ACCOUNT_ERROR_COPY } from "../../../shared/nodex-account-copy";
import { ActivitySpinnerIcon, SettingsGeneralIcon } from "@/components/shared/icons";
import { SignInIcon, SignOutIcon } from "@/components/shared/icons/account-icons";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDropdownContent,
  NodexDropdownItem,
  NodexDropdownMessage,
  NodexDropdownPortal,
  NodexDropdownRoot,
  NodexDropdownSeparator,
  NodexDropdownTrigger,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  NodexAccountAvatar,
  resolveNodexAccountView,
  type NodexAccountView,
} from "./nodex-account-identity";
import { useNodexAccount } from "./use-nodex-account";

const TRIGGER_LABEL = "Account and settings";

// Account menu palette: primary, secondary, tertiary, border, hover, and opaque surface at 0.9.
const ACCOUNT_MENU_SURFACE_CLASS =
  "bg-[rgb(255_255_255/0.9)] text-[#1a1c1f] ring-[rgba(26,28,31,0.078)] dark:bg-[rgb(45_45_45/0.9)] dark:text-[#dfdfdf] dark:ring-[rgba(255,255,255,0.084)]";
const ACCOUNT_MENU_TEXT_CLASS = "text-[#1a1c1f] dark:text-[#dfdfdf]";
const ACCOUNT_MENU_SECONDARY_CLASS =
  "text-[rgba(26,28,31,0.695)] dark:text-[rgba(255,255,255,0.71)]";
const ACCOUNT_MENU_DETAIL_CLASS = "text-[rgba(26,28,31,0.495)] dark:text-[rgba(255,255,255,0.498)]";
const ACCOUNT_MENU_HOVER_CLASS =
  "hover:bg-[rgba(26,28,31,0.053)] focus:bg-[rgba(26,28,31,0.053)] dark:hover:bg-[rgba(255,255,255,0.078)] dark:focus:bg-[rgba(255,255,255,0.078)]";
const ACCOUNT_MENU_SEPARATOR_CLASS =
  "[&>div]:bg-[rgba(26,28,31,0.078)] dark:[&>div]:bg-[rgba(255,255,255,0.084)]";

/** Menu row in the account palette; decorative `icon`s rest at 75% and brighten with the row. */
function AccountMenuItem({
  icon,
  leftSlot,
  disabled = false,
  className,
  ...props
}: ComponentProps<typeof NodexDropdownItem> & { icon?: ReactNode }) {
  return (
    <NodexDropdownItem
      {...props}
      disabled={disabled}
      leftSlot={
        icon ? (
          <span
            className={cn(
              "inline-flex opacity-75",
              ACCOUNT_MENU_TEXT_CLASS,
              !disabled && "group-hover:opacity-100 group-focus:opacity-100",
            )}
          >
            {icon}
          </span>
        ) : (
          leftSlot
        )
      }
      className={cn(ACCOUNT_MENU_TEXT_CLASS, !disabled && ACCOUNT_MENU_HOVER_CLASS, className)}
    />
  );
}

export interface NodexAccountMenuProps {
  readonly onOpenSettings: () => void;
  readonly onOpenAccountSettings: () => void;
  /** Resolved Settings shortcut label; absent when the command is unbound. */
  readonly settingsShortcutLabel?: string;
  readonly className?: string;
}

/** The rail's profile control: optional Nodex Account identity plus the always-available Settings. */
export function NodexAccountMenu({
  onOpenSettings,
  onOpenAccountSettings,
  settingsShortcutLabel,
  className,
}: NodexAccountMenuProps) {
  const account = useNodexAccount(true);
  const view = resolveNodexAccountView(account);
  const [open, setOpen] = useState(false);
  const attention = view.reauthentication || view.notice?.tone === "error";
  const detail = view.reauthentication ? (
    <span className="text-token-warning-foreground">Session ended</span>
  ) : view.offline ? (
    "Offline"
  ) : (
    view.identity?.detail
  );

  return (
    <NodexDropdownRoot open={open} onOpenChange={setOpen}>
      <NodexTooltip
        tooltipContent={view.identity?.label ?? TRIGGER_LABEL}
        side="right"
        disabled={open}
      >
        <NodexDropdownTrigger nativeButton>
          <NodexButton
            variant="ghost"
            size="icon"
            aria-label={TRIGGER_LABEL}
            aria-busy={view.signingIn || undefined}
            data-nodex-account-status={view.status ?? "local"}
            className={cn("relative", className)}
          >
            <NodexAccountAvatar
              identity={view.identity}
              className={cn(view.signingIn && "animate-pulse motion-reduce:animate-none")}
            />
            {attention ? (
              <span
                aria-hidden="true"
                className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-(--yellow-text)"
              />
            ) : null}
          </NodexButton>
        </NodexDropdownTrigger>
      </NodexTooltip>
      <NodexDropdownPortal>
        <NodexDropdownContent
          side="right"
          align="end"
          sideOffset={4}
          alignOffset={-4}
          className={cn("w-[240px]", ACCOUNT_MENU_SURFACE_CLASS)}
        >
          {view.identity ? (
            <>
              <AccountMenuItem
                leftSlot={<NodexAccountAvatar identity={view.identity} size="sm" />}
                subText={
                  detail ? <span className={ACCOUNT_MENU_DETAIL_CLASS}>{detail}</span> : null
                }
                onSelect={onOpenAccountSettings}
              >
                {view.identity.label}
              </AccountMenuItem>
              <NodexDropdownSeparator className={ACCOUNT_MENU_SEPARATOR_CLASS} />
            </>
          ) : null}
          <AccountMenuItem
            icon={<SettingsGeneralIcon />}
            keyboardShortcut={
              settingsShortcutLabel ? (
                <span aria-hidden="true" className={ACCOUNT_MENU_DETAIL_CLASS}>
                  {settingsShortcutLabel}
                </span>
              ) : undefined
            }
            onSelect={onOpenSettings}
          >
            Settings
          </AccountMenuItem>
          <AccountMenuActions account={account} view={view} />
        </NodexDropdownContent>
      </NodexDropdownPortal>
    </NodexDropdownRoot>
  );
}

function AccountMenuActions({
  account,
  view,
}: {
  account: ReturnType<typeof useNodexAccount>;
  view: NodexAccountView;
}) {
  if (!view.configured || account.failed) return null;
  const busy = account.pending !== null;

  return (
    <>
      <NodexDropdownSeparator className={ACCOUNT_MENU_SEPARATOR_CLASS} />
      {view.notice ? (
        <NodexDropdownMessage
          compact
          tone={view.notice.tone === "error" ? "error" : "muted"}
          className={cn("text-xs", view.notice.tone !== "error" && ACCOUNT_MENU_SECONDARY_CLASS)}
        >
          {view.notice.message}
        </NodexDropdownMessage>
      ) : view.reauthentication && !view.identity ? (
        <NodexDropdownMessage
          compact
          tone="muted"
          className={cn("text-xs", ACCOUNT_MENU_SECONDARY_CLASS)}
        >
          {NODEX_ACCOUNT_ERROR_COPY["invalid-grant"].message}
        </NodexDropdownMessage>
      ) : null}
      {view.signingIn ? (
        <AccountMenuItem
          disabled={busy}
          icon={<ActivitySpinnerIcon />}
          onSelect={() => account.act("cancelSignIn")}
        >
          Cancel sign-in
        </AccountMenuItem>
      ) : null}
      {view.signedOut || view.reauthentication ? (
        <AccountMenuItem
          disabled={busy}
          icon={<SignInIcon />}
          onSelect={() => account.act("signIn")}
        >
          {view.reauthentication ? "Sign in again" : "Sign in"}
        </AccountMenuItem>
      ) : null}
      {view.signedIn || view.reauthentication ? (
        <AccountMenuItem
          disabled={busy}
          icon={<SignOutIcon />}
          onSelect={() => account.act("signOut")}
        >
          Sign out
        </AccountMenuItem>
      ) : null}
    </>
  );
}
