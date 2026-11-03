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
    captureSubmissionPresentation: () => ({
      rendererGeneration: "renderer-a",
      sceneOwner: { kind: "library" },
      presentationRevision: 1,
      selectedTabs: [],
      focusedTarget: null,
    }),
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
  test("blocks a duplicate send and releases submitting state after transport failure and success", async () => {
    let rejectSubmission!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectSubmission = reject;
    });
    mocks.requestComposerSubmit
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ status: "submitted" });
    const hook = renderHook(() =>
      useImageEditSubmission({
        composerTarget: { channelId: "thread-scope:session-1::root", placement: "root" },
        projectId: null,
        threadId: null,
      }),
    );
    let submission!: Promise<boolean>;
    await act(async () => {
      submission = hook.result.current.submit(intent);
      await Promise.resolve();
    });
    expect(hook.result.current.isSubmitting).toBe(true);
    await act(async () => {
      expect(await hook.result.current.submit(intent)).toBe(false);
    });
    expect(mocks.requestComposerSubmit).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectSubmission(new Error("Disconnected"));
      expect(await submission).toBe(false);
    });
    expect(hook.result.current.isSubmitting).toBe(false);
    expect(mocks.danger).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(await hook.result.current.submit(intent)).toBe(true);
    });
    expect(hook.result.current.isSubmitting).toBe(false);
    expect(mocks.requestComposerSubmit).toHaveBeenCalledTimes(2);
  });

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
