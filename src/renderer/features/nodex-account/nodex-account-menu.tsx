import { useState, type ComponentProps, type ReactNode } from "react";
import { NODEX_ACCOUNT_ERROR_COPY } from "../../../shared/nodex-account-copy";
import {
  spaceAvailabilityLabel,
  type SpaceConnectionSummary,
} from "../../../shared/space-connection";
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
import { useOpenJoinSpace } from "@/features/spaces/join-space-dialog";
import { SpaceAvatar } from "@/features/spaces/space-avatar";
import { SPACE_AVAILABILITY_DOT, SpaceMenuItems } from "@/features/spaces/space-switching";
import { useSpaces } from "@/features/spaces/spaces-runtime";
import { cn } from "@/lib/utils";
import {
  NodexAccountAvatar,
  resolveNodexAccountView,
  type NodexAccountView,
} from "./nodex-account-identity";
import { useNodexAccount } from "./use-nodex-account";

const TRIGGER_LABEL = "Spaces and settings";

/** Leading visuals share the Space avatars' 20px column, so every label lines up. */
function AccountMenuItem({
  icon,
  leftSlot,
  disabled = false,
  ...props
}: ComponentProps<typeof NodexDropdownItem> & { icon?: ReactNode }) {
  return (
    <NodexDropdownItem
      {...props}
      disabled={disabled}
      leftSlot={
        <span
          className={cn(
            "inline-flex size-5 items-center justify-center",
            // Decorative icons rest at 75% and brighten with the menu row.
            icon && "opacity-75",
            icon && !disabled && "group-hover:opacity-100 group-focus:opacity-100",
          )}
        >
          {icon ?? leftSlot}
        </span>
      }
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

/**
 * The rail's foot control: which Space this window shows and who you are. Its face is the team
 * Space's avatar, or your Nodex Account in your personal Space; its menu switches and joins
 * Spaces, then keeps the optional Nodex Account and the always-available Settings.
 */
export function NodexAccountMenu({
  onOpenSettings,
  onOpenAccountSettings,
  settingsShortcutLabel,
  className,
}: NodexAccountMenuProps) {
  const account = useNodexAccount(true);
  const view = resolveNodexAccountView(account);
  const { spaces, current } = useSpaces();
  const [open, setOpen] = useState(false);
  const spaceStatus =
    current.availability === "ready" ? null : spaceAvailabilityLabel(current.availability);
  // One dot: a Space its host cannot serve outranks an account that needs attention.
  const attention =
    current.availability !== "ready"
      ? current.availability
      : view.reauthentication || view.notice?.tone === "error"
        ? "account"
        : null;

  return (
    <NodexDropdownRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) account.act("refreshModels");
      }}
    >
      <NodexTooltip
        tooltipContent={
          <span className="flex flex-col gap-0.5">
            <span>{spaceStatus ? `${current.name} · ${spaceStatus}` : current.name}</span>
            {view.identity ? (
              <span className="text-token-description-foreground">
                {view.reauthentication
                  ? `${view.identity.label} · Session ended`
                  : view.identity.label}
              </span>
            ) : null}
          </span>
        }
        side="right"
        disabled={open}
      >
        <NodexDropdownTrigger nativeButton>
          <NodexButton
            variant="ghostSecondary"
            size="icon"
            aria-label={TRIGGER_LABEL}
            aria-busy={view.signingIn || undefined}
            data-nodex-account-status={view.status ?? "local"}
            className={className}
          >
            <span className="relative inline-flex">
              <span
                className={cn(
                  "inline-flex",
                  view.signingIn && "animate-pulse motion-reduce:animate-none",
                )}
              >
                {current.kind === "team" ? (
                  <SpaceAvatar space={current} size="rail" />
                ) : (
                  <NodexAccountAvatar identity={view.identity} />
                )}
              </span>
              {attention ? (
                <span
                  aria-hidden="true"
                  data-attention={attention}
                  className={cn(
                    // The rail's attention dot, as on its usage meters: it sits in the face's
                    // corner notch, where no cut-out ring has to guess the translucent rail color.
                    "absolute -top-0.5 -right-0.5 size-1.5 rounded-full",
                    attention === "account"
                      ? "bg-(--yellow-text)"
                      : SPACE_AVAILABILITY_DOT[attention],
                  )}
                />
              ) : null}
            </span>
          </NodexButton>
        </NodexDropdownTrigger>
      </NodexTooltip>
      <NodexDropdownPortal>
        <NodexAccountMenuContent
          spaces={spaces}
          current={current}
          account={account}
          view={view}
          onOpenSettings={onOpenSettings}
          onOpenAccountSettings={onOpenAccountSettings}
          settingsShortcutLabel={settingsShortcutLabel}
        />
      </NodexDropdownPortal>
    </NodexDropdownRoot>
  );
}

/** Mounted only while the menu is open. */
function NodexAccountMenuContent({
  spaces,
  current,
  account,
  view,
  onOpenSettings,
  onOpenAccountSettings,
  settingsShortcutLabel,
}: Omit<NodexAccountMenuProps, "className"> & {
  readonly spaces: readonly SpaceConnectionSummary[];
  readonly current: SpaceConnectionSummary;
  readonly account: ReturnType<typeof useNodexAccount>;
  readonly view: NodexAccountView;
}) {
  const openJoin = useOpenJoinSpace();
  const [joinPending, setJoinPending] = useState(false);
  const detail = view.reauthentication ? (
    <span className="text-token-warning-foreground">Session ended</span>
  ) : view.offline ? (
    "Offline"
  ) : (
    view.identity?.detail
  );

  return (
    <NodexDropdownContent
      side="right"
      align="end"
      sideOffset={4}
      alignOffset={-4}
      className="w-[240px]"
      finalFocus={() => {
        if (!joinPending) return true;
        // Join a Space opens its dialog once the menu has closed; the dialog takes focus.
        setJoinPending(false);
        openJoin();
        return false;
      }}
    >
      <SpaceMenuItems spaces={spaces} current={current} onJoin={() => setJoinPending(true)} />
      <NodexDropdownSeparator />
      {view.identity ? (
        <AccountMenuItem
          leftSlot={<NodexAccountAvatar identity={view.identity} size="sm" />}
          subText={detail ? <span className="text-tertiary">{detail}</span> : null}
          onSelect={onOpenAccountSettings}
        >
          {view.identity.label}
        </AccountMenuItem>
      ) : null}
      <AccountMenuItem
        icon={<SettingsGeneralIcon />}
        keyboardShortcut={
          settingsShortcutLabel ? (
            <span aria-hidden="true" className="text-tertiary">
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
      {view.notice ? (
        <NodexDropdownMessage
          compact
          tone={view.notice.tone === "error" ? "error" : "muted"}
          className={cn("text-xs", view.notice.tone !== "error" && "semantic-text-secondary")}
        >
          {view.notice.message}
        </NodexDropdownMessage>
      ) : view.reauthentication && !view.identity ? (
        <NodexDropdownMessage compact tone="muted" className="text-xs semantic-text-secondary">
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
