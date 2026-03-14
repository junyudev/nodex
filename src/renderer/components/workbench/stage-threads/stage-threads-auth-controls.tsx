import { useForm, useStore } from "@tanstack/react-form";
import { type ReactNode } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Tooltip } from "@/components/ui/tooltip";
import { handleFormSubmit } from "@/lib/forms";
import { cn } from "../../../lib/utils";
import type { CodexAccountSnapshot, CodexConnectionState } from "../../../lib/types";
import type { StageThreadsBusyAction } from "../stage-threads-composer-action";
import { RateLimitTooltipSection } from "./stage-threads-auth-rate-limits";

function connectionLabel(status: CodexConnectionState["status"]): string {
  if (status === "connected") return "Connected";
  if (status === "starting") return "Connecting...";
  if (status === "missingBinary") return "Codex CLI missing";
  if (status === "error") return "Error";
  return "Disconnected";
}

export function renderConnectionAccountTooltipContent(
  account: NonNullable<CodexAccountSnapshot["account"]>,
  rateLimits: CodexAccountSnapshot["rateLimits"] | undefined,
  options?: {
    onSignOut?: () => void;
    isSigningOutDisabled?: boolean;
  },
) {
  if (account.type === "apiKey") {
    return (
      <div className="flex min-w-28 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <div className="text-xs text-(--foreground-tertiary)">Connected via</div>
          <div className="text-sm font-medium text-(--foreground)">API key</div>
        </div>
        <RateLimitTooltipSection rateLimits={rateLimits} />
        {options?.onSignOut && (
          <button
            type="button"
            className="self-start text-xs text-(--foreground-secondary) transition-colors duration-150 hover:text-(--destructive) disabled:opacity-50"
            onClick={options.onSignOut}
            disabled={options.isSigningOutDisabled}
          >
            Sign out
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-28 flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <div className="text-xs text-(--foreground-tertiary)">Connected as</div>
        <div className="text-sm font-medium text-(--foreground)">{account.email}</div>
        <div className="text-xs text-(--foreground-secondary)">ChatGPT {account.planType}</div>
      </div>
      <RateLimitTooltipSection rateLimits={rateLimits} />
      {options?.onSignOut && (
        <button
          type="button"
          className="self-start text-xs text-(--foreground-secondary) transition-colors duration-150 hover:text-(--destructive) disabled:opacity-50"
          onClick={options.onSignOut}
          disabled={options.isSigningOutDisabled}
        >
          Sign out
        </button>
      )}
    </div>
  );
}

// ── Connection badge ─────────────────────────────────────────────────────────

function connectionBadgeClasses(status: CodexConnectionState["status"]): string {
  if (status === "connected") return "bg-[var(--green-bg)] text-[var(--green-text)]";
  if (status === "starting") return "bg-[var(--yellow-bg)] text-[var(--yellow-text)]";
  return "bg-[var(--background-tertiary)] text-[var(--foreground-tertiary)]";
}

export function ConnectionBadge({
  connection,
  tooltipContent,
  onTooltipOpenChange,
}: {
  connection: CodexConnectionState;
  tooltipContent: ReactNode | null;
  onTooltipOpenChange?: (open: boolean) => void;
}) {
  const badge = (
    <button
      type="button"
      aria-label="Connection details"
      className={cn(
        "flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-(--ring)",
        tooltipContent ? "cursor-help" : "cursor-default",
        connectionBadgeClasses(connection.status),
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {connectionLabel(connection.status)}
    </button>
  );

  if (!tooltipContent) return badge;

  return (
    <Tooltip
      content={tooltipContent}
      side="bottom"
      sideOffset={8}
      delayDuration={0}
      onOpenChange={onTooltipOpenChange}
      enableHoverableContent
    >
      {badge}
    </Tooltip>
  );
}

// ── Auth popover ─────────────────────────────────────────────────────────────

export function AuthPopover({
  account,
  busyAction,
  onChatGptLogin,
  onApiKeyLogin,
  onCancelLogin,
}: {
  account: CodexAccountSnapshot | null;
  busyAction: StageThreadsBusyAction | null;
  onChatGptLogin: () => void;
  onApiKeyLogin: (key: string) => void;
  onCancelLogin: (loginId: string) => void;
}) {
  const apiKeyForm = useForm({
    defaultValues: {
      apiKey: "",
    },
    onSubmit: ({ value, formApi }) => {
      const apiKey = value.apiKey.trim();
      if (!apiKey) return;
      onApiKeyLogin(apiKey);
      formApi.reset();
    },
  });
  const apiKeyInput = useStore(apiKeyForm.store, (state) => state.values.apiKey);

  if (account?.account) return null;

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="h-5 shrink-0 rounded-full bg-(--foreground) px-2 text-xs font-medium text-(--background) outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--ring)"
        >
          Sign in
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          side="bottom"
          sideOffset={6}
          className={cn(
            "z-50 w-64 space-y-3 rounded-lg border p-3 shadow-lg",
            "border-(--border) bg-(--popover)",
            "animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2",
            "outline-none",
          )}
        >
          {account?.pendingLogin ? (
            <div className="text-xs text-(--foreground-tertiary)">
              Login pending...{" "}
              <button
                type="button"
                className="underline hover:text-(--foreground-secondary)"
                onClick={() => onCancelLogin(account.pendingLogin!.loginId)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="h-7 w-full rounded-md bg-(--foreground) text-xs font-medium text-(--background) shadow-card-xs hover:opacity-90"
                onClick={onChatGptLogin}
                disabled={busyAction !== null}
              >
                Sign in with ChatGPT
              </button>
              <div className="relative">
                <div className="absolute inset-x-0 top-1/2 border-t border-(--border)" />
                <div className="relative flex justify-center">
                  <span className="bg-(--popover) px-2 text-[10px] text-(--foreground-tertiary)">or</span>
                </div>
              </div>
              <form
                className="flex items-center gap-1.5"
                onSubmit={(event) => handleFormSubmit(event, apiKeyForm.handleSubmit)}
              >
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(event) => {
                    apiKeyForm.setFieldValue("apiKey", event.target.value);
                  }}
                  placeholder="API key"
                  className="h-7 flex-1 rounded-md border border-(--border) bg-(--background) px-2 text-xs inset-shadow-field focus:ring-1 focus:ring-(--ring) focus:outline-none"
                />
                <button
                  type="submit"
                  className="h-7 shrink-0 rounded-md border border-(--border) px-2.5 text-xs font-medium transition-colors duration-150 hover:bg-(--background-tertiary)"
                  disabled={busyAction !== null || !apiKeyInput.trim()}
                >
                  Use key
                </button>
              </form>
            </>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
