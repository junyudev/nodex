import { FormattedMessage, defineMessage, useIntl } from "@/lib/i18n";
import { useState, type ReactElement } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { handleFormSubmit } from "@/lib/forms";
import type { CodexAccountSnapshot } from "../../../../lib/types";

export const signInToCodexMessage = defineMessage({
  id: "conversation.authControls.signInToCodex",
  defaultMessage: "Sign in to Codex",
});
export const SIGN_IN_TO_CODEX = signInToCodexMessage.defaultMessage;

/**
 * Signs Codex in from the given trigger. The trigger's tooltip and the popover both name Codex,
 * so the action is never mistaken for signing in to Nodex.
 */
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
  trigger: ReactElement;
  onChatGptLogin: () => void;
  onApiKeyLogin: (key: string) => void;
  onCancelLogin: (loginId: string) => void;
}) {
  const intl = useIntl();
  const signInLabel = intl.formatMessage(signInToCodexMessage);
  const [open, setOpen] = useState(false);
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
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexTooltip tooltipContent={signInLabel} side={side} disabled={open}>
        <NodexPopoverTrigger>{trigger}</NodexPopoverTrigger>
      </NodexTooltip>
      <NodexPopoverContent
        align="end"
        side={side}
        sideOffset={sideOffset}
        className="flex w-64 flex-col gap-2.5 p-3"
      >
        <div className="text-sm font-medium text-(--foreground)">{signInLabel}</div>
        {account?.pendingLogin ? (
          <div className="text-xs text-(--foreground-tertiary)">
            <FormattedMessage
              id="conversation.authControls.pending"
              defaultMessage="Login pending..."
            />{" "}
            <button
              type="button"
              className="underline hover:text-(--foreground-secondary)"
              onClick={() => onCancelLogin(account.pendingLogin!.loginId)}
            >
              <FormattedMessage id="conversation.authControls.cancel" defaultMessage="Cancel" />
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
              <FormattedMessage
                id="conversation.authControls.signInWithChatGPT"
                defaultMessage="Sign in with ChatGPT"
              />
            </button>
            <div className="relative">
              <div className="absolute inset-x-0 top-1/2 border-t border-(--border)" />
              <div className="relative flex justify-center">
                <span className="bg-(--popover) px-2 font-sans text-xs text-(--foreground-tertiary)">
                  <FormattedMessage id="conversation.authControls.or" defaultMessage="or" />
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
                placeholder={intl.formatMessage({
                  id: "conversation.authControls.apiKey",
                  defaultMessage: "API key",
                })}
                className="h-7 flex-1 rounded-md border border-(--border) bg-(--background) px-2 text-xs inset-shadow-field focus:ring-1 focus:ring-(--ring) focus:outline-none"
              />
              <button
                type="submit"
                className="h-7 shrink-0 rounded-md border border-(--border) px-2.5 text-xs font-medium hover:bg-(--background-tertiary)"
                disabled={busy || !apiKeyInput.trim()}
              >
                <FormattedMessage id="conversation.authControls.useKey" defaultMessage="Use key" />
              </button>
            </form>
          </>
        )}
      </NodexPopoverContent>
    </NodexPopover>
  );
}
