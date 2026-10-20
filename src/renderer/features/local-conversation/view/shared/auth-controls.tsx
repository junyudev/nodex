import type { ReactElement } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import type { PlanType } from "@nodex/codex-app-server-protocol";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { handleFormSubmit } from "@/lib/forms";
import type {
  CodexAccountSnapshot,
  CodexRateLimitResetInput,
  CodexRateLimitResetResult,
} from "../../../../lib/types";
import { RateLimitTooltipSection } from "./auth-rate-limits";

const CHATGPT_PLAN_LABELS: Readonly<Record<PlanType, string | null>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  promax: "Pro Max",
  team: "Team",
  business: "Business",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  enterprise: "Enterprise",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
  unknown: null,
};

/** Names a ChatGPT plan for display, title-casing plans this build does not know yet. */
function formatChatGptPlan(planType: string): string {
  const known: Readonly<Record<string, string | null>> = CHATGPT_PLAN_LABELS;
  const label = Object.hasOwn(known, planType)
    ? known[planType]
    : planType
        .split("_")
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
  return label ? `ChatGPT ${label}` : "ChatGPT";
}

export function ConnectionAccountCard({
  account,
  rateLimits,
  rateLimitResetCredits,
  onConsumeRateLimitReset,
  onSignOut,
  isSigningOut = false,
}: {
  account: NonNullable<CodexAccountSnapshot["account"]>;
  rateLimits: CodexAccountSnapshot["rateLimits"] | undefined;
  rateLimitResetCredits?: CodexAccountSnapshot["rateLimitResetCredits"];
  onConsumeRateLimitReset?: (input: CodexRateLimitResetInput) => Promise<CodexRateLimitResetResult>;
  onSignOut?: () => void;
  isSigningOut?: boolean;
}) {
  const [title, detail] =
    account.type === "apiKey"
      ? ["OpenAI API key", null]
      : [account.email, formatChatGptPlan(account.planType)];

  return (
    <div className="flex w-64 flex-col">
      <div className="flex items-center gap-2 py-2.5 pr-2 pl-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-token-foreground">{title}</div>
          {detail ? (
            <div className="text-xs text-token-description-foreground">{detail}</div>
          ) : null}
        </div>
        {onSignOut ? (
          <button
            type="button"
            className="h-6 shrink-0 rounded-md px-1.5 text-xs text-token-text-secondary outline-none hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-(--ring)/35 disabled:opacity-40"
            onClick={onSignOut}
            disabled={isSigningOut}
          >
            Sign out
          </button>
        ) : null}
      </div>
      <RateLimitTooltipSection
        rateLimits={rateLimits}
        quotaResetCredits={rateLimitResetCredits}
        onQuotaReset={onConsumeRateLimitReset}
      />
    </div>
  );
}

export function AuthPopover({
  account,
  busy,
  side = "bottom",
  sideOffset,
  trigger,
  onChatGptLogin,
  onApiKeyLogin,
  onCancelLogin,
}: {
  account: CodexAccountSnapshot | null;
  busy: boolean;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  /** Replaces the compact `Sign in` pill, for example with a rail icon button. */
  trigger?: ReactElement;
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
        {trigger ?? (
          <button
            type="button"
            className="h-5 shrink-0 rounded-full bg-(--foreground) px-2 text-xs font-medium text-(--background) outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--ring)"
          >
            Sign in
          </button>
        )}
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
