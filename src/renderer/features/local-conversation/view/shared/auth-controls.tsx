import { useForm, useStore } from "@tanstack/react-form";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { handleFormSubmit } from "@/lib/forms";
import type {
  CodexAccountSnapshot,
  CodexRateLimitResetInput,
  CodexRateLimitResetResult,
} from "../../../../lib/types";
import { RateLimitTooltipSection } from "./auth-rate-limits";

export function renderConnectionAccountTooltipContent(
  account: NonNullable<CodexAccountSnapshot["account"]>,
  rateLimits: CodexAccountSnapshot["rateLimits"] | undefined,
  options?: {
    onSignOut?: () => void;
    isSigningOutDisabled?: boolean;
    rateLimitResetCredits?: CodexAccountSnapshot["rateLimitResetCredits"];
    onConsumeRateLimitReset?: (
      input: CodexRateLimitResetInput,
    ) => Promise<CodexRateLimitResetResult>;
  },
) {
  if (account.type === "apiKey") {
    return (
      <div className="flex w-60 flex-col gap-2 p-3">
        <div className="flex flex-col gap-0.5">
          <div className="text-xs text-(--foreground-tertiary)">Connected via</div>
          <div className="text-sm font-medium text-(--foreground)">API key</div>
        </div>
        <RateLimitTooltipSection
          rateLimits={rateLimits}
          quotaResetCredits={options?.rateLimitResetCredits}
          onQuotaReset={options?.onConsumeRateLimitReset}
        />
        {options?.onSignOut && (
          <button
            type="button"
            className="self-start text-xs text-(--foreground-secondary) hover:text-(--destructive) disabled:opacity-50"
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
    <div className="flex w-60 flex-col gap-2 p-3">
      <div className="flex flex-col gap-0.5">
        <div className="text-xs text-(--foreground-tertiary)">Connected as</div>
        <div className="text-sm font-medium text-(--foreground)">{account.email}</div>
        <div className="text-xs text-(--foreground-secondary)">ChatGPT {account.planType}</div>
      </div>
      <RateLimitTooltipSection
        rateLimits={rateLimits}
        quotaResetCredits={options?.rateLimitResetCredits}
        onQuotaReset={options?.onConsumeRateLimitReset}
      />
      {options?.onSignOut && (
        <button
          type="button"
          className="self-start text-xs text-(--foreground-secondary) hover:text-(--destructive) disabled:opacity-50"
          onClick={options.onSignOut}
          disabled={options.isSigningOutDisabled}
        >
          Sign out
        </button>
      )}
    </div>
  );
}

export function AuthPopover({
  account,
  busy,
  side = "bottom",
  sideOffset,
  onChatGptLogin,
  onApiKeyLogin,
  onCancelLogin,
}: {
  account: CodexAccountSnapshot | null;
  busy: boolean;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
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

  if (account === null || account.account) return null;

  return (
    <NodexPopover>
      <NodexPopoverTrigger>
        <button
          type="button"
          className="h-5 shrink-0 rounded-full bg-(--foreground) px-2 text-xs font-medium text-(--background) outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--ring)"
        >
          Sign in
        </button>
      </NodexPopoverTrigger>
      <NodexPopoverContent align="end" side={side} sideOffset={sideOffset} className="w-64 p-3">
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
              disabled={busy}
            >
              Sign in with ChatGPT
            </button>
            <div className="relative">
              <div className="absolute inset-x-0 top-1/2 border-t border-(--border)" />
              <div className="relative flex justify-center">
                <span className="bg-(--popover) px-2 font-sans text-xs text-(--foreground-tertiary)">
                  or
                </span>
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
                className="h-7 shrink-0 rounded-md border border-(--border) px-2.5 text-xs font-medium hover:bg-(--background-tertiary)"
                disabled={busy || !apiKeyInput.trim()}
              >
                Use key
              </button>
            </form>
          </>
        )}
      </NodexPopoverContent>
    </NodexPopover>
  );
}
