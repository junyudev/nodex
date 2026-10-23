import type { ReactElement } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { handleFormSubmit } from "@/lib/forms";
import type { CodexAccountSnapshot } from "../../../../lib/types";

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
