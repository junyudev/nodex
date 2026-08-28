import { useState } from "react";
import { SettingsGeneralIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
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

export interface LeftSidebarFooterProps {
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

export function LeftSidebarFooter({
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
}: LeftSidebarFooterProps) {
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
    <div className="flex items-center justify-between border-t border-(--sidebar-border) px-(--sidebar-shell-padding-x) py-(--sidebar-row-padding-y)">
      <NodexTooltip tooltipContent="Settings" side="top">
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-(--sidebar-foreground-secondary) hover:bg-(--sidebar-accent) hover:text-(--sidebar-foreground)"
          aria-label="Settings"
        >
          <SettingsGeneralIcon className="size-3.5" />
        </button>
      </NodexTooltip>
      {showQuotaRing && connection && onRefreshAccount && onLogout ? (
        <AccountRateLimitRing
          account={account ?? null}
          connection={connection}
          onRefreshAccount={onRefreshAccount}
          onConsumeRateLimitReset={onConsumeRateLimitReset}
          onLogout={onLogout}
          onErrorMessage={onErrorMessage}
        />
      ) : showSignIn && onCancelLogin ? (
        <AuthPopover
          account={account ?? null}
          busy={loginBusy}
          side="top"
          sideOffset={8}
          onChatGptLogin={() => void handleChatGptLogin()}
          onApiKeyLogin={(apiKey) => void handleApiKeyLogin(apiKey)}
          onCancelLogin={(loginId) => void handleCancelLogin(loginId)}
        />
      ) : null}
    </div>
  );
}
