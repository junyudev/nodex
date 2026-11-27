import { useIntl } from "@/lib/i18n";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ComposerAdaptiveFooter,
  ComposerInput,
} from "@/components/composer/composer-adaptive-footer";
import { ComposerAttachments } from "@/components/composer/composer-attachments";
import { COMPOSER_PRIMARY_ACTION_BUTTON_CLASS_NAME } from "@/components/composer/composer-footer-controls";
import {
  COMPOSER_PROMPT_SCROLL_CLASS_NAME,
  COMPOSER_PROMPT_TEXT_CLASS_NAME,
  COMPOSER_SURFACE_CLASS_NAME,
} from "@/components/composer/composer-surface";
import { UpArrowIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { GitHubThreadDetail } from "../../../shared/github-thread";
import { gitHubThreadKindLabel } from "./github-thread-copy";
import type { GitHubThreadCommandRunner } from "./github-thread-surface-types";

/**
 * Writing back on the thread, as the connected account. The draft stays until GitHub has it, so
 * a failed post loses nothing.
 */
export function GitHubThreadComposer({
  detail,
  run,
  onPosted,
}: {
  readonly detail: GitHubThreadDetail;
  readonly run: GitHubThreadCommandRunner & {
    readonly post: (body: string) => Promise<boolean>;
  };
  readonly onPosted?: () => void;
}) {
  const intl = useIntl();
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const locked = !detail.viewer.canComment;
  const canSend = !locked && !posting && draft.trim().length > 0;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    setPosting(true);
    const posted = await run.post(draft.trim()).finally(() => setPosting(false));
    if (!posted) return;
    setDraft("");
    onPosted?.();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.repeat) return;
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return;
    event.preventDefault();
    void submit();
  };

  const sendLabel = intl.formatMessage({
    id: "githubThread.composer.comment",
    defaultMessage: "Comment",
  });
  return (
    <form
      data-github-thread-composer=""
      onSubmit={(event) => void submit(event)}
      className={cn("relative flex flex-col", COMPOSER_SURFACE_CLASS_NAME)}
    >
      {/* Empty, it keeps the top inset every composer has above its text. */}
      <ComposerAttachments />
      <ComposerAdaptiveFooter
        layout="multiline"
        input={
          <ComposerInput layout="multiline">
            <textarea
              aria-label={intl.formatMessage(
                { id: "githubThread.composer.label", defaultMessage: "Comment on this {kind}" },
                { kind: gitHubThreadKindLabel(intl, detail.kind) },
              )}
              rows={1}
              readOnly={locked || posting}
              value={draft}
              placeholder={
                locked
                  ? intl.formatMessage({
                      id: "githubThread.composer.locked",
                      defaultMessage: "This conversation is locked",
                    })
                  : intl.formatMessage(
                      {
                        id: "githubThread.composer.placeholder",
                        defaultMessage: "Comment as {login}",
                      },
                      { login: detail.viewer.login },
                    )
              }
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              className={cn(
                COMPOSER_PROMPT_TEXT_CLASS_NAME,
                COMPOSER_PROMPT_SCROLL_CLASS_NAME,
                "block min-h-11 w-full resize-none bg-transparent outline-none [field-sizing:content] placeholder:text-token-input-placeholder-foreground placeholder:opacity-50",
              )}
            />
          </ComposerInput>
        }
        leadingControls={null}
        trailingControls={
          <div className="flex justify-end">
            <NodexTooltip tooltipContent={sendLabel} shortcutLabel="⌘↵" side="top">
              <button
                type="submit"
                aria-label={sendLabel}
                disabled={!canSend}
                className={cn(COMPOSER_PRIMARY_ACTION_BUTTON_CLASS_NAME, !canSend && "opacity-50")}
              >
                <UpArrowIcon className="icon-sm" />
              </button>
            </NodexTooltip>
          </div>
        }
      />
    </form>
  );
}
