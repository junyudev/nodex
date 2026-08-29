import { describe, expect, test } from "vite-plus/test";
import { formatImageCommentPercent, serializeImageCommentGroups } from "./comment-serialization";
import {
  normalizeUserAttachmentImageEditorOptions,
  resolveImageInputSupport,
  resolveImagePreviewOpenDisposition,
} from "./feature-policy";
import {
  captureGeneratedImageOptimisticFocus,
  reconcileGeneratedImageCollection,
  resolveGeneratedImageOptimisticFocus,
  selectGeneratedImage,
} from "./generated-image-collection";
import {
  formatGeneratedImageGroupTime,
  isGeneratedImageTileEmphasized,
} from "./generated-image-canvas-presentation";
import {
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_REMOVE_BACKGROUND_PROMPT,
  IMAGE_REMOVE_PROMPT,
  buildCommentSubmissionIntent,
  buildImageResizePrompt,
  buildRemoveBackgroundSubmissionIntent,
  buildRemoveSubmissionIntent,
  buildResizeSubmissionIntent,
  buildSelectionSubmissionIntent,
} from "./image-edit-submission";
import {
  IMAGE_RAIL_VIEWPORT_CENTER_OFFSET_PX,
  IMAGE_RAIL_VIEWPORT_RESERVE_PX,
  computeCommentEditorLayoutMetrics,
  computeCommentEditorPlacement,
  computeFitZoomPercent,
  computeManualImageSize,
  computePinchZoomPercent,
  computeZoomViewportCenter,
  computeWheelZoomPercent,
  computeZoomAnchorCorrection,
  normalizeImagePoint,
} from "./image-geometry";
import {
  appendRemoveStrokePoint,
  buildRemoveMaskDrawingPlan,
  canSubmitRemoveMask,
  commitRemoveStroke,
  computeRemoveBrushCssPixels,
  computeRemoveBrushNaturalPixels,
  createRemoveHistory,
  createRemoveStroke,
  redoRemoveStroke,
  undoRemoveStroke,
} from "./remove-mask";
import type { EditableImageDescriptor, GeneratedImageDescriptor } from "./types";

function makeImage(
  id: string,
  overrides: Partial<EditableImageDescriptor> = {},
): EditableImageDescriptor {
  return {
    id,
    alt: `${id} alt`,
    attachmentId: `${id}-attachment`,
    attachmentSrc: `file:///images/${id}.png`,
    source: "uploaded",
    src: `asset://${id}`,
    ...overrides,
  };
}

function makeGeneratedImage(
  id: string,
  overrides: Partial<GeneratedImageDescriptor> = {},
): GeneratedImageDescriptor {
  return {
    ...makeImage(id),
    generatedOrdinal: 1,
    groupId: "group-1",
    source: "generated",
    status: "ready",
    ...overrides,
  };
}

describe("image preview policy", () => {
  test("rejects only a known model that omits image input", () => {
    const catalog = {
      providers: [
        {
          id: "text-provider",
          displayName: "Text provider",
          description: null,
          wireApi: "responses" as const,
          credentialStatus: "ready" as const,
          supportedByNodex: true,
          isDefault: true,
          credentialEnvKey: null,
          recommendedHarnessId: null,
          models: [
            {
              providerId: "text-provider",
              modelId: "text-only",
              displayName: "Text only",
              description: null,
              hidden: false,
              isDefault: true,
              recommendedHarnessId: null,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
              supportedServiceTiers: [],
              defaultServiceTier: null,
              inputCapabilities: ["text" as const],
              switchPolicy: "same-thread" as const,
            },
          ],
        },
      ],
    };
    const executionProfile = {
      providerId: "text-provider",
      modelId: "text-only",
      harnessId: null,
      reasoningEffort: null,
      serviceTier: null,
    };

    expect(resolveImageInputSupport({ catalog, executionProfile })).toBe(false);
    expect(resolveImageInputSupport({ catalog: null, executionProfile })).toBe(true);
  });

  test("normalizes a sparse uploaded-image opener once", () => {
    const options = normalizeUserAttachmentImageEditorOptions({
      alt: "Screenshot",
      attachmentSrc: "/tmp/screenshot.png",
      src: "asset://preview",
    });

    expect(options).toMatchObject({
      availableImageCount: 1,
      entrypoint: "image_click",
      generatedImages: null,
      imageSource: "uploaded",
      initialPlaygroundTool: "navigate",
      initialView: "single",
      openInEditor: false,
      policy: "edit_button",
      projectId: null,
      threadId: null,
      title: "User attachment",
      tooltip: "User attachment",
    });
    expect(options.images).toEqual([
      expect.objectContaining({
        id: "/tmp/screenshot.png",
        attachmentSrc: "/tmp/screenshot.png",
        downloadSrc: "asset://preview",
        previewSrc: "asset://preview",
      }),
    ]);
  });

  test("preserves generated playground state and active-image title", () => {
    const generated = makeGeneratedImage("generated-1", {
      tabTitle: "Generated concept",
    });
    const options = normalizeUserAttachmentImageEditorOptions({
      alt: "Generated concept",
      attachmentSrc: generated.attachmentSrc,
      generatedImages: [generated],
      initialImageId: generated.id,
      initialPlaygroundTool: "comment",
      initialView: "playground",
      src: generated.src,
    });

    expect(options.imageSource).toBe("generated");
    expect(options.images).toEqual([generated]);
    expect(options.initialView).toBe("playground");
    expect(options.initialPlaygroundTool).toBe("comment");
    expect(options.referrerPolicy).toBe("no-referrer");
    expect(options.title).toBe("Generated concept");
  });

  test("routes feature gates and local preview-dialog policy", () => {
    expect(
      resolveImagePreviewOpenDisposition(
        { openInEditor: false, policy: "disabled" },
        "local-thread",
      ),
    ).toBe("disabled");
    expect(
      resolveImagePreviewOpenDisposition(
        { openInEditor: false, policy: "edit_button" },
        "local-thread",
      ),
    ).toBe("preview_dialog");
    expect(
      resolveImagePreviewOpenDisposition(
        { openInEditor: true, policy: "edit_button" },
        "local-thread",
      ),
    ).toBe("editor");
    expect(
      resolveImagePreviewOpenDisposition(
        { openInEditor: false, policy: "image_click" },
        "local-thread",
      ),
    ).toBe("editor");
  });
});

describe("image geometry", () => {
  test("fits without upscaling and reserves the image rail", () => {
    expect(
      computeFitZoomPercent({
        naturalImageSize: { height: 1_000, width: 2_000 },
        viewportSize: { height: 800, width: 1_000 },
      }),
    ).toBe(50);
    expect(
      computeFitZoomPercent({
        hasImageRail: true,
        naturalImageSize: { height: 1_000, width: 2_000 },
        viewportSize: { height: 800, width: 1_000 },
      }),
    ).toBe(45.6);
    expect(
      computeFitZoomPercent({
        naturalImageSize: { height: 300, width: 500 },
        viewportSize: { height: 800, width: 1_000 },
      }),
    ).toBe(100);
    expect(IMAGE_RAIL_VIEWPORT_RESERVE_PX).toBe(88);
    expect(IMAGE_RAIL_VIEWPORT_CENTER_OFFSET_PX).toBe(-36);
  });

  test("rejects invalid dimensions and scales manual zoom from natural pixels", () => {
    expect(
      computeFitZoomPercent({
        naturalImageSize: { height: 0, width: 100 },
        viewportSize: { height: 100, width: 100 },
      }),
    ).toBeNull();
    expect(
      computeManualImageSize({
        naturalImageSize: { height: 400, width: 600 },
        zoomPercent: 125,
      }),
    ).toEqual({ height: 500, width: 750 });
    expect(
      computeManualImageSize({
        naturalImageSize: { height: 400, width: 600 },
        zoomPercent: 0,
      }),
    ).toBeNull();
  });

  test("normalizes pointer coordinates without hiding captured out-of-bounds motion", () => {
    expect(
      normalizeImagePoint({
        clientPoint: { x: 250, y: 25 },
        rect: { height: 100, left: 50, top: 50, width: 100 },
      }),
    ).toEqual({ x: 2, y: -0.25 });
    expect(
      normalizeImagePoint({
        clientPoint: { x: 0, y: 0 },
        rect: { height: 0, left: 0, top: 0, width: 100 },
      }),
    ).toBeNull();
  });

  test("places comment editors right, left, below, then above", () => {
    const wideMetrics = {
      editorMaxX: 792,
      editorMaxY: 392,
      editorMinX: 8,
      editorMinY: 8,
      surfaceHeight: 400,
      surfaceWidth: 800,
      x: 0.25,
      y: 0.5,
    };
    expect(
      computeCommentEditorPlacement({
        isEditingExistingComment: false,
        metrics: wideMetrics,
      }),
    ).toEqual({ height: 44, left: 227, top: 178, width: 294 });
    expect(
      computeCommentEditorPlacement({
        isEditingExistingComment: false,
        metrics: { ...wideMetrics, x: 0.75 },
      }),
    ).toEqual({ height: 44, left: 279, top: 178, width: 294 });

    const narrowMetrics = {
      ...wideMetrics,
      editorMaxX: 392,
      surfaceWidth: 400,
      x: 0.5,
      y: 0.25,
    };
    expect(
      computeCommentEditorPlacement({
        isEditingExistingComment: false,
        metrics: narrowMetrics,
      }),
    ).toEqual({ height: 44, left: 53, top: 127, width: 294 });
    expect(
      computeCommentEditorPlacement({
        isEditingExistingComment: false,
        metrics: {
          ...narrowMetrics,
          editorMaxY: 92,
          surfaceHeight: 100,
          y: 0.95,
        },
      }),
    ).toEqual({ height: 44, left: 53, top: 24, width: 294 });
  });

  test("derives editor bounds from the image and parent surfaces", () => {
    expect(
      computeCommentEditorLayoutMetrics({
        imageOffsetLeft: 50,
        imageOffsetTop: 20,
        imageSize: { height: 400, width: 800 },
        parentSize: { height: 500, width: 900 },
        point: { x: 0.2, y: 0.3 },
      }),
    ).toEqual({
      editorMaxX: 842,
      editorMaxY: 472,
      editorMinX: -42,
      editorMinY: -12,
      surfaceHeight: 400,
      surfaceWidth: 800,
      x: 0.2,
      y: 0.3,
    });
  });

  test("applies exponential wheel zoom, pinch zoom, and anchor correction", () => {
    expect(computeWheelZoomPercent(100, -10)).toBe(111);
    expect(computeWheelZoomPercent(100, 10)).toBe(90);
    expect(computeWheelZoomPercent(400, -1_000)).toBe(400);
    expect(
      computePinchZoomPercent({
        initialDistance: 100,
        initialZoomPercent: 50,
        nextDistance: 200,
      }),
    ).toBe(100);
    expect(
      computeZoomAnchorCorrection({
        anchorClientPoint: { x: 160, y: 100 },
        anchorRatio: { x: 0.25, y: 0.5 },
        nextTargetRect: { height: 200, left: 100, top: 20, width: 400 },
        windowZoom: 2,
      }),
    ).toEqual({ x: 20, y: 10 });
    expect(
      computeZoomViewportCenter({
        direction: "ltr",
        inlineOffset: -36,
        viewportRect: { height: 400, left: 20, top: 40, width: 800 },
        windowZoom: 1.5,
      }),
    ).toEqual({ x: 366, y: 240 });
    expect(
      computeZoomViewportCenter({
        direction: "rtl",
        inlineOffset: -36,
        viewportRect: { height: 400, left: 20, top: 40, width: 800 },
        windowZoom: 1.5,
      }),
    ).toEqual({ x: 474, y: 240 });
  });
});

describe("comment serialization", () => {
  test("clamps and formats coordinates with one fractional percent digit", () => {
    expect(formatImageCommentPercent(0.1234, "en-US")).toBe("12.3%");
    expect(formatImageCommentPercent(1.2, "en-US")).toBe("100%");
    expect(formatImageCommentPercent(-0.2, "en-US")).toBe("0%");
  });

  test("serializes image and comment order with additional instructions", () => {
    expect(
      serializeImageCommentGroups({
        imageCommentGroups: [
          {
            imageNumber: 2,
            comments: [
              { id: "a", text: "Remove the sign", x: 0.125, y: 0.5 },
              { id: "b", text: "Keep this", x: 1, y: 0 },
            ],
          },
        ],
        locales: "en-US",
        prompt: "  Match the lighting.  ",
      }),
    ).toBe(
      "Image 2:\n1. (x: 12.5%, y: 50%) Remove the sign\n2. (x: 100%, y: 0%) Keep this\n\nAdditional instructions:\nMatch the lighting.",
    );
  });

  test("returns the untouched prompt when there are no comment groups", () => {
    expect(
      serializeImageCommentGroups({
        imageCommentGroups: [],
        prompt: "  Keep whitespace  ",
      }),
    ).toBe("  Keep whitespace  ");
  });
});

describe("remove-mask model", () => {
  test("preserves stroke geometry and offers deterministic undo and redo", () => {
    const firstStroke = appendRemoveStrokePoint(
      createRemoveStroke({ brushSize: 70, point: { x: 0.1, y: 0.2 } }),
      { x: 0.3, y: 0.4 },
    );
    const secondStroke = createRemoveStroke({
      brushSize: 500,
      point: { x: 1.1, y: -0.1 },
    });
    const committed = commitRemoveStroke(
      commitRemoveStroke(createRemoveHistory(), firstStroke),
      secondStroke,
    );
    expect(committed.committed[1]).toEqual({
      brushSize: 130,
      points: [{ x: 1.1, y: -0.1 }],
    });

    const undone = undoRemoveStroke(committed);
    expect(undone.committed).toEqual([firstStroke]);
    expect(undone.redo).toEqual([committed.committed[1]]);
    expect(redoRemoveStroke(undone)).toEqual(committed);
  });

  test("scales brush diameter through natural and displayed image space", () => {
    expect(
      computeRemoveBrushNaturalPixels({
        brushSize: 70,
        naturalImageSize: { height: 500, width: 1_000 },
      }),
    ).toBe(70);
    expect(
      computeRemoveBrushCssPixels({
        brushSize: 70,
        displayedImageWidth: 500,
        naturalImageSize: { height: 500, width: 1_000 },
      }),
    ).toBe(35);
  });

  test("builds a black PNG plan with white round natural-pixel strokes", () => {
    const stroke = appendRemoveStrokePoint(
      createRemoveStroke({ brushSize: 70, point: { x: 0.1, y: 0.2 } }),
      { x: 0.3, y: 0.4 },
    );
    const plan = buildRemoveMaskDrawingPlan({
      naturalImageSize: { height: 500, width: 1_000 },
      strokes: [stroke],
    });

    expect(plan).toEqual({
      background: "black",
      commands: [
        {
          center: { x: 100, y: 100 },
          diameter: 70,
          kind: "circle",
        },
        {
          from: { x: 100, y: 100 },
          kind: "line",
          lineCap: "round",
          lineJoin: "round",
          lineWidth: 70,
          to: { x: 300, y: 200 },
        },
      ],
      height: 500,
      mimeType: "image/png",
      strokeColor: "white",
      suggestedFilename: "image-mask.png",
      width: 1_000,
    });
  });

  test("allows submission only with image dimensions, a stroke, and no loading lock", () => {
    const history = commitRemoveStroke(
      createRemoveHistory(),
      createRemoveStroke({ brushSize: 70, point: { x: 0.5, y: 0.5 } }),
    );
    expect(
      canSubmitRemoveMask({
        history,
        isLoading: false,
        naturalImageSize: { height: 500, width: 1_000 },
      }),
    ).toBe(true);
    expect(
      canSubmitRemoveMask({
        history,
        isLoading: true,
        naturalImageSize: { height: 500, width: 1_000 },
      }),
    ).toBe(false);
  });
});

describe("generated-image collection", () => {
  test("formats group time at the presentation boundary and resolves ring ownership", () => {
    expect(formatGeneratedImageGroupTime(Date.UTC(2026, 7, 14, 3, 30), "en-US")).toContain(
      "Aug 14, 2026",
    );
    expect(
      isGeneratedImageTileEmphasized({
        active: true,
        commentCount: 0,
        draftActive: false,
        selected: false,
        tool: "navigate",
      }),
    ).toBe(true);
    expect(
      isGeneratedImageTileEmphasized({
        active: true,
        commentCount: 0,
        draftActive: false,
        selected: false,
        tool: "select",
      }),
    ).toBe(false);
    expect(
      isGeneratedImageTileEmphasized({
        active: false,
        commentCount: 1,
        draftActive: false,
        selected: false,
        tool: "comment",
      }),
    ).toBe(true);
  });

  test("resolves an optimistic edit from its captured live-tail position", () => {
    const previous = makeGeneratedImage("previous");
    const optimistic = makeGeneratedImage("optimistic-image-edit:1", {
      groupId: "optimistic-image-edit:1",
      loading: true,
      status: "loading",
    });
    const focus = captureGeneratedImageOptimisticFocus({
      groups: [
        { id: "turn-1", images: [previous] },
        { id: optimistic.groupId, images: [optimistic] },
      ],
      optimisticImageId: optimistic.id,
      previousImageId: previous.id,
    });
    const appended = makeGeneratedImage("appended", {
      groupId: "turn-1",
    });

    expect(focus).toEqual({
      liveTailGroupId: "turn-1",
      liveTailImageCount: 1,
      optimisticImageId: optimistic.id,
      previousImageId: previous.id,
    });
    expect(
      resolveGeneratedImageOptimisticFocus({
        focus,
        groups: [{ id: "turn-1", images: [previous, appended] }],
      }),
    ).toBe(appended.id);
  });

  test("falls back to the newest ready group when the captured tail is replaced", () => {
    const previous = makeGeneratedImage("previous");
    const optimistic = makeGeneratedImage("optimistic-image-edit:1", {
      groupId: "optimistic-image-edit:1",
      loading: true,
      status: "loading",
    });
    const focus = captureGeneratedImageOptimisticFocus({
      groups: [{ id: "turn-1", images: [previous] }],
      optimisticImageId: optimistic.id,
      previousImageId: previous.id,
    });
    const replacement = makeGeneratedImage("replacement", {
      groupId: "turn-2",
    });

    expect(
      resolveGeneratedImageOptimisticFocus({
        focus,
        groups: [
          { id: "turn-1", images: [previous] },
          { id: "turn-2", images: [replacement] },
        ],
      }),
    ).toBe(replacement.id);
  });

  test("replaces optimistic identity, removes stale selection, and keeps stable order", () => {
    const optimistic = makeGeneratedImage("optimistic-image-edit:1", {
      status: "loading",
    });
    const generated = makeGeneratedImage("generated-2");
    const state = reconcileGeneratedImageCollection({
      nextImages: [optimistic, generated, { ...generated, alt: "Latest metadata" }],
      previous: {
        activeImageId: optimistic.id,
        images: [optimistic],
        selectedImageIds: [optimistic.id, "stale", optimistic.id],
      },
      replacement: {
        optimisticImageId: optimistic.id,
        replacementImageId: generated.id,
      },
    });

    expect(state.activeImageId).toBe(generated.id);
    expect(state.selectedImageIds).toEqual([generated.id]);
    expect(state.images.map((image) => image.id)).toEqual([optimistic.id, generated.id]);
    expect(state.images[1]?.alt).toBe("Latest metadata");
  });

  test("falls back to the last ready image and reconciles single or multiple selection", () => {
    const ready1 = makeGeneratedImage("ready-1");
    const ready2 = makeGeneratedImage("ready-2");
    const failed = makeGeneratedImage("failed", {
      error: "generation failed",
      status: "failed",
    });
    const state = reconcileGeneratedImageCollection({
      nextImages: [ready1, ready2, failed],
      previous: { activeImageId: "missing", images: [], selectedImageIds: [] },
    });

    expect(state.activeImageId).toBe(ready2.id);
    expect(
      selectGeneratedImage({
        imageId: ready1.id,
        mode: "single",
        selectedImageIds: [ready2.id],
      }),
    ).toEqual([ready1.id]);
    expect(
      selectGeneratedImage({
        imageId: ready1.id,
        mode: "multiple",
        selectedImageIds: [ready1.id, ready2.id],
      }),
    ).toEqual([ready2.id]);
  });
});

describe("image-edit submission intents", () => {
  test("keeps the authored aspect-ratio order and exact resize prompt", () => {
    expect(IMAGE_ASPECT_RATIO_OPTIONS).toEqual([
      { label: "Square", ratio: "1:1" },
      { label: "Portrait", ratio: "3:4" },
      { label: "Story", ratio: "9:16" },
      { label: "Landscape", ratio: "4:3" },
      { label: "Widescreen", ratio: "16:9" },
    ]);
    expect(buildImageResizePrompt("16:9")).toBe("Make the aspect ratio 16:9");

    const intent = buildResizeSubmissionIntent({
      aspectRatio: "3:4",
      entrypoint: "lightbox_edit_button",
      image: makeImage("original"),
    });
    expect(intent).toMatchObject({
      analytics: {
        hasGeneralInstruction: false,
        selectedImageCount: 1,
      },
      attachmentIds: ["original-attachment"],
      entrypoint: "lightbox_edit_button",
      isImageEditFollowUp: true,
      mode: "resize",
      promptRaw: "Make the aspect ratio 3:4",
      queuePolicy: "queue-while-active",
    });
  });

  test("orders the original and generated mask with the exact remove instruction", () => {
    const intent = buildRemoveSubmissionIntent({
      entrypoint: "image_click",
      image: makeImage("original"),
      mask: makeImage("mask", {
        attachmentId: "mask-attachment",
        dataUrl: "data:image/png;base64,mask",
      }),
    });

    expect(intent.promptRaw).toBe(IMAGE_REMOVE_PROMPT);
    expect(intent.attachmentIds).toEqual(["original-attachment", "mask-attachment"]);
    expect(intent.attachments.map((attachment) => attachment.role)).toEqual(["original", "mask"]);
    expect(intent.analytics.selectedImageCount).toBe(1);
  });

  test("removes the background with one original and the exact transformation instruction", () => {
    const image = makeImage("original");
    const intent = buildRemoveBackgroundSubmissionIntent({
      entrypoint: "image_click",
      image,
    });

    expect(intent).toMatchObject({
      analytics: {
        hasGeneralInstruction: false,
        selectedImageCount: 1,
      },
      attachmentIds: ["original-attachment"],
      attachments: [{ image, role: "original" }],
      entrypoint: "image_click",
      isImageEditFollowUp: true,
      mode: "remove_background",
      promptRaw: IMAGE_REMOVE_BACKGROUND_PROMPT,
      queuePolicy: "queue-while-active",
    });
  });

  test("retains original image numbering and attachments when only later images have comments", () => {
    const first = makeImage("first");
    const second = makeImage("second");
    const intent = buildCommentSubmissionIntent({
      commentedImages: [
        { comments: [], image: first },
        {
          comments: [{ id: "comment-1", text: "Brighten this", x: 0.25, y: 0.75 }],
          image: second,
        },
      ],
      entrypoint: "canvas_button",
      generalInstructions: "Keep the composition",
      locales: "en-US",
    });

    expect(intent.promptRaw).toBe(
      "Image 2:\n1. (x: 25%, y: 75%) Brighten this\n\nAdditional instructions:\nKeep the composition",
    );
    expect(intent.attachmentIds).toEqual(["first-attachment", "second-attachment"]);
    expect(intent.analytics).toEqual({
      commentCount: 1,
      hasGeneralInstruction: true,
      selectedImageCount: 2,
    });
  });

  test("submits an explicit selected subset without positional serialization", () => {
    const intent = buildSelectionSubmissionIntent({
      entrypoint: "canvas_button",
      images: [makeImage("second"), makeImage("fourth")],
    });

    expect(intent.mode).toBe("select");
    expect(intent.promptRaw).toBe("");
    expect(intent.attachmentIds).toEqual(["second-attachment", "fourth-attachment"]);
    expect(intent.analytics).toEqual({
      hasGeneralInstruction: false,
      selectedImageCount: 2,
    });
  });
});
