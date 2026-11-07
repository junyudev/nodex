import { useContext, useState, type FormEvent } from "react";
import { COMPOSER_DROP_TARGET_CLASS_NAME } from "@/components/composer/composer-surface";
import {
  MessageImagePicker,
  pasteIntoMessageField,
  useMessageImageDrop,
} from "@/components/message/message-images-input";
import { composerEnterBehaviorAtom } from "@/lib/composer-enter-behavior-atom";
import { useContentImageScope } from "@/lib/content-image";
import { toastFailure } from "@/lib/failure-toast";
import { useScopedAtomValue } from "@/lib/maitai";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useLibraryFileReadAuthority } from "@/lib/use-library-navigation";
import { cn } from "@/lib/utils";
import { ConversationImageInputContext } from "../../conversation-image-input";
import type { UserTurnEdit } from "../../thread-stage-types";
import {
  addCopiedLibraryImages,
  isSupportedComposerImageFile,
  useComposerImageAttachments,
  type ComposerPastedFiles,
} from "../composer/image-attachments";
import type { UserTurnEditDraftUpdate } from "../local-conversation-thread-view-state";
import {
  canSendUserTurnEdit,
  compileUserTurnEditImages,
  removeUserTurnEditImage,
  userTurnEditDraftImages,
  type UserTurnEditDraft,
} from "../user-turn-edit-draft";
import { resolveComposerSubmitIntentFromKeyDown } from "./composer-action";
import { footerText } from "./thread-footer-i18n";
import { UserMessageEditImageRow } from "./user-message-attachments";

/** Opens the editor ready to continue typing at the end of the message. */
function focusEditMessageTextareaOnMount(element: HTMLTextAreaElement | null): void {
  if (!element || element.ownerDocument.activeElement === element) return;
  element.focus();
  element.setSelectionRange(element.value.length, element.value.length);
}

/**
 * Rewrites a sent message in place of its bubble, as a small Composer: its images sit above its
 * text and enter by paste, drop or the picker. Sending rewinds the conversation to just before
 * this message and continues from the rewritten one; keys follow the Composer.
 */
export function UserMessageEditForm({
  draft,
  scopeKey,
  onDraftChange,
  onCancel,
  onSubmit,
}: {
  readonly draft: UserTurnEditDraft;
  /** The message this edit belongs to, so an image still being read cannot land on another. */
  readonly scopeKey: string;
  readonly onDraftChange: (update: UserTurnEditDraftUpdate) => void;
  readonly onCancel: () => void;
  /** Rejects when the edit failed, so the draft stays open to retry. */
  readonly onSubmit: (edit: Pick<UserTurnEdit, "message" | "images">) => Promise<void>;
}) {
  const enterBehavior = useScopedAtomValue(composerEnterBehaviorAtom);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canSubmit = canSendUserTurnEdit(draft) && !isSubmitting;
  const { hostId } = useContentImageScope();
  const imageInput = useContext(ConversationImageInputContext);
  const libraryReadAuthority = useLibraryFileReadAuthority();
  const images = useComposerImageAttachments({
    attachments: draft.addedImages,
    setAttachments: (update) =>
      onDraftChange(
        (current) => current && { ...current, addedImages: update(current.addedImages) },
      ),
    scopeKey,
    enabled: imageInput.supported,
    unavailableReason: imageInput.unavailableReason,
    onError: (message) => toastFailure(message),
  });
  const addFiles = (files: readonly File[], origin: "paste" | "drop"): boolean => {
    if (!files.some(isSupportedComposerImageFile)) return false;
    void images.addFiles(files, origin);
    return true;
  };
  const takePaste = ({ imageFiles, libraryImages }: ComposerPastedFiles): boolean => {
    if (libraryImages.length === 0) return addFiles(imageFiles, "paste");
    if (!libraryReadAuthority) return false;
    addCopiedLibraryImages(images, libraryReadAuthority, libraryImages);
    return true;
  };
  const drop = useMessageImageDrop({
    enabled: true,
    onFiles: (files) => addFiles(files, "drop"),
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const executionHostId = hostId ?? null;
    let attached: UserTurnEdit["images"];
    try {
      attached = compileUserTurnEditImages(draft, executionHostId);
    } catch (error) {
      toastFailure("Couldn’t edit the message", error);
      return;
    }
    setIsSubmitting(true);
    return runWithCleanup(() => onSubmit({ message: draft.text.trim(), images: attached }), {
      cleanup: () => setIsSubmitting(false),
      onError: () => {
        // The conversation surface reports the failure; the draft stays for another try.
      },
    });
  };

  return (
    <form
      data-file-drop-active={drop.active ? "true" : "false"}
      className={cn(
        "flex w-full flex-col gap-2 bg-token-foreground/5 px-3 py-2.5",
        drop.active && COMPOSER_DROP_TARGET_CLASS_NAME,
        "rounded-2xl",
      )}
      onSubmit={(event) => {
        void submit(event);
      }}
      {...drop.target}
    >
      <UserMessageEditImageRow
        images={userTurnEditDraftImages(draft)}
        onRemove={(id) =>
          onDraftChange((current) => current && removeUserTurnEditImage(current, id))
        }
      />
      <textarea
        aria-label={footerText("Edit message")}
        className="max-h-30 min-h-10 w-full resize-none bg-transparent p-0 font-content text-size-chat leading-5 text-token-foreground outline-none [field-sizing:content] placeholder:text-token-description-foreground"
        placeholder={footerText("Edit message")}
        rows={2}
        value={draft.text}
        onChange={(event) => {
          const text = event.currentTarget.value;
          onDraftChange((current) => current && { ...current, text });
        }}
        // Programmatic value writes such as dictation bypass React's change tracking.
        onInput={(event) => {
          const text = event.currentTarget.value;
          onDraftChange((current) => current && { ...current, text });
        }}
        onPaste={(event) => pasteIntoMessageField(event, takePaste)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          const intent = resolveComposerSubmitIntentFromKeyDown({
            enterBehavior,
            hasMultilinePrompt: draft.text.includes("\n"),
            isThreadRunning: false,
            primarySubmitAction: "send",
            alternateSubmitAction: null,
            key: event.key,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
          });
          if (!intent) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
        ref={focusEditMessageTextareaOnMount}
      />
      <div className="mt-2 flex items-center gap-1.5">
        {/* Lines up with the same control in the Composer below. */}
        <div className="-ml-1 flex">
          <MessageImagePicker
            // A picked file names its path as a dropped one does.
            onFiles={(files) => void addFiles(files, "drop")}
            disabled={isSubmitting}
          />
        </div>
        <button
          type="button"
          disabled={isSubmitting}
          className="border-token-border user-select-none no-drag cursor-interaction ml-auto flex items-center gap-1 border focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg border-token-border text-token-button-tertiary-foreground bg-token-bg-fog enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border h-token-button-composer px-2 py-0 text-base leading-[18px]"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          aria-busy={isSubmitting}
          className="border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg bg-token-foreground enabled:hover:bg-token-foreground/80 data-[state=open]:bg-token-foreground/80 text-token-dropdown-background h-token-button-composer px-2 py-0 text-base leading-[18px]"
        >
          Send
        </button>
      </div>
    </form>
  );
}
