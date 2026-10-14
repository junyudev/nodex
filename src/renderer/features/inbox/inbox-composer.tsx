import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { UpArrowIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const MAX_TEXTAREA_HEIGHT_PX = 240;

/**
 * Capture is never blocked on a model: the draft clears as soon as it is handed to Core and
 * returns only if saving fails.
 */
export function InboxComposer({
  onSend,
  focusToken,
  placeholder = "Drop a thought, task, or question…",
}: {
  readonly onSend: (text: string) => Promise<boolean>;
  /** Changing this value focuses the composer, for example after a keyboard shortcut. */
  readonly focusToken?: number;
  readonly placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = draft.trim().length > 0;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [draft]);

  useLayoutEffect(() => {
    textareaRef.current?.focus();
  }, [focusToken]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft;
    if (!text.trim()) return;
    setDraft("");
    const saved = await onSend(text);
    if (!saved) setDraft((current) => (current ? current : text));
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
      className="flex items-end gap-2 rounded-3xl bg-token-input-background py-2 pr-2 pl-4 text-token-foreground electron:elevation-prominent extension:border extension:border-token-border"
    >
      <textarea
        ref={textareaRef}
        aria-label="Message your Inbox"
        rows={1}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        className="min-h-[34px] flex-1 resize-none bg-transparent py-[7px] text-size-chat leading-[20px] outline-none placeholder:text-token-input-placeholder-foreground"
      />
      <NodexTooltip tooltipContent="Send to Inbox" shortcutLabel="↵" side="top">
        <button
          type="submit"
          aria-label="Send to Inbox"
          disabled={!canSend}
          className={cn(
            "cursor-interaction flex h-token-button-composer aspect-square shrink-0 items-center justify-center rounded-full bg-background-composer-primary p-0.5 text-text-composer-primary transition-opacity",
            !canSend && "opacity-50",
          )}
        >
          <UpArrowIcon className="icon-sm" />
        </button>
      </NodexTooltip>
    </form>
  );
}
