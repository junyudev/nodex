import { expect, test } from "vitest";
import { captureInlineVisualizationFollowUp } from "./inline-visualization-follow-up-input";

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
