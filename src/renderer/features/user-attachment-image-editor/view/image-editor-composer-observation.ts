import {
  getImageEditComposerDraftSnapshot,
  replaceImageEditComposerDraft,
  subscribeImageEditComposerDraft,
  type ImageEditComposerDraftSnapshot,
} from "@/lib/image-edit-composer-channel";

/** Keeps the editor's own publications distinct from changes made by the Composer. */
export function createImageEditorComposerObservation(channelId: string) {
  let snapshot = { draft: getImageEditComposerDraftSnapshot(channelId), externalRevision: 0 };
  let publishing = false;
  const getSnapshot = () => {
    const draft = getImageEditComposerDraftSnapshot(channelId);
    if (draft !== snapshot.draft) {
      snapshot = { draft, externalRevision: snapshot.externalRevision + (publishing ? 0 : 1) };
    }
    return snapshot;
  };
  return {
    channelId,
    getSnapshot,
    subscribe: (listener: () => void) =>
      subscribeImageEditComposerDraft(channelId, () => {
        getSnapshot();
        listener();
      }),
    replace: (draft: Omit<ImageEditComposerDraftSnapshot, "revision">) => {
      publishing = true;
      try {
        replaceImageEditComposerDraft(channelId, draft);
        getSnapshot();
      } finally {
        publishing = false;
      }
    },
  };
}
