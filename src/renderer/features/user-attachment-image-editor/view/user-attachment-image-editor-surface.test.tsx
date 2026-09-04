import { act, type ComponentProps, type Ref } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderWithMaitai } from "../../../test/thread-maitai";
import { TestQueryProvider } from "../../../test/query";
import {
  clearImageEditComposerDraft,
  getImageEditComposerDraftSnapshot,
  replaceImageEditComposerDraft,
} from "@/lib/image-edit-composer-channel";
import { clearManagedAssetDisplayUrlCache } from "@/lib/assets";
import type { NormalizedUserAttachmentImageEditorOptions } from "../model/types";
import {
  beginOptimisticGeneratedImageEdit,
  replaceGeneratedImageLiveGroup,
} from "../adapters/generated-image-collection-store";
import { UserAttachmentImageEditorSurface } from "./user-attachment-image-editor-surface";

const submissionState = vi.hoisted(() => ({
  notifyImageInputUnsupported: vi.fn(),
  submit: vi.fn(async () => true),
  supportsImageInputs: true,
}));

vi.mock("../adapters/use-image-edit-submission", () => ({
  useImageEditSubmission: () => ({
    isSubmitting: false,
    notifyImageInputUnsupported: submissionState.notifyImageInputUnsupported,
    submit: submissionState.submit,
    supportsImageInputs: submissionState.supportsImageInputs,
  }),
}));

vi.mock("./generated-image-dot-field", () => ({
  GeneratedImageDotField: () => <div aria-hidden="true" />,
}));

vi.mock("./image-zoom-viewer", () => ({
  ImageZoomViewer: ({
    alt,
    imageRef,
    src,
  }: {
    alt: string;
    imageRef?: Ref<HTMLImageElement>;
    src: string;
  }) => <img ref={imageRef} alt={alt} src={src} />,
}));

const THREAD_ID = "thread-surface-draft";
const IMAGE_SRC = "data:image/png;base64,AQID";
const OPTIONS: NormalizedUserAttachmentImageEditorOptions = {
  availableImageCount: 1,
  composerTarget: {
    channelId: THREAD_ID,
    placement: "root",
  },
  entrypoint: "image_click",
  generatedImages: null,
  imageSource: "uploaded",
  images: [
    {
      id: "uploaded-image",
      alt: "Uploaded image",
      attachmentSrc: IMAGE_SRC,
      dataUrl: IMAGE_SRC,
      source: "uploaded",
      src: IMAGE_SRC,
    },
  ],
  initialImageId: "uploaded-image",
  initialPlaygroundTool: "navigate",
  initialView: "single",
  openInEditor: true,
  policy: "edit_button",
  projectId: "project-1",
  threadId: THREAD_ID,
  title: "User attachment",
  tooltip: "User attachment",
};

function seedCommentDraft(): void {
  replaceImageEditComposerDraft(THREAD_ID, {
    attachments: [
      {
        asset: {
          hostId: null,
          localPath: null,
          managedSource: null,
          src: IMAGE_SRC,
        },
        comments: [{ id: "comment-1", text: "Remove the label", x: 0.25, y: 0.75 }],
        filename: "Uploaded image",
        id: "image-playground:uploaded-image",
        imageSource: "uploaded",
      },
    ],
    mode: "comment",
  });
}

function renderSurface() {
  return renderWithMaitai(
    <TestQueryProvider>
      <div className="h-[700px] w-[700px]">
        <UserAttachmentImageEditorSurface options={OPTIONS} />
      </div>
    </TestQueryProvider>,
  );
}

const GENERATED_THREAD_ID = "thread-surface-generated";
const GENERATED_OPTIONS: NormalizedUserAttachmentImageEditorOptions = {
  ...OPTIONS,
  availableImageCount: 2,
  composerTarget: {
    channelId: GENERATED_THREAD_ID,
    placement: "root",
  },
  generatedImages: [1, 2].map((number) => ({
    id: `generated-${number}`,
    alt: `Generated image ${number}`,
    attachmentId: `image-playground:generated-${number}`,
    attachmentSrc: IMAGE_SRC,
    generatedOrdinal: number,
    groupId: "turn-generated",
    source: "generated",
    src: IMAGE_SRC,
    status: "ready",
    tabTitle: `Generated image ${number}`,
  })),
  imageSource: "generated",
  images: [],
  initialImageId: "generated-1",
  threadId: GENERATED_THREAD_ID,
  title: "Generated image 1",
  tooltip: "Generated image 1",
};

function renderGeneratedSurface(
  props: {
    fullWidth?: boolean;
    onStateChange?: ComponentProps<typeof UserAttachmentImageEditorSurface>["onStateChange"];
  } = {},
) {
  return renderWithMaitai(
    <TestQueryProvider>
      <div className="h-[700px] w-[800px]">
        <UserAttachmentImageEditorSurface
          fullWidth={props.fullWidth ?? true}
          options={GENERATED_OPTIONS}
          onStateChange={props.onStateChange}
        />
      </div>
    </TestQueryProvider>,
  );
}

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  clearImageEditComposerDraft(THREAD_ID);
  clearImageEditComposerDraft(GENERATED_THREAD_ID);
  clearManagedAssetDisplayUrlCache();
  submissionState.notifyImageInputUnsupported.mockClear();
  submissionState.submit.mockClear();
  submissionState.supportsImageInputs = true;
});

describe("UserAttachmentImageEditorSurface", () => {
  test("keeps Canvas available for a single generated image without showing a rail", () => {
    const singleGenerated = GENERATED_OPTIONS.generatedImages?.slice(0, 1) ?? [];
    const view = renderWithMaitai(
      <TestQueryProvider>
        <div className="h-[700px] w-[800px]">
          <UserAttachmentImageEditorSurface
            fullWidth
            options={{
              ...GENERATED_OPTIONS,
              availableImageCount: 1,
              generatedImages: singleGenerated,
            }}
          />
        </div>
      </TestQueryProvider>,
    );

    expect(view.getByRole("button", { name: "Canvas view" })).toBeTruthy();
    expect(view.queryByLabelText("Generated images")).toBeNull();
  });

  test("publishes Canvas ownership before measuring the transition destination", async () => {
    let projectedView = "single";
    const events: string[] = [];
    const measurement = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function measure(this: HTMLElement) {
        if (
          this.getAttribute("aria-label") === "Generated image 1" ||
          this.getAttribute("alt") === "Generated image 1"
        ) {
          events.push(`measure:${projectedView}`);
        }
        return {
          bottom: 200,
          height: 100,
          left: 20,
          right: 220,
          top: 100,
          width: 200,
          x: 20,
          y: 100,
          toJSON: () => ({}),
        };
      });
    const view = renderGeneratedSurface({
      onStateChange: (state) => {
        projectedView = state.view;
        events.push(`state:${state.view}`);
      },
    });

    try {
      events.length = 0;
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Canvas view" }));
      });

      expect(events.indexOf("measure:single")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("state:playground")).toBeGreaterThan(events.indexOf("measure:single"));
      expect(events.lastIndexOf("measure:playground")).toBeGreaterThan(
        events.indexOf("state:playground"),
      );
    } finally {
      measurement.mockRestore();
    }
  });

  test("restores composer-owned comments after the panel closes and reopens", async () => {
    seedCommentDraft();
    const first = renderSurface();

    expect(await first.findByRole("button", { name: "Edit comment 1" })).toBeTruthy();
    first.unmount();
    expect(getImageEditComposerDraftSnapshot(THREAD_ID).mode).toBe("comment");

    const reopened = renderSurface();
    expect(await reopened.findByRole("button", { name: "Edit comment 1" })).toBeTruthy();
  });

  test("removes a visible saved comment when its composer attachment is cleared", async () => {
    seedCommentDraft();
    const view = renderSurface();
    expect(await view.findByRole("button", { name: "Edit comment 1" })).toBeTruthy();

    await act(async () => {
      clearImageEditComposerDraft(THREAD_ID);
    });

    await waitFor(() => {
      expect(view.queryByRole("button", { name: "Edit comment 1" })).toBeNull();
    });
    expect(view.getByRole("button", { name: "Comment" })).toBeTruthy();
  });

  test("publishes an uploaded attachment's host identity without relabeling its display source", async () => {
    const managedSource = "nodex://assets/uploaded-image.png";
    const originalApi = window.api;
    window.api = {
      ...originalApi,
      resolveManagedAssetPath: (source) =>
        source === managedSource ? "/profile/assets/uploaded-image.png" : null,
    } as typeof window.api;
    try {
      const view = renderWithMaitai(
        <TestQueryProvider>
          <div className="h-[700px] w-[700px]">
            <UserAttachmentImageEditorSurface
              options={{
                ...OPTIONS,
                images: [
                  {
                    ...OPTIONS.images[0]!,
                    attachmentId: "composer-uploaded-image",
                    attachmentSrc: managedSource,
                    dataUrl: managedSource,
                    hostId: "default",
                    managedSource,
                    src: managedSource,
                  },
                ],
              }}
            />
          </div>
        </TestQueryProvider>,
      );

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Comment" }));
      });

      await waitFor(() =>
        expect(getImageEditComposerDraftSnapshot(THREAD_ID).attachments).toEqual([
          expect.objectContaining({
            id: "composer-uploaded-image",
            asset: {
              hostId: "default",
              localPath: null,
              managedSource,
              src: managedSource,
            },
          }),
        ]),
      );
    } finally {
      window.api = originalApi;
    }
  });

  test("Cancel discards saved positional comments from the composer draft", async () => {
    seedCommentDraft();
    const view = renderSurface();
    expect(await view.findByRole("button", { name: "Edit comment 1" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    });

    await waitFor(() => expect(getImageEditComposerDraftSnapshot(THREAD_ID).mode).toBeNull());
    expect(view.queryByRole("button", { name: "Edit comment 1" })).toBeNull();
  });

  test("Escape exits comment mode after the inner editor has had first refusal", async () => {
    seedCommentDraft();
    const view = renderSurface();
    const marker = await view.findByRole("button", { name: "Edit comment 1" });

    await act(async () => {
      fireEvent.keyDown(marker, { key: "Escape" });
    });

    await waitFor(() => expect(getImageEditComposerDraftSnapshot(THREAD_ID).mode).toBeNull());
    expect(view.getByRole("button", { name: "Comment" })).toBeTruthy();
  });

  test("leaving multi-select focuses and stages only the last selected image", async () => {
    const view = renderGeneratedSurface();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Canvas view" }));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Multi-select" }));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Generated image 2" }));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Multi-select" }));
    });

    await waitFor(() =>
      expect(
        getImageEditComposerDraftSnapshot(GENERATED_THREAD_ID).attachments.map(
          (attachment) => attachment.id,
        ),
      ).toEqual(["image-playground:generated-2"]),
    );
  });

  test("focuses an optimistic edit and transfers focus to its generated result", async () => {
    const view = renderGeneratedSurface();
    await waitFor(() =>
      expect(getImageEditComposerDraftSnapshot(GENERATED_THREAD_ID).attachments).toHaveLength(1),
    );
    const generatedImages = GENERATED_OPTIONS.generatedImages ?? [];
    let removeHistoric: () => void = () => undefined;
    await act(async () => {
      removeHistoric = replaceGeneratedImageLiveGroup(GENERATED_THREAD_ID, {
        id: "turn-generated",
        images: generatedImages,
        pendingImageCount: 0,
        turnStartedAtMs: 1,
      });
    });
    const optimisticRef: {
      current: ReturnType<typeof beginOptimisticGeneratedImageEdit>;
    } = { current: null };
    await act(async () => {
      optimisticRef.current = beginOptimisticGeneratedImageEdit(GENERATED_THREAD_ID);
    });
    const optimistic = optimisticRef.current;
    expect(optimistic).not.toBeNull();
    if (!optimistic) throw new Error("Expected an optimistic image edit");

    await waitFor(() =>
      expect(getImageEditComposerDraftSnapshot(GENERATED_THREAD_ID).mode).toBeNull(),
    );
    expect(view.getAllByRole("status").length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Generating image…" }).getAttribute("aria-current"),
      ).toBe("true"),
    );
    const replacement = {
      ...generatedImages[0]!,
      id: "generated-3",
      alt: "Generated image 3",
      attachmentId: "image-playground:generated-3",
      generatedOrdinal: 3,
      groupId: "turn-replacement",
      tabTitle: "Generated image 3",
      turnStartedAtMs: optimistic.createdAtMs + 1,
    };
    let removeReplacement: () => void = () => undefined;
    await act(async () => {
      removeReplacement = replaceGeneratedImageLiveGroup(GENERATED_THREAD_ID, {
        id: "turn-replacement",
        images: [replacement],
        pendingImageCount: 0,
        turnStartedAtMs: replacement.turnStartedAtMs ?? null,
      });
    });

    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Generated image 3" }).getAttribute("aria-current"),
      ).toBe("true"),
    );
    await act(async () => {
      removeReplacement();
      removeHistoric();
      optimistic.rollback();
    });
  });

  test("rejects unsupported Canvas tools without leaving partial selection", async () => {
    submissionState.supportsImageInputs = false;
    const view = renderGeneratedSurface();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Canvas view" }));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Multi-select" }));
      fireEvent.click(view.getByRole("button", { name: "Comment" }));
    });

    expect(submissionState.notifyImageInputUnsupported.mock.calls).toEqual([
      ["select"],
      ["comment"],
    ]);
    expect(view.getByRole("button", { name: "Multi-select" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(getImageEditComposerDraftSnapshot(GENERATED_THREAD_ID).mode).toBeNull();
  });
});
