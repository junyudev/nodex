import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { NodexButton } from "@/components/ui/button";

const MAX_TEXTAREA_HEIGHT_PX = 320;

/**
 * Rewrites a message in its own bubble, keyed like the Inbox composer: Enter saves, Shift+Enter
 * breaks the line, and Escape puts the message back as it was.
 */
export function InboxMessageEditor({
  text,
  currentText = text,
  label = "Edit message",
  saveLabel = "Save",
  onSave,
  onCancel,
}: {
  readonly text: string;
  readonly label?: string;
  readonly saveLabel?: string;
  readonly currentText?: string;
  /** Resolves false when the rewrite was not saved, so the draft stays open. */
  readonly onSave: (text: string) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const changed = draft.trim().length > 0 && draft !== text;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [draft]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    if (!(await onSave(draft))) setSaving(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <textarea
        ref={textareaRef}
        aria-label={label}
        rows={1}
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        className="w-full resize-none bg-transparent text-size-chat leading-relaxed text-inherit outline-none"
      />
      {currentText !== text ? (
        <details className="text-xs text-token-description-foreground">
          <summary className="cursor-interaction">
            Message changed elsewhere — view current text
          </summary>
          <p className="mt-1 whitespace-pre-wrap">{currentText}</p>
        </details>
      ) : null}
      <div className="flex items-center justify-end gap-1">
        <NodexButton size="xs" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </NodexButton>
        <NodexButton size="xs" variant="primary" type="submit" disabled={!changed || saving}>
          {saveLabel}
        </NodexButton>
      </div>
    </form>
  );
}
