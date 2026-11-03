import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  clearImageEditComposerDraft,
  replaceImageEditComposerDraft,
} from "@/lib/image-edit-composer-channel";
import { createImageEditorComposerObservation } from "./image-editor-composer-observation";

const channelId = "editor-observation-test";
afterEach(() => clearImageEditComposerDraft(channelId));

test("observes its own publications without treating their echo as an external edit", () => {
  const observation = createImageEditorComposerObservation(channelId);
  const listener = vi.fn();
  const release = observation.subscribe(listener);
  observation.replace({ attachments: [], mode: "comment" });
  expect(observation.getSnapshot()).toMatchObject({
    draft: { mode: "comment" },
    externalRevision: 0,
  });
  expect(listener).toHaveBeenCalledOnce();
  replaceImageEditComposerDraft(channelId, { attachments: [], mode: "selection" });
  expect(observation.getSnapshot()).toMatchObject({
    draft: { mode: "selection" },
    externalRevision: 1,
  });
  clearImageEditComposerDraft(channelId);
  expect(observation.getSnapshot()).toMatchObject({ draft: { mode: null }, externalRevision: 2 });
  release();
  listener.mockClear();
  replaceImageEditComposerDraft(channelId, { attachments: [], mode: "comment" });
  expect(listener).not.toHaveBeenCalled();
  expect(observation.getSnapshot().externalRevision).toBe(3);
});
