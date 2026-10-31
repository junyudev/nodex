import { useLayoutEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import {
  MessageImagePicker,
  MessageImageRow,
  useMessageImageInput,
  type MessageDraftImage,
  type MessageImageAccess,
} from "@/components/message/message-images-input";
import { UpArrowIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isEmptyInboxDraft, type InboxDraft } from "./inbox-capture-state";
import { MAX_INBOX_TITLE_LENGTH } from "../../../shared/schemas/inbox";

const MAX_TEXTAREA_HEIGHT_PX = 240;

/**
 * The capture owner persists drafts and each submission before clearing this input. Images
 * pasted, dropped, or picked are imported as Library Files and attached after the text. A
 * message is named for it unless its sender gives a title, on a line above the text that its
 * host opens; a title already in the draft always shows, so it is never sent unseen.
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const showTitle = titleOpen || draft.title !== "";
  const input = useMessageImageInput({
    access: readOnly ? null : images,
    onImported: (added: readonly MessageDraftImage[]) =>
      onDraftChange((current) => ({ ...current, images: [...current.images, ...added] })),
  });
  const canSend = !disabled && !input.importing && !isEmptyInboxDraft(draft);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [draft.text]);

  useLayoutEffect(() => {
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

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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

  // Controls are 28px tall and the text's line box 34px, so each sits 3px up to share the
  // centre of the line it is beside.
  return (
    <form
      data-testid="inbox-composer"
      onSubmit={(event) => void submit(event)}
      onDragOver={input.onDragOver}
      onDrop={input.onDrop}
      className="flex flex-col gap-2 rounded-3xl bg-token-input-background p-2 text-token-foreground electron:elevation-prominent extension:border extension:border-token-border"
    >
      <div className="empty:hidden px-1 pt-1">
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
      </div>
      <div className="flex items-end gap-1">
        {images ? (
          <div className="mb-[3px] flex shrink-0">
            <MessageImagePicker onFiles={input.add} disabled={readOnly} />
          </div>
        ) : null}
        <div className={cn("flex min-w-0 flex-1 flex-col", !images && "pl-2")}>
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
              className="min-w-0 bg-transparent pt-[7px] text-size-chat leading-[20px] font-semibold outline-none placeholder:font-normal placeholder:text-token-input-placeholder-foreground"
            />
          ) : null}
          <textarea
            ref={textareaRef}
            aria-label="Message your Inbox"
            rows={1}
            readOnly={readOnly}
            value={draft.text}
            placeholder={placeholder}
            onChange={(event) => {
              const text = event.currentTarget.value;
              onDraftChange((current) => ({ ...current, text }));
            }}
            onPaste={input.onPaste}
            onKeyDown={handleKeyDown}
            className="min-h-[34px] resize-none bg-transparent py-[7px] text-size-chat leading-[20px] outline-none placeholder:text-token-input-placeholder-foreground"
          />
        </div>
        <NodexTooltip tooltipContent="Send to Inbox" shortcutLabel="↵" side="top">
          <button
            type="submit"
            aria-label="Send to Inbox"
            disabled={!canSend}
            className={cn(
              "cursor-interaction mb-[3px] flex h-token-button-composer aspect-square shrink-0 items-center justify-center rounded-full bg-background-composer-primary p-0.5 text-text-composer-primary",
              !canSend && "opacity-50",
            )}
          >
            <UpArrowIcon className="icon-sm" />
          </button>
        </NodexTooltip>
      </div>
    </form>
  );
}
