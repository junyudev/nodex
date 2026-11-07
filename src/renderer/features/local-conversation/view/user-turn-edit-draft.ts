import { removeImagePlaceholder } from "../../../../shared/message-agent-input";
import type {
  CodexPromptImageInput,
  CodexUserAttachment,
  CodexUserImageAttachment,
} from "@/lib/types";
import {
  buildComposerImagePromptInputs,
  type ComposerImageAttachment,
} from "./composer/image-attachments/composer-image-attachment-model";

/** A sent message while it is rewritten. Its images number in this order: sent, then added. */
export interface UserTurnEditDraft {
  readonly text: string;
  /** The images it was sent with that it still keeps. */
  readonly sentImages: readonly CodexUserImageAttachment[];
  /** Images added since, which already carry what they need to be sent. */
  readonly addedImages: readonly ComposerImageAttachment[];
}

export function openUserTurnEditDraft(
  text: string,
  attachments: readonly CodexUserAttachment[],
): UserTurnEditDraft {
  return {
    text,
    sentImages: attachments.filter(
      (attachment): attachment is CodexUserImageAttachment => attachment.type === "image",
    ),
    addedImages: [],
  };
}

/** The draft's images as the message will show them, each read from what it holds now. */
export function userTurnEditDraftImages(
  draft: UserTurnEditDraft,
): readonly CodexUserImageAttachment[] {
  return [
    ...draft.sentImages,
    ...draft.addedImages.map((image): CodexUserImageAttachment => ({
      type: "image",
      id: image.id,
      source: image.src,
      sourceKind: "inline-image",
      caption: image.filename,
    })),
  ];
}

/** Takes an image out of the draft, and out of the text that names it. */
export function removeUserTurnEditImage(draft: UserTurnEditDraft, id: string): UserTurnEditDraft {
  const index = userTurnEditDraftImages(draft).findIndex((image) => image.id === id);
  if (index < 0) return draft;
  return {
    text: removeImagePlaceholder(draft.text, index + 1),
    sentImages: draft.sentImages.filter((image) => image.id !== id),
    addedImages: draft.addedImages.filter((image) => image.id !== id),
  };
}

export function canSendUserTurnEdit(draft: UserTurnEditDraft): boolean {
  return (
    draft.text.trim().length > 0 || draft.sentImages.length > 0 || draft.addedImages.length > 0
  );
}

/**
 * Every image the rewritten message attaches, in order. A sent image stays where its transcript
 * read it; an added one comes from where this chat runs, which rejects the rare image that is
 * not available there rather than quietly sending the message without it.
 */
export function compileUserTurnEditImages(
  draft: UserTurnEditDraft,
  executionHostId: string | null,
): readonly CodexPromptImageInput[] {
  const added = buildComposerImagePromptInputs(draft.addedImages, executionHostId);
  if (added.length !== draft.addedImages.length)
    throw new Error(
      "One or more images aren’t available where this chat runs. Remove them or add them again.",
    );
  return [
    ...draft.sentImages.map(({ source, caption }): CodexPromptImageInput => ({
      source,
      ...(caption ? { caption } : {}),
    })),
    ...added,
  ];
}
