import { useState } from "react";
import { SettingsGeneralIcon } from "@/components/shared/icons";
import { UserRound } from "@/components/shared/icons/generic-icons";
import { OpenAIIcon } from "@/components/shared/icons/provider-icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { WORKBENCH_RAIL_BUTTON_CLASS } from "./workbench-app-rail";
import { AccountRateLimitRing } from "@/features/local-conversation/view/shared/account-rate-limit-ring";
import { AuthPopover } from "@/features/local-conversation/view/shared/auth-controls";
import {
  resolveRailAccountState,
  type RailAccountState,
} from "@/features/local-conversation/view/shared/rail-account-state";
import { cn } from "@/lib/utils";
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
  account?: CodexAccountSnapshot | null;
  connection?: CodexConnectionState;
  onRefreshAccount?: () => Promise<CodexAccountSnapshot>;
  onConsumeRateLimitReset?: (input: CodexRateLimitResetInput) => Promise<CodexRateLimitResetResult>;
  onStartChatGptLogin?: () => Promise<CodexLoginStartResult>;
  onStartApiKeyLogin?: (apiKey: string) => Promise<CodexLoginStartResult>;
  onCancelLogin?: (loginId: string) => Promise<unknown>;
  onLogout?: () => Promise<void>;
  onErrorMessage?: (message: string | null) => void;
}

/**
 * Holds the account slot while the Codex account is unknown: a gray Codex mark that breathes
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
        <span className="relative inline-flex">
          <OpenAIIcon
            className={cn(
              "size-4.5 text-(--sidebar-foreground-tertiary)",
              (loading || refreshing) && "animate-pulse motion-reduce:animate-none",
            )}
          />
          {loading ? null : (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-(--yellow-text)"
            />
          )}
        </span>
      </NodexButton>
    </NodexTooltip>
  );
}

/**
 * App-wide controls at the foot of the navigation rail: the account control
 * (usage ring when signed in, sign-in when signed out, the gray Codex mark while
 * the account is unknown), then Settings. Settings stays last so it never moves
 * when the account state becomes known.
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
}: WorkbenchRailAccountControlsProps) {
  const [loginBusy, setLoginBusy] = useState(false);
  const accountState = resolveRailAccountState(account ?? null, connection);
  const showQuotaRing = Boolean(
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
        {showQuotaRing && connection && onRefreshAccount && onLogout ? (
          <span className="inline-flex animate-in duration-200 fade-in-0 zoom-in-90 motion-reduce:animate-none">
            <AccountRateLimitRing
              account={account ?? null}
              connection={connection}
              onRefreshAccount={onRefreshAccount}
              onConsumeRateLimitReset={onConsumeRateLimitReset}
              onLogout={onLogout}
              onErrorMessage={onErrorMessage}
              className="h-9 w-9"
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
