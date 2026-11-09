import { useLayoutEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import {
  ComposerAdaptiveFooter,
  ComposerInput,
} from "@/components/composer/composer-adaptive-footer";
import { ComposerAttachments } from "@/components/composer/composer-attachments";
import { COMPOSER_PRIMARY_ACTION_BUTTON_CLASS_NAME } from "@/components/composer/composer-footer-controls";
import {
  COMPOSER_DROP_TARGET_CLASS_NAME,
  COMPOSER_PROMPT_SCROLL_CLASS_NAME,
  COMPOSER_PROMPT_TEXT_CLASS_NAME,
  COMPOSER_SURFACE_CLASS_NAME,
} from "@/components/composer/composer-surface";
import {
  MessageImagePicker,
  MessageImageRow,
  useMessageImageInput,
  type MessageDraftImage,
  type MessageImageAccess,
} from "@/components/message/message-images-input";
import { CloseIcon, NodexLogoMarkIcon, UpArrowIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isEmptyInboxDraft, type InboxDraft } from "./inbox-capture-state";
import { MAX_INBOX_TITLE_LENGTH } from "../../../shared/schemas/inbox";

import { useInboxReplyDestination } from "./use-inbox-reply-destination";
import type { InboxReplyDestination } from "../../../shared/inbox";

const FIELD_CLASS_NAME =
  "block w-full bg-transparent outline-none placeholder:text-token-input-placeholder-foreground placeholder:opacity-50";

/**
 * The capture owner persists drafts and each submission before clearing this input. Images
 * pasted, dropped, or picked are imported as Library Files and attached after the text. A
 * message is named for it unless its sender gives a title, on a line above the text that its
 * host opens; a title already in the draft always shows, so it is never sent unseen.
 *
 * It has a chat composer's rows: the text above, the controls beneath. The text area sizes to
 * what it holds and scrolls by itself once full, so a title stays in view above it.
 */
export function InboxComposer({
  onSend,
  draft,
  onDraftChange,
  images,
  disabled = false,
  readOnly = false,
  focusToken,
  placeholder = "Drop a thought, task, or question…",
  titleOpen = false,
  onTitleOpenChange,
}: {
  readonly onSend: () => Promise<unknown>;
  readonly draft: InboxDraft;
  /** Applied to the draft as it is when written, since an image import finishes later. */
  readonly onDraftChange: (change: (draft: InboxDraft) => InboxDraft) => void;
  /** Null until the Inbox can import images. */
  readonly images: MessageImageAccess | null;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  /** Changing this value focuses the composer, for example after a keyboard shortcut. */
  readonly focusToken?: number;
  readonly placeholder?: string;
  /** Shows the title line even while it is empty; opening it moves the keyboard there. */
  readonly titleOpen?: boolean;
  readonly onTitleOpenChange?: (open: boolean) => void;
}) {
  const observedDestination = useInboxReplyDestination(draft.replyTo?.pageId, draft.text);
  const replyDestination =
    draft.replyTo?.turnEpisode && observedDestination?.kind === "nodex"
      ? { ...observedDestination, kind: "unavailable" as const }
      : observedDestination;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const showTitle = titleOpen || draft.title !== "";
  const input = useMessageImageInput({
    access: readOnly ? null : images,
    onImported: (added: readonly MessageDraftImage[]) =>
      onDraftChange((current) => ({ ...current, images: [...current.images, ...added] })),
  });
  const canSend = !disabled && !input.importing && !isEmptyInboxDraft(draft);

  const focusedTokenRef = useRef<{ token: number | undefined } | null>(null);
  useLayoutEffect(() => {
    if (focusedTokenRef.current?.token === focusToken && focusedTokenRef.current !== null) return;
    focusedTokenRef.current = { token: focusToken };
    textareaRef.current?.focus();
  }, [focusToken]);

  // An opened title takes the keyboard as it appears, before another keystroke reaches the text.
  const titleWasOpen = useRef(titleOpen);
  useLayoutEffect(() => {
    if (titleOpen && !titleWasOpen.current) titleRef.current?.focus();
    titleWasOpen.current = titleOpen;
  }, [titleOpen]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    await onSend();
    onTitleOpenChange?.(false);
    textareaRef.current?.focus();
  };

  const stopReplying = () => onDraftChange((current) => ({ ...current, replyTo: null }));

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Escape in an empty reply lets go of the post it answers, the way it was taken up.
    if (
      event.key === "Escape" &&
      draft.replyTo &&
      draft.text === "" &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.stopPropagation();
      stopReplying();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      textareaRef.current?.focus();
      return;
    }
    // An empty title steps aside the way it came, back to the message.
    if ((event.key === "Backspace" || event.key === "Escape") && draft.title === "") {
      event.preventDefault();
      event.stopPropagation();
      onTitleOpenChange?.(false);
      textareaRef.current?.focus();
    }
  };

  return (
    <form
      data-testid="inbox-composer"
      onSubmit={(event) => void submit(event)}
      data-file-drop-active={input.dropActive ? "true" : "false"}
      {...input.dropTarget}
      className={cn(
        "relative flex flex-col",
        COMPOSER_SURFACE_CLASS_NAME,
        input.dropActive && COMPOSER_DROP_TARGET_CLASS_NAME,
      )}
    >
      {draft.replyTo ? (
        <div
          data-testid="inbox-composer-reply"
          className="flex min-w-0 items-center gap-1.5 pt-0.5 pr-1 pl-3 text-xs text-token-description-foreground"
        >
          {!draft.replyTo.turnEpisode ? (
            <NodexLogoMarkIcon monochrome className="size-3.5 shrink-0" />
          ) : null}
          <span className="min-w-0 truncate">
            Replying to <span className="text-token-foreground">{draft.replyTo.label}</span>
          </span>
          {replyDestination ? (
            <span className="max-w-1/2 min-w-0 shrink-0 truncate" aria-label="Reply destination">
              <ReplyDestinationPhrase destination={replyDestination} />
            </span>
          ) : null}
          <NodexTooltip tooltipContent="Stop replying" side="top">
            <button
              type="button"
              aria-label="Stop replying"
              onClick={stopReplying}
              className="cursor-interaction ml-auto flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-token-foreground/5 hover:text-token-foreground"
            >
              <CloseIcon className="icon-2xs" />
            </button>
          </NodexTooltip>
        </div>
      ) : null}
      <ComposerAttachments>
        <MessageImageRow
          images={draft.images}
          input={input}
          readAuthority={images?.readAuthority ?? null}
          onRemove={(fileId) =>
            onDraftChange((current) => ({
              ...current,
              images: current.images.filter((image) => image.fileId !== fileId),
            }))
          }
        />
      </ComposerAttachments>
      <ComposerAdaptiveFooter
        layout="multiline"
        input={
          <ComposerInput layout="multiline">
            {showTitle ? (
              <input
                ref={titleRef}
                aria-label="Message title"
                placeholder="Title"
                readOnly={readOnly}
                value={draft.title}
                maxLength={MAX_INBOX_TITLE_LENGTH}
                onChange={(event) => {
                  const title = event.currentTarget.value;
                  onDraftChange((current) => ({ ...current, title }));
                }}
                onKeyDown={handleTitleKeyDown}
                className={cn(
                  COMPOSER_PROMPT_TEXT_CLASS_NAME,
                  FIELD_CLASS_NAME,
                  "pb-1 font-semibold placeholder:font-normal",
                )}
              />
            ) : null}
            <textarea
              ref={textareaRef}
              aria-label="Message your Inbox"
              rows={1}
              readOnly={readOnly}
              value={draft.text}
              placeholder={
                draft.replyTo?.turnEpisode
                  ? "Reply to chat…"
                  : draft.replyTo
                    ? "Reply to Nodex…"
                    : placeholder
              }
              onChange={(event) => {
                const text = event.currentTarget.value;
                onDraftChange((current) => ({ ...current, text }));
              }}
              onPaste={input.onPaste}
              onKeyDown={handleKeyDown}
              className={cn(
                COMPOSER_PROMPT_TEXT_CLASS_NAME,
                COMPOSER_PROMPT_SCROLL_CLASS_NAME,
                FIELD_CLASS_NAME,
                "resize-none [field-sizing:content]",
                // Opening a title takes the room of the text's second line, not the page's.
                showTitle ? "min-h-5" : "min-h-11",
              )}
            />
          </ComposerInput>
        }
        leadingControls={
          images ? <MessageImagePicker onFiles={input.add} disabled={readOnly} /> : null
        }
        trailingControls={
          <div className="flex justify-end">
            <NodexTooltip
              tooltipContent={draft.replyTo?.turnEpisode ? "Send reply" : "Send to Inbox"}
              shortcutLabel="↵"
              side="top"
            >
              <button
                type="submit"
                aria-label={draft.replyTo?.turnEpisode ? "Send reply" : "Send to Inbox"}
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
/** Where a reply to a Nodex post will go, phrased after the post it replies to. */
function ReplyDestinationPhrase({ destination }: { readonly destination: InboxReplyDestination }) {
  const chat = destination.chat ? (
    <span className="text-token-foreground">{destination.chat.title}</span>
  ) : null;
  if (destination.kind === "unavailable") return <>· Open chat to continue</>;
  if (destination.kind === "nodex" || !chat) return <>· Nodex routes it</>;
  if (destination.kind === "answer") return <>· answers {chat}’s question</>;
  return <>· goes to {chat}</>;
}
