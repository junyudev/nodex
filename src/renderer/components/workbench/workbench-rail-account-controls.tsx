import { useRef, useState } from "react";
import { SettingsGeneralIcon } from "@/components/shared/icons";
import { UserRound } from "@/components/shared/icons/generic-icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { WORKBENCH_RAIL_BUTTON_CLASS } from "./workbench-app-rail";
import { RailUsageMeter, UsageRingGlyph } from "./workbench-rail-usage-meter";
import { shouldRefreshAccountOnConnectionTooltipOpen } from "@/features/local-conversation/view/shared/account-tooltip-refresh";
import { AuthPopover } from "@/features/local-conversation/view/shared/auth-controls";
import { QuotaResetTooltipSection } from "@/features/local-conversation/view/shared/auth-rate-limits";
import {
  resolveRailAccountState,
  type RailAccountState,
} from "@/features/local-conversation/view/shared/rail-account-state";
import { cn } from "@/lib/utils";
import { useClaudeUsageReadings } from "@/lib/use-claude-usage-readings";
import { codexUsageReading, type UsageReading } from "@/lib/usage-meter";
import type {
  CodexAccountSnapshot,
  CodexConnectionState,
  CodexRateLimitResetInput,
  CodexRateLimitResetResult,
} from "@/lib/types";
import type { IpcApi } from "../../../shared/ipc-api";

type CodexLoginStartResult = IpcApi["codex:account:login:start"]["result"];

const NO_USAGE_READINGS: readonly UsageReading[] = [];

export interface WorkbenchRailAccountControlsProps {
  onOpenSettings: () => void;
  account?: CodexAccountSnapshot | null;
  connection?: CodexConnectionState;
  onRefreshAccount?: () => Promise<CodexAccountSnapshot>;
  onConsumeRateLimitReset?: (input: CodexRateLimitResetInput) => Promise<CodexRateLimitResetResult>;
  onStartChatGptLogin?: () => Promise<CodexLoginStartResult>;
  onStartApiKeyLogin?: (apiKey: string) => Promise<CodexLoginStartResult>;
  onCancelLogin?: (loginId: string) => Promise<unknown>;
  onLogout?: () => Promise<void>;
  onErrorMessage?: (message: string | null) => void;
  /** Claude subscription accounts, one meter each, read from what Nodex already knows. */
  claudeUsage?: readonly UsageReading[];
}

/**
 * Holds the account slot while the Codex account is unknown: an unread Codex meter that breathes
 * while it loads and rests with a status dot when it cannot load. Either way a click asks again.
 */
function RailAccountPlaceholder({
  state,
  onRefreshAccount,
}: {
  readonly state: Extract<RailAccountState, { kind: "loading" | "unavailable" }>;
  readonly onRefreshAccount?: () => Promise<CodexAccountSnapshot>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const loading = state.kind === "loading";
  const label = loading ? "Loading Codex account" : `${state.reason}. Retrying automatically`;
  const refresh = () => {
    if (!onRefreshAccount || refreshing) return;
    setRefreshing(true);
    void onRefreshAccount()
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };
  return (
    <NodexTooltip
      side="right"
      tooltipContent={
        <span className="flex flex-col gap-0.5">
          <span>{loading ? "Loading Codex account…" : state.reason}</span>
          {loading ? null : (
            <span className="text-token-description-foreground">
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
        aria-busy={loading || refreshing}
        data-rail-account-state={state.kind}
        className={cn(WORKBENCH_RAIL_BUTTON_CLASS, "relative")}
        onClick={refresh}
      >
        <span className="inline-flex text-(--sidebar-foreground-tertiary)">
          <UsageRingGlyph
            provider="codex"
            track="dotted"
            pulse={loading || refreshing}
            alert={!loading}
          />
        </span>
      </NodexButton>
    </NodexTooltip>
  );
}

/**
 * The signed-in Codex account's meter. Its card adds what only Codex offers: signing out and
 * spending a quota reset. Opening it asks Codex once for a fresh reading, as Codex also does on
 * its own every minute.
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
  const [isSigningOut, setIsSigningOut] = useState(false);
  const refreshInFlightRef = useRef(false);
  const reading = codexUsageReading(account);
  if (!reading) return null;

  const handleOpenChange = (isOpen: boolean) => {
    if (
      !shouldRefreshAccountOnConnectionTooltipOpen({
        isOpen,
        hasAccount: Boolean(account.account),
        refreshInFlight: refreshInFlightRef.current,
      })
    )
      return;
    refreshInFlightRef.current = true;
    void onRefreshAccount()
      .catch(() => {})
      .finally(() => {
        refreshInFlightRef.current = false;
      });
  };
  const handleLogout = async () => {
    setIsSigningOut(true);
    onErrorMessage?.(null);
    try {
      await onLogout();
    } catch (error) {
      onErrorMessage?.(error instanceof Error ? error.message : "Logout failed");
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <RailUsageMeter
      reading={reading}
      onOpenChange={handleOpenChange}
      action={
        <button
          type="button"
          className="h-6 shrink-0 rounded-md px-1.5 text-xs text-token-text-secondary outline-none hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-(--ring)/35 disabled:opacity-40"
          onClick={() => void handleLogout()}
          disabled={isSigningOut}
        >
          Sign out
        </button>
      }
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
 * App-wide controls at the foot of the navigation rail: the Codex account control (its usage
 * meter when signed in, sign-in when signed out, an unread Codex meter while the account is
 * unknown), one usage meter per Claude subscription account, then Settings. Settings stays last
 * so it never moves when the account state becomes known.
 */
export function WorkbenchRailAccountControls({
  onOpenSettings,
  account,
  connection,
  onRefreshAccount,
  onConsumeRateLimitReset,
  onStartChatGptLogin,
  onStartApiKeyLogin,
  onCancelLogin,
  onLogout,
  onErrorMessage,
  claudeUsage = NO_USAGE_READINGS,
}: WorkbenchRailAccountControlsProps) {
  const [loginBusy, setLoginBusy] = useState(false);
  const accountState = resolveRailAccountState(account ?? null, connection);
  const showUsageMeter = Boolean(
    accountState.kind === "signedIn" && connection && onRefreshAccount && onLogout,
  );
  const showSignIn = Boolean(
    accountState.kind === "signedOut" && onStartChatGptLogin && onStartApiKeyLogin && onCancelLogin,
  );

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
          <RailAccountPlaceholder state={accountState} onRefreshAccount={onRefreshAccount} />
        ) : null}
        {claudeUsage.map((reading) => (
          <span
            key={reading.key}
            className="inline-flex animate-in duration-200 fade-in-0 zoom-in-90 motion-reduce:animate-none"
          >
            <RailUsageMeter reading={reading} />
          </span>
        ))}
      </div>
      <NodexTooltip tooltipContent="Settings" side="right">
        <NodexButton
          variant="ghost"
          size="icon"
          aria-label="Settings"
          className={WORKBENCH_RAIL_BUTTON_CLASS}
          onClick={onOpenSettings}
        >
          <SettingsGeneralIcon className="icon-sm" />
        </NodexButton>
      </NodexTooltip>
    </div>
  );
}

/**
 * The rail foot with Claude usage read from what Nodex already knows. Kept as its own leaf so a new
 * reading re-renders only these controls.
 */
export function WorkbenchRailFoot(props: Omit<WorkbenchRailAccountControlsProps, "claudeUsage">) {
  return <WorkbenchRailAccountControls {...props} claudeUsage={useClaudeUsageReadings()} />;
}
