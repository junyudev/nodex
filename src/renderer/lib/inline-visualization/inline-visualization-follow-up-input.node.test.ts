import { expect, test } from "vitest";
import {
  captureInlineVisualizationFollowUp,
  captureInlineVisualizationAnnotationInput,
} from "./inline-visualization-follow-up-input";

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
          edits: [{ target: "Chart", changes: [{ label: "Radius", reference: null, value: 40 }] }],
        },
        imageAttachments: [],
        untrusted: true,
      },
    ],
  });
});
