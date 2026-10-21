import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { MessageDocument } from "@/components/message/message-document";
import {
  MessageImagePicker,
  MessageImageRow,
  useMessageImageInput,
} from "@/components/message/message-images-input";
import { NodexButton } from "@/components/ui/button";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import { parseNfm } from "../../../shared/nfm/parser";
import { inboxDraftBody, isEmptyInboxDraft, type InboxDraft } from "./inbox-capture-state";
import { useInboxImageAccess } from "./use-inbox-image-access";

const MAX_TEXTAREA_HEIGHT_PX = 320;

/**
 * Rewrites a message in its own bubble with the composer's text and images, keyed like the
 * Inbox composer: Enter saves, Shift+Enter breaks the line, and Escape puts the message back.
 */
export function InboxMessageEditor({
  body,
  draft: initial,
  currentBody = body,
  routing,
  onSave,
  onCancel,
}: {
  /** The message body the rewrite starts from. */
  readonly body: string;
  /** That body as the composer writes it. */
  readonly draft: InboxDraft;
  /** The body as it is now, which may have changed elsewhere since the rewrite began. */
  readonly currentBody?: string;
  /** Where images added during the rewrite are imported. */
  readonly routing: ContentRoutingContext;
  /** Resolves false when the rewrite was not saved, so the draft stays open. */
  readonly onSave: (body: string) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<InboxDraft>(initial);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const images = useInboxImageAccess(routing);
  const input = useMessageImageInput({
    access: saving ? null : images,
    onImported: (added) =>
      setDraft((current) => ({ ...current, images: [...current.images, ...added] })),
  });
  const next = inboxDraftBody(draft);
  // The draft shows text plainly, so it is compared with how it started rather than with `body`.
  const changed = !isEmptyInboxDraft(draft) && next !== inboxDraftBody(initial) && !input.importing;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [draft.text]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  // Images added during the rewrite go with it when it is put back.
  const cancel = () => {
    input.discard(draft.images);
    onCancel();
  };

  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    if (!(await onSave(next))) setSaving(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
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
      onDragOver={input.onDragOver}
      onDrop={input.onDrop}
    >
      <MessageImageRow
        images={draft.images}
        input={input}
        readAuthority={images?.readAuthority ?? null}
        onRemove={(fileId) =>
          setDraft((current) => ({
            ...current,
            images: current.images.filter((image) => image.fileId !== fileId),
          }))
        }
      />
      <textarea
        ref={textareaRef}
        aria-label="Edit message"
        rows={1}
        value={draft.text}
        disabled={saving}
        onChange={(event) => {
          const text = event.currentTarget.value;
          setDraft((current) => ({ ...current, text }));
        }}
        onPaste={input.onPaste}
        onKeyDown={handleKeyDown}
        className="w-full resize-none bg-transparent text-size-chat leading-relaxed text-inherit outline-none"
      />
      {currentBody !== body ? (
        <details className="text-xs text-token-description-foreground">
          <summary className="cursor-interaction">
            Message changed elsewhere — view current message
          </summary>
          <div className="mt-1">
            <MessageDocument
              blocks={parseNfm(currentBody)}
              contentKey={currentBody}
              fileAuthority={images?.readAuthority ?? null}
            />
          </div>
        </details>
      ) : null}
      <div className="flex items-center gap-1">
        {images ? <MessageImagePicker onFiles={input.add} disabled={saving} /> : null}
        <NodexButton
          size="xs"
          variant="ghost"
          className="ml-auto"
          disabled={saving}
          onClick={cancel}
        >
          Cancel
        </NodexButton>
        <NodexButton size="xs" variant="primary" type="submit" disabled={!changed || saving}>
          Save
        </NodexButton>
      </div>
    </form>
  );
}
