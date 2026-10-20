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

const MAX_TEXTAREA_HEIGHT_PX = 240;

/**
 * The capture owner persists drafts and each submission before clearing this input. Images
 * pasted, dropped, or picked are imported as Library Files and attached after the text.
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
}: {
  readonly onSend: () => Promise<void>;
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
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    await onSend();
    textareaRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <form
      data-testid="inbox-composer"
      onSubmit={(event) => void submit(event)}
      onDragOver={input.onDragOver}
      onDrop={input.onDrop}
      className="flex flex-col gap-2 rounded-3xl bg-token-input-background py-2 pr-2 pl-2 text-token-foreground electron:elevation-prominent extension:border extension:border-token-border"
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
        {images ? <MessageImagePicker onFiles={input.add} disabled={readOnly} /> : null}
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
          className={cn(
            "min-h-[34px] flex-1 resize-none bg-transparent py-[7px] text-size-chat leading-[20px] outline-none placeholder:text-token-input-placeholder-foreground",
            !images && "pl-2",
          )}
        />
        <NodexTooltip tooltipContent="Send to Inbox" shortcutLabel="↵" side="top">
          <button
            type="submit"
            aria-label="Send to Inbox"
            disabled={!canSend}
            className={cn(
              "cursor-interaction flex h-token-button-composer aspect-square shrink-0 items-center justify-center rounded-full bg-background-composer-primary p-0.5 text-text-composer-primary",
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
