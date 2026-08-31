import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { buildResizeSubmissionIntent } from "../model/image-edit-submission";

const mocks = vi.hoisted(() => ({
  danger: vi.fn(),
  requestComposerSubmit: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({
  toast: { danger: mocks.danger },
}));

vi.mock("@/features/local-conversation/local-conversation-store", () => ({
  useCodexAppServerControl: () => ({
    availableModels: [],
    executionProfile: null,
  }),
  useCodexConversationValue: (
    _threadId: string | null,
    selector: (conversation: undefined) => unknown,
  ) => selector(undefined),
}));

vi.mock("@/lib/image-edit-composer-channel", () => ({
  requestImageEditComposerSubmit: mocks.requestComposerSubmit,
}));

import { useImageEditSubmission } from "./use-image-edit-submission";

const intent = buildResizeSubmissionIntent({
  aspectRatio: "1:1",
  entrypoint: "image_click",
  image: {
    id: "image-1",
    alt: "User attachment",
    attachmentSrc: "data:image/png;base64,aW1hZ2U=",
    dataUrl: "data:image/png;base64,aW1hZ2U=",
    source: "uploaded",
    src: "data:image/png;base64,aW1hZ2U=",
  },
});

beforeEach(() => {
  mocks.danger.mockReset();
  mocks.requestComposerSubmit.mockReset();
});

describe("useImageEditSubmission", () => {
  test("leaves a Composer-owned send failure with its single error owner", async () => {
    mocks.requestComposerSubmit.mockResolvedValue({
      status: "failed",
      reason: "transport",
    });
    const hook = renderHook(() =>
      useImageEditSubmission({
        composerTarget: {
          channelId: "thread-scope:session-1::root",
          placement: "root",
        },
        projectId: null,
        threadId: null,
      }),
    );
    let submitted = true;

    await act(async () => {
      submitted = await hook.result.current.submit(intent);
    });

    expect(submitted).toBe(false);
    expect(mocks.danger).not.toHaveBeenCalled();
  });
});
