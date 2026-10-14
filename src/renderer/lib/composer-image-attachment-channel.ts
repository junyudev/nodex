import type { ImageEditComposerTarget } from "@/features/user-attachment-image-editor/model/types";
import type { ResolvedComposerImageInput } from "@/features/local-conversation/view/composer/image-attachments/composer-image-attachment-model";

export interface ComposerImageAttachmentTarget {
  readonly hostId: string;
  readonly threadId: string | null;
  readonly scopeKey: string;
  readonly append: (images: readonly ResolvedComposerImageInput[]) => boolean;
}

const targets = new Map<string, ComposerImageAttachmentTarget>();

/** Registers the mounted Composer's attachment-only ingress, independently of image-edit submission. */
export function registerComposerImageAttachmentTarget(
  target: ImageEditComposerTarget,
  owner: ComposerImageAttachmentTarget,
) {
  targets.set(target.channelId, owner);
  return () => {
    if (targets.get(target.channelId) === owner) targets.delete(target.channelId);
  };
}

/** The captured owner cannot append into a replacement Composer after an asynchronous image read. */
export function captureComposerImageAttachmentTarget(target: ImageEditComposerTarget | undefined) {
  const owner = target ? targets.get(target.channelId) : undefined;
  if (!target || !owner) return null;
  return {
    hostId: owner.hostId,
    threadId: owner.threadId,
    scopeKey: owner.scopeKey,
    append(images: readonly ResolvedComposerImageInput[], isCurrent: () => boolean) {
      if (!isCurrent() || targets.get(target.channelId) !== owner) return false;
      return owner.append(images);
    },
  };
}
