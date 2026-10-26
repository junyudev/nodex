import { useRef, useState } from "react";
import { NodexAccountMenu } from "@/features/nodex-account/nodex-account-menu";
import { UserRound } from "@/components/shared/icons/generic-icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { WORKBENCH_RAIL_BUTTON_CLASS } from "./workbench-app-rail";
import { RailUsageMeter, UsageRingGlyph } from "./workbench-rail-usage-meter";
import { shouldRefreshAccountOnConnectionTooltipOpen } from "@/features/local-conversation/view/shared/account-tooltip-refresh";
import { AuthPopover } from "@/features/local-conversation/view/shared/auth-controls";
import { QuotaResetTooltipSection } from "@/features/local-conversation/view/shared/auth-rate-limits";
import { resolveRailAccountState } from "@/features/local-conversation/view/shared/rail-account-state";
import { cn } from "@/lib/utils";
import { useClaudeUsage, type ClaudeUsage } from "@/lib/use-claude-usage";
import {
  claudeUsageAccounts,
  claudeUsagePlaceholder,
  codexUsageReading,
  type ClaudeUsageAccount,
  type UsageProvider,
} from "@/lib/usage-meter";
import type {
  CodexAccountSnapshot,
  CodexConnectionState,
  CodexRateLimitResetInput,
  CodexRateLimitResetResult,
} from "@/lib/types";
import type { IpcApi } from "../../../shared/ipc-api";

type CodexLoginStartResult = IpcApi["codex:account:login:start"]["result"];

export interface WorkbenchRailAccountControlsProps {
  onOpenSettings: () => void;
  onOpenAccountSettings: () => void;
  settingsShortcutLabel?: string;
  account?: CodexAccountSnapshot | null;
  connection?: CodexConnectionState;
  onRefreshAccount?: () => Promise<CodexAccountSnapshot>;
  onConsumeRateLimitReset?: (input: CodexRateLimitResetInput) => Promise<CodexRateLimitResetResult>;
  onStartChatGptLogin?: () => Promise<CodexLoginStartResult>;
  onStartApiKeyLogin?: (apiKey: string) => Promise<CodexLoginStartResult>;
  onCancelLogin?: (loginId: string) => Promise<unknown>;
  onLogout?: () => Promise<void>;
  onErrorMessage?: (message: string | null) => void;
  /** Claude subscription usage as Main keeps it: one meter per account. */
  claudeUsage?: ClaudeUsage;
}

type RailUsagePlaceholderState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string; readonly detail?: string | null };

/**
 * Holds a provider's slot while nothing about it is known yet: an unread meter that breathes
 * while it loads and rests with a status dot when it cannot load. Either way a click asks again.
 */
function RailUsagePlaceholder({
  provider,
  subject,
  state,
  onRetry,
}: {
  readonly provider: UsageProvider;
  /** What is loading, such as `Codex account`. */
  readonly subject: string;
  readonly state: RailUsagePlaceholderState;
  readonly onRetry?: () => Promise<unknown>;
}) {
  const [retrying, setRetrying] = useState(false);
  const loading = state.kind === "loading";
  const label = loading ? `Loading ${subject}` : `${state.reason}. Retrying automatically`;
  const retry = () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    void onRetry()
      .catch(() => {})
      .finally(() => setRetrying(false));
  };
  return (
    <NodexTooltip
      side="right"
      tooltipContent={
        <span className="flex flex-col gap-0.5">
          <span>{loading ? `Loading ${subject}…` : state.reason}</span>
          {loading ? null : (
            <span className="text-token-description-foreground">
              {state.detail ? <span className="block">{state.detail}</span> : null}
              Retrying automatically. Click to try now.
            </span>
          )}
        </span>
      }
    >
      <NodexButton
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-busy={loading || retrying}
        data-rail-account-state={state.kind}
        className={cn(WORKBENCH_RAIL_BUTTON_CLASS, "relative")}
        onClick={retry}
      >
        <span className="inline-flex text-(--sidebar-foreground-tertiary)">
          <UsageRingGlyph
            provider={provider}
            track="dotted"
            pulse={loading || retrying}
            alert={!loading}
          />
        </span>
      </NodexButton>
    </NodexTooltip>
  );
}

/** Asks once for a fresh reading each time a usage card opens, never twice at a time. */
function useRefreshOnOpen(refresh: () => Promise<unknown>): (open: boolean) => void {
  const inFlight = useRef(false);
  return (open) => {
    if (
      !shouldRefreshAccountOnConnectionTooltipOpen({
        isOpen: open,
        hasAccount: true,
        refreshInFlight: inFlight.current,
      })
    )
      return;
    inFlight.current = true;
    void refresh()
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
      });
  };
}

/** A usage card's header action that signs the account out on this computer. */
function UsageSignOutButton({
  onSignOut,
  onErrorMessage,
}: {
  readonly onSignOut: () => Promise<unknown>;
  readonly onErrorMessage?: (message: string | null) => void;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    setSigningOut(true);
    onErrorMessage?.(null);
    try {
      await onSignOut();
    } catch (error) {
      onErrorMessage?.(error instanceof Error ? error.message : "Logout failed");
    } finally {
      setSigningOut(false);
    }
  };
  return (
    <button
      type="button"
      className="h-6 shrink-0 rounded-md px-1.5 text-xs text-token-text-secondary outline-none hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-(--ring)/35 disabled:opacity-40"
      onClick={() => void signOut()}
      disabled={signingOut}
    >
      Sign out
    </button>
  );
}

/**
 * The signed-in Codex account's meter. Its card adds signing out and spending a quota reset.
 * Opening it asks Codex once for a fresh reading, as Codex also does on its own every minute.
 */
function CodexUsageMeter({
  account,
  onRefreshAccount,
  onConsumeRateLimitReset,
  onLogout,
  onErrorMessage,
}: {
  readonly account: CodexAccountSnapshot;
  readonly onRefreshAccount: () => Promise<CodexAccountSnapshot>;
  readonly onConsumeRateLimitReset?: (
    input: CodexRateLimitResetInput,
  ) => Promise<CodexRateLimitResetResult>;
  readonly onLogout: () => Promise<void>;
  readonly onErrorMessage?: (message: string | null) => void;
}) {
  const refreshOnOpen = useRefreshOnOpen(onRefreshAccount);
  const reading = codexUsageReading(account);
  if (!reading) return null;
  return (
    <RailUsageMeter
      reading={reading}
      onOpenChange={refreshOnOpen}
      action={<UsageSignOutButton onSignOut={onLogout} onErrorMessage={onErrorMessage} />}
    >
      {account.rateLimitResetCredits && onConsumeRateLimitReset ? (
        <QuotaResetTooltipSection
          summary={account.rateLimitResetCredits}
          onReset={onConsumeRateLimitReset}
        />
      ) : null}
    </RailUsageMeter>
  );
}

/**
 * One Claude account's meter. Opening its card asks Main for a fresh reading, starting Agent
 * execution if it must; on its own Main reads only while execution runs. Signing out signs out
 * every Claude profile that reads it.
 */
function ClaudeUsageMeter({
  account,
  usage,
  onErrorMessage,
}: {
  readonly account: ClaudeUsageAccount;
  readonly usage: ClaudeUsage;
  readonly onErrorMessage?: (message: string | null) => void;
}) {
  const refreshOnOpen = useRefreshOnOpen(usage.refresh);
  return (
    <RailUsageMeter
      reading={account.reading}
      onOpenChange={refreshOnOpen}
      action={
        <UsageSignOutButton
          onSignOut={() => usage.logout(account.instanceIds)}
          onErrorMessage={onErrorMessage}
        />
      }
    />
  );
}

/**
 * App-wide controls at the foot of the navigation rail: the Codex account control (its usage
 * meter when signed in, sign-in when signed out, an unread Codex meter while the account is
 * unknown), one usage meter per Claude subscription account (an unread Claude meter until Main
 * has read any), then the Nodex Account menu. The menu stays last so it never moves when
 * provider account state becomes known.
 */
export function WorkbenchRailAccountControls({
  onOpenSettings,
  onOpenAccountSettings,
  settingsShortcutLabel,
  account,
  connection,
  onRefreshAccount,
  onConsumeRateLimitReset,
  onStartChatGptLogin,
  onStartApiKeyLogin,
  onCancelLogin,
  onLogout,
  onErrorMessage,
  claudeUsage,
}: WorkbenchRailAccountControlsProps) {
  const [loginBusy, setLoginBusy] = useState(false);
  const accountState = resolveRailAccountState(account ?? null, connection);
  const showUsageMeter = Boolean(
    accountState.kind === "signedIn" && connection && onRefreshAccount && onLogout,
  );
  const showSignIn = Boolean(
    accountState.kind === "signedOut" && onStartChatGptLogin && onStartApiKeyLogin && onCancelLogin,
  );
  const claudeAccounts = claudeUsageAccounts(claudeUsage?.snapshot);
  const claudePlaceholder = claudeUsagePlaceholder(claudeUsage?.snapshot);

  const handleChatGptLogin = async () => {
    if (!onStartChatGptLogin) return;

    setLoginBusy(true);
    onErrorMessage?.(null);

    try {
      const result = await onStartChatGptLogin();
      if (result.type === "chatgpt" && result.authUrl) {
        window.open(result.authUrl, "_blank");
      }
    } catch (error) {
      onErrorMessage?.(error instanceof Error ? error.message : "Login failed");
    } finally {
      setLoginBusy(false);
    }
  };

  const handleApiKeyLogin = async (apiKey: string) => {
    if (!onStartApiKeyLogin) return;

    setLoginBusy(true);
    onErrorMessage?.(null);

    try {
      await onStartApiKeyLogin(apiKey);
    } catch (error) {
      onErrorMessage?.(error instanceof Error ? error.message : "Login failed");
    } finally {
      setLoginBusy(false);
    }
  };

  const handleCancelLogin = async (loginId: string) => {
    if (!onCancelLogin) return;

    onErrorMessage?.(null);

    try {
      await onCancelLogin(loginId);
    } catch (error) {
      onErrorMessage?.(error instanceof Error ? error.message : "Failed to cancel login");
    }
  };

  return (
    <div
      data-workbench-rail-account-controls=""
      className="mt-auto flex flex-col items-center gap-2"
    >
      <div data-workbench-rail-account="" className="contents">
        {showUsageMeter && account && onRefreshAccount && onLogout ? (
          <span className="inline-flex animate-in duration-200 fade-in-0 zoom-in-90 motion-reduce:animate-none">
            <CodexUsageMeter
              account={account}
              onRefreshAccount={onRefreshAccount}
              onConsumeRateLimitReset={onConsumeRateLimitReset}
              onLogout={onLogout}
              onErrorMessage={onErrorMessage}
            />
          </span>
        ) : showSignIn && onCancelLogin ? (
          <AuthPopover
            account={account ?? null}
            busy={loginBusy}
            side="right"
            sideOffset={8}
            trigger={
              <NodexButton
                variant="ghost"
                size="icon"
                aria-label="Sign in"
                className={WORKBENCH_RAIL_BUTTON_CLASS}
              >
                <UserRound className="icon-sm" />
              </NodexButton>
            }
            onChatGptLogin={() => void handleChatGptLogin()}
            onApiKeyLogin={(apiKey) => void handleApiKeyLogin(apiKey)}
            onCancelLogin={(loginId) => void handleCancelLogin(loginId)}
          />
        ) : accountState.kind === "loading" || accountState.kind === "unavailable" ? (
          <RailUsagePlaceholder
            provider="codex"
            subject="Codex account"
            state={accountState}
            onRetry={onRefreshAccount}
          />
        ) : null}
        {claudeUsage
          ? claudeAccounts.map((claude) => (
              <span
                key={claude.reading.key}
                className="inline-flex animate-in duration-200 fade-in-0 zoom-in-90 motion-reduce:animate-none"
              >
                <ClaudeUsageMeter
                  account={claude}
                  usage={claudeUsage}
                  onErrorMessage={onErrorMessage}
                />
              </span>
            ))
          : null}
        {claudeUsage && claudePlaceholder ? (
          <RailUsagePlaceholder
            provider="claude"
            subject="Claude usage"
            state={
              claudePlaceholder.kind === "loading"
                ? claudePlaceholder
                : {
                    kind: "unavailable",
                    reason: "Can't read Claude usage",
                    detail: claudePlaceholder.reason,
                  }
            }
            onRetry={claudeUsage.refresh}
          />
        ) : null}
      </div>
      <NodexAccountMenu
        onOpenSettings={onOpenSettings}
        onOpenAccountSettings={onOpenAccountSettings}
        settingsShortcutLabel={settingsShortcutLabel}
        className={WORKBENCH_RAIL_BUTTON_CLASS}
      />
    </div>
  );
}

/**
 * The rail foot with Main's Claude usage. Kept as its own leaf so a new reading re-renders only
 * these controls.
 */
export function WorkbenchRailFoot(props: Omit<WorkbenchRailAccountControlsProps, "claudeUsage">) {
  return <WorkbenchRailAccountControls {...props} claudeUsage={useClaudeUsage()} />;
}
