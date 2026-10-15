import { useState } from "react";
import { SettingsGeneralIcon } from "@/components/shared/icons";
import { UserRound } from "@/components/shared/icons/generic-icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { WORKBENCH_RAIL_BUTTON_CLASS } from "./workbench-app-rail";
import { AccountRateLimitRing } from "@/features/local-conversation/view/shared/account-rate-limit-ring";
import { AuthPopover } from "@/features/local-conversation/view/shared/auth-controls";
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
 * App-wide controls at the foot of the navigation rail: the account control
 * (usage ring when signed in, sign-in when signed out), then Settings. Settings
 * stays last so it never moves when the account state becomes known.
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
  const showQuotaRing = Boolean(account?.account && connection && onRefreshAccount && onLogout);
  const showSignIn = Boolean(
    account && !account.account && onStartChatGptLogin && onStartApiKeyLogin && onCancelLogin,
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
          <AccountRateLimitRing
            account={account ?? null}
            connection={connection}
            onRefreshAccount={onRefreshAccount}
            onConsumeRateLimitReset={onConsumeRateLimitReset}
            onLogout={onLogout}
            onErrorMessage={onErrorMessage}
            className="h-9 w-9"
          />
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
