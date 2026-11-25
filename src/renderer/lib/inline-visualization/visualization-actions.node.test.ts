import { expect, test, vi, describe } from "vite-plus/test";
import { createInlineVisualizationAnnotations } from "./inline-visualization-annotations";
import {
  canExpandInlineVisualization,
  inlineVisualizationContentBounds,
  inlineVisualizationContentWidth,
} from "./inline-visualization-presentation";
import { unified } from "unified";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  remarkInlineVisualizations,
  resolveInlineVisualizationSourceThreadId,
} from "./inline-visualization-directives";
import { stripCodexRemarkDirectiveLines } from "../../../shared/codex-remark-directives";
import { createVisualizationDownloadHandler } from "./inline-visualization-download";
import {
  captureInlineVisualizationFollowUp,
  captureInlineVisualizationAnnotationInput,
} from "./inline-visualization-follow-up-input";
import { sendInlineVisualizationFollowUp } from "./inline-visualization-follow-up";
import {
  clampInspectorPosition,
  inspectorBoundsOverlap,
  inspectorKeyboardSize,
  inspectorMaximumSize,
  inspectorPickerColor,
  normalizeInspectorPopupHex,
  placeInspector,
  resizeInspector,
} from "./inline-visualization-inspector-geometry";
import { resolveVisualizationImageCrop } from "../../../shared/visualization-image-capture";

describe("inline visualization annotations", () => {
  const registration = (id = "first", targetId = "target") => ({
    type: "register",
    registrationId: id,
    targets: [
      {
        id: targetId,
        label: "Chart",
        selector: "#chart",
        tagName: "section",
        rect: { x: 0, y: 0, width: 200, height: 100 },
      },
    ],
    annotationControls: {
      controls: [
        {
          type: "range",
          callback: "Radius",
          label: "Radius",
          reference: "chart.radius",
          min: 0,
          max: 100,
          step: 1,
          currentValue: 10,
        },
        {
          type: "select",
          callback: "Density",
          label: "Density",
          currentValue: "compact",
          options: [
            { label: "Compact", value: "compact" },
            { label: "Relaxed", value: "relaxed" },
          ],
        },
      ],
    },
  });

  test("accepted controls preview, reset and submit only labelled untrusted context while body writes stay transient", async () => {
    const globals = vi.fn(),
      persist = vi.fn(async (_context: unknown) => {}),
      submit = vi.fn(async (_message: unknown) => {});
    const owner = createInlineVisualizationAnnotations({ allowed: true, globals, persist, submit });
    owner.handleMessage(registration());
    owner.setPresentation({ active: true, preview: false, ready: true });
    owner.open();
    owner.change("Radius", 40);
    owner.change("Density", "relaxed");
    expect(globals.mock.lastCall?.[0]).toMatchObject({
      active: true,
      changes: [
        {
          annotationControlChanges: expect.arrayContaining([
            { callback: "Radius", previousValue: 10, value: 40 },
          ]),
        },
      ],
    });
    const writes = persist.mock.calls.length;
    const globalUpdates = globals.mock.calls.length;
    owner.setBody("Please keep the colors");
    expect(persist.mock.calls).toHaveLength(writes);
    expect(globals.mock.calls).toHaveLength(globalUpdates);
    owner.handleMessage({ type: "dispose", registrationId: "unknown" });
    expect(persist.mock.calls).toHaveLength(writes);
    await owner.submit();
    expect(submit.mock.lastCall?.[0]).toEqual({
      prompt: "Please keep the colors",
      title: "Visualization changes",
      context: {
        edits: [
          {
            target: "Chart",
            changes: [
              { label: "Radius", reference: "chart.radius", value: 40 },
              { label: "Density", reference: null, value: "Relaxed" },
            ],
          },
        ],
      },
    });
    expect(owner.getSnapshot().open).toBe(false);
    owner.open();
    owner.handleMessage({ type: "variants", selectedVariants: [{ carousel: 0, variant: "Dots" }] });
    owner.reset();
    expect(owner.getSnapshot().hasEdits).toBe(false);
    expect(persist.mock.lastCall?.[0]).toEqual({
      edits: [],
      selectedVariants: [{ carousel: 0, variant: "Dots" }],
    });
  });

  test("a registration update invalidates stale drafts; last target ownership and disposal fence detached edits", () => {
    const owner = createInlineVisualizationAnnotations({ allowed: true, globals: () => {} });
    owner.handleMessage(registration());
    owner.setPresentation({ active: true, preview: false, ready: true });
    owner.open();
    owner.change("Radius", 40);
    const next = registration();
    next.annotationControls.controls[0]!.currentValue = 20;
    owner.handleMessage({ ...next, type: "update" });
    expect(owner.getSnapshot().hasEdits).toBe(false);
    owner.handleMessage(registration("second"));
    expect(owner.getSnapshot().rows.map((row) => row.registrationId)).toEqual(["second"]);
    expect(() => owner.handleMessage(registration("second"))).toThrow("cannot call tools");
    owner.handleMessage({ type: "dispose", registrationId: "second" });
    expect(owner.getSnapshot().rows.map((row) => row.registrationId)).toEqual(["first"]);
    owner.dispose();
    expect(() => owner.handleMessage(registration("late"))).toThrow("cannot call tools");
  });

  test("bounds are admitted synchronously and denied calls do not consume capacity", () => {
    const owner = createInlineVisualizationAnnotations({ allowed: true, globals: () => {} });
    for (let index = 0; index < 64; index++)
      owner.handleMessage(registration(`r${index}`, `t${index}`));
    expect(() => owner.handleMessage(registration("overflow"))).toThrow();
    owner.handleMessage({ type: "dispose", registrationId: "r0" });
    expect(() => owner.handleMessage(registration("overflow"))).not.toThrow();
    const invalid = registration("invalid");
    invalid.annotationControls.controls[0]!.step = 0;
    expect(() =>
      owner.handleMessage({ ...invalid, type: "update", registrationId: "r1" }),
    ).toThrow();
    owner.setPresentation({ active: true, preview: false, ready: true });
    owner.open();
    owner.change("Radius", 1000);
    expect(owner.getSnapshot().hasEdits).toBe(false);
  });

  test("total targets and serialized controls are bounded before acknowledgement", () => {
    const owner = createInlineVisualizationAnnotations({ allowed: true, globals: () => {} });
    const create = (index: number, count: number) => ({
      ...registration(`r${index}`, `t${index}`),
      targets: Array.from({ length: count }, (_, target) => ({
        ...registration().targets[0]!,
        id: `r${index}t${target}`,
      })),
    });
    for (let index = 0; index < 8; index++) owner.handleMessage(create(index, 128));
    expect(() => owner.handleMessage(create(8, 1))).toThrow();
    owner.handleMessage({ ...create(0, 1), type: "update" });
    expect(() => owner.handleMessage(create(8, 127))).not.toThrow();
    const options = Array.from({ length: 12 }, (_, index) => ({
      label: `Option ${index}`,
      value: `${index}` + "x".repeat(500),
    }));
    expect(() =>
      owner.handleMessage({
        ...create(9, 1),
        annotationControls: {
          controls: Array.from({ length: 3 }, (_, index) => ({
            type: "select",
            label: "Selection",
            callback: `Select${index}`,
            currentValue: options[0]!.value,
            options,
          })),
        },
      }),
    ).toThrow();
  });

  test("variants persist independently of annotations and preview/inactive gates do not clear context", async () => {
    const persist = vi.fn(async (_context: unknown) => {}),
      submit = vi.fn(async () => {
        throw new Error("offline");
      });
    const disabled = createInlineVisualizationAnnotations({
      allowed: false,
      globals: () => {},
      persist,
    });
    expect(() => disabled.handleMessage(registration())).toThrow();
    disabled.handleMessage({
      type: "variants",
      selectedVariants: [{ carousel: 0, variant: "Bars" }],
    });
    expect(persist.mock.lastCall?.[0]).toEqual({
      edits: [],
      selectedVariants: [{ carousel: 0, variant: "Bars" }],
    });
    const owner = createInlineVisualizationAnnotations({
      allowed: true,
      globals: () => {},
      persist,
      submit,
    });
    owner.handleMessage(registration());
    owner.setPresentation({ active: true, preview: false, ready: true });
    owner.open();
    owner.change("Radius", 40);
    await expect(owner.submit()).rejects.toThrow("offline");
    expect(owner.getSnapshot().open).toBe(true);
    const writes = persist.mock.calls.length;
    owner.setPresentation({ active: false, preview: false, ready: true });
    expect(owner.getSnapshot()).toMatchObject({ visible: false, open: false, hasEdits: true });
    expect(persist.mock.calls).toHaveLength(writes);
    expect(() =>
      owner.handleMessage({ type: "select", registrationId: "first", targetId: "target" }),
    ).toThrow();
    owner.setPresentation({ active: true, preview: true, ready: true });
    expect(owner.getSnapshot().visible).toBe(false);
    expect(canExpandInlineVisualization({ mode: "wide", variant: "inline" })).toBe(true);
    expect(canExpandInlineVisualization({ mode: "wide", variant: "live" })).toBe(false);
    expect(canExpandInlineVisualization({ mode: "wide", htmlStreaming: true })).toBe(false);
  });
});

describe("inline visualization directives", () => {
  test("parses ordered, quoted and unquoted attributes without treating literal code as executable", async () => {
    const processor = unified().use(remarkInlineVisualizations).freeze();
    const content =
      '::codex-inline-vis{threadId="source-id" mode=wide file=sample.html}\n\n```md\n::codex-inline-vis{file="literal.html"}\n```\n\n`::codex-inline-vis{file="inline.html"}`';
    const tree = await processor.run(
      fromMarkdown(content, {
        extensions: processor.data("micromarkExtensions"),
        mdastExtensions: processor.data("fromMarkdownExtensions"),
      }),
    );
    expect(tree.children[0]).toMatchObject({
      type: "leafDirective",
      data: {
        hName: "nodex-visualization",
        hProperties: { file: "sample.html", threadid: "source-id", mode: "wide" },
      },
    });
    expect(tree.children[1]).toMatchObject({
      type: "code",
      value: '::codex-inline-vis{file="literal.html"}',
    });
    expect(tree.children[2]).toMatchObject({
      type: "paragraph",
      children: [{ type: "inlineCode" }],
    });
  });
  test("preserves renderable directives and fenced examples while removing metadata", () => {
    const content =
      'Text\n::inbox-item{title="Hidden"}\n::codex-inline-vis{file="sample.html"}\n```\n::inbox-item{title="Literal"}\n```';
    expect(stripCodexRemarkDirectiveLines(content, { keepInlineVisualizations: true })).toBe(
      'Text\n\n::codex-inline-vis{file="sample.html"}\n```\n::inbox-item{title="Literal"}\n```',
    );
    expect(stripCodexRemarkDirectiveLines('::codex-inline-vis{file="sample.html"}')).toBe("");
  });
  test("accepts only declared display or matching native file ownership", () => {
    const input = {
      file: "sample.html",
      threadId: "visible",
      changedFilePaths: [
        "/other/no-match.html",
        "C:\\home\\visualizations\\2026\\10\\12\\source-native\\sample.html",
      ],
    };
    expect(resolveInlineVisualizationSourceThreadId(input)).toBe("source-native");
    expect(
      resolveInlineVisualizationSourceThreadId({ ...input, declaredSourceThreadId: "declared" }),
    ).toBe("source-native");
    expect(resolveInlineVisualizationSourceThreadId({ ...input, file: "different.html" })).toBe(
      "visible",
    );
  });
});

describe("inline visualization download", () => {
  test("checks the attempt capability before consuming a single native gesture", async () => {
    let available = true;
    const consumeGesture = vi.fn(async () => {
      const grant = available;
      available = false;
      return grant;
    });
    const save = vi.fn();
    const signal = new AbortController().signal;
    const handler = createVisualizationDownloadHandler({
      capability: "attempt-a",
      signal,
      consumeGesture,
      save,
    });
    const blob = new Blob(["download bytes"], { type: "text/plain" });
    for (const invalid of [
      null,
      { blob, name: "file.txt", capability: "retired" },
      { blob: {}, name: "file.txt", capability: "attempt-a" },
      { blob, name: " ", capability: "attempt-a" },
      { blob, name: "x".repeat(256), capability: "attempt-a" },
    ])
      await expect(handler(invalid)).rejects.toThrow();
    expect(consumeGesture).not.toHaveBeenCalled();
    await handler({ blob, name: "  file.txt  ", capability: "attempt-a" });
    expect(save).toHaveBeenCalledExactlyOnceWith(blob, "file.txt");
    await expect(handler({ blob, name: "file.txt", capability: "attempt-a" })).rejects.toThrow();
    expect(save).toHaveBeenCalledTimes(1);
  });

  test("fences retirement before and during native gesture authorization", async () => {
    const controller = new AbortController();
    let finish: (value: boolean) => void = () => {};
    const consumeGesture = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const save = vi.fn();
    const handler = createVisualizationDownloadHandler({
      capability: "attempt-a",
      signal: controller.signal,
      consumeGesture,
      save,
    });
    const input = { blob: new Blob(["bytes"]), name: "file.txt", capability: "attempt-a" };
    const pending = handler(input);
    controller.abort();
    finish(true);
    await expect(pending).rejects.toThrow();
    await expect(handler(input)).rejects.toThrow();
    expect(consumeGesture).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("inline visualization follow up input", () => {
  test("captures app context independently and cannot mutate a submitted visualization message", () => {
    const context = { selected: [1, 3] };
    const captured = captureInlineVisualizationFollowUp({
      sourceId: "widget-a",
      prompt: "Inspect selection",
      context,
    });
    context.selected.push(5);
    expect(captured).toEqual({
      source: "visualization",
      sourceId: "widget-a",
      text: "Inspect selection",
      structuredContent: { selected: [1, 3] },
    });
    expect(
      captureInlineVisualizationFollowUp({ sourceId: "widget-a", prompt: "Reviewed edit" }),
    ).toEqual({ source: "visualization", sourceId: "widget-a", text: "Reviewed edit" });
  });

  test.each([null, [], "context", { value: Number.NaN }])(
    "rejects non-object JSON visualization context: %j",
    (context) => {
      expect(() =>
        captureInlineVisualizationFollowUp({ sourceId: "widget-a", prompt: "Inspect", context }),
      ).toThrow("context");
    },
  );
  test("host annotations capture an independent explicit context attachment without promoting it into user prose", () => {
    const context = {
      edits: [{ target: "Chart", changes: [{ label: "Radius", reference: null, value: 40 }] }],
    };
    const captured = captureInlineVisualizationAnnotationInput({
      sourceId: "/chart.html",
      prompt: "Apply the changes",
      title: "Visualization changes",
      context,
    });
    context.edits[0]!.changes[0]!.value = 50;
    expect(captured).toEqual({
      text: "Apply the changes",
      mcpAppModelContextAttachments: [
        {
          id: "/chart.html",
          kind: "context",
          sourceName: "Visualization changes",
          text: null,
          structuredContent: {
            edits: [
              { target: "Chart", changes: [{ label: "Radius", reference: null, value: 40 }] },
            ],
          },
          imageAttachments: [],
          untrusted: true,
        },
      ],
    });
  });
});

describe("inline visualization follow-up authorization", () => {
  const setup = (gesture: boolean) => ({
    message: { prompt: "Widget proposal", context: { selected: 3 } },
    sourceId: "application-owned-widget",
    signal: new AbortController().signal,
    consumeGesture: vi.fn(async () => gesture),
    review: vi.fn(async () => "Edited user prompt" as string | null),
    send: vi.fn(async () => {}),
  });
  test("passes gesture-backed content separately with the application-owned source identity", async () => {
    const input = setup(true);
    await sendInlineVisualizationFollowUp(input);
    expect(input.review).not.toHaveBeenCalled();
    expect(input.send).toHaveBeenCalledWith({
      sourceId: input.sourceId,
      prompt: "Widget proposal",
      context: { selected: 3 },
    });
  });
  test("reviews a gesture-free request and sends only the reviewed prompt", async () => {
    const input = setup(false);
    await sendInlineVisualizationFollowUp(input);
    expect(input.review).toHaveBeenCalledWith(input.message, input.signal);
    expect(input.send).toHaveBeenCalledWith({
      sourceId: input.sourceId,
      prompt: "Edited user prompt",
    });
  });
  test("cancellation never dispatches a proposed message", async () => {
    const input = setup(false);
    input.review.mockResolvedValue(null);
    await sendInlineVisualizationFollowUp(input);
    expect(input.send).not.toHaveBeenCalled();
  });
  test("a retired document cannot dispatch after asynchronous authorization or review", async () => {
    const controller = new AbortController();
    const input = { ...setup(false), signal: controller.signal };
    input.review.mockImplementation(async () => {
      controller.abort();
      return "Too late";
    });
    await sendInlineVisualizationFollowUp(input);
    expect(input.send).not.toHaveBeenCalled();
    input.consumeGesture.mockClear();
    await sendInlineVisualizationFollowUp(input);
    expect(input.consumeGesture).not.toHaveBeenCalled();
  });
});

describe("inline visualization inspector geometry", () => {
  const viewport = { width: 1000, height: 800, scale: 1 };
  test("places a new panel to the right and picks the first clear alternative around declared obstacles", () => {
    const panel = { left: 0, top: 0, width: 368, height: 280 };
    expect(placeInspector(panel, viewport, [], "default")).toEqual({ left: 616, bottom: 563 });
    const obstacle = { left: 600, top: 250, width: 400, height: 400 };
    const position = placeInspector(panel, viewport, [obstacle], "default");
    expect(position).toEqual({ left: 16, bottom: 784 });
    expect(
      inspectorBoundsOverlap(
        { ...panel, left: position.left, top: position.bottom - panel.height },
        obstacle,
      ),
    ).toBe(false);
  });
  test("settles a moved panel at the nearest clear location and bounds every viewport edge", () => {
    expect(
      placeInspector({ left: 70, top: 200, width: 300, height: 200 }, viewport, [], "nearest"),
    ).toEqual({ left: 16, bottom: 523 });
    expect(
      clampInspectorPosition({ left: -200, bottom: 2000 }, { width: 300, height: 200 }, viewport),
    ).toEqual({ left: 8, bottom: 792 });
    expect(
      clampInspectorPosition({ left: 2000, bottom: -200 }, { width: 300, height: 200 }, viewport),
    ).toEqual({ left: 692, bottom: 262 });
  });
  test("resizes in CSS units while retaining the opposite edge and bottom under scale", () => {
    const scaled = { ...viewport, scale: 2 };
    expect(inspectorMaximumSize(scaled)).toEqual({ width: 492, height: 342 });
    const bounds = { left: 100, top: 250, width: 300, height: 180 };
    expect(resizeInspector(bounds, { width: 500, height: 400 }, "top-left", scaled)).toEqual({
      position: { left: 8, bottom: 430 },
      size: { width: 196, height: 161 },
    });
    expect(resizeInspector(bounds, { width: 200, height: 100 }, "right", scaled)).toEqual({
      position: { left: 100, bottom: 430 },
      size: { width: 200, height: 100 },
    });
  });
  test("uses edge direction, ten-unit keyboard steps and minimum/maximum endpoints", () => {
    expect(inspectorKeyboardSize(100, "ArrowRight", "right", 100, 120)).toBe(110);
    expect(inspectorKeyboardSize(100, "ArrowRight", "left", 100, 120)).toBe(100);
    expect(inspectorKeyboardSize(100, "ArrowLeft", "left", 100, 120)).toBe(110);
    expect(inspectorKeyboardSize(115, "ArrowUp", "top", 100, 120)).toBe(120);
    expect(inspectorKeyboardSize(115, "Home", "top", 100, 120)).toBe(100);
    expect(inspectorKeyboardSize(115, "End", "top", 100, 120)).toBe(120);
    expect(inspectorKeyboardSize(115, "ArrowLeft", "top", 100, 120)).toBeNull();
  });
  test.each([
    [" #aBc ", "#AABBCC"],
    ["aabbcc", "#AABBCC"],
    ["#1234", null],
    ["#11223344", null],
    ["invalid", null],
  ] as const)("opaque popup HEX validates %s", (input, expected) => {
    expect(normalizeInspectorPopupHex(input)).toBe(expected);
  });
  test("the opaque picker preserves authored alpha outside its preview representation", () => {
    expect(inspectorPickerColor("#abc9")).toBe("#AABBCC");
    expect(inspectorPickerColor("#abcdef99")).toBe("#ABCDEF");
    expect(inspectorPickerColor("unknown")).toBe("#000000");
  });
});

describe("visualization content and paint bounds", () => {
  test("keeps paint overflow outside measured content and includes it in native image capture", () => {
    const viewport = { width: 500.5, height: 151 };
    const content = inlineVisualizationContentBounds(viewport)!;
    expect(inlineVisualizationContentWidth(viewport.width)).toBe(490.5);
    expect(content).toEqual({ x: 5, y: 5, width: 490.5, height: 141 });
    expect(resolveVisualizationImageCrop({ width: 1001, height: 302 }, content, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 1001,
      height: 302,
    });
  });

  test("rejects native viewports without a content area", () => {
    expect(inlineVisualizationContentWidth(8)).toBe(0);
    for (const viewport of [
      { width: 10, height: 50 },
      { width: 50, height: 10 },
      { width: NaN, height: 50 },
      { width: 50, height: Infinity },
    ])
      expect(inlineVisualizationContentBounds(viewport)).toBeNull();
  });
});
