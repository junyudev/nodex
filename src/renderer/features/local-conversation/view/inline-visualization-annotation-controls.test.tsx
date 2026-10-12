import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { createInlineVisualizationAnnotations } from "../../../lib/inline-visualization/inline-visualization-annotations";
import { InlineVisualizationAnnotationControls } from "./inline-visualization-annotation-controls";

test("host controls preview four declared inputs and send their changes without replacing the document", async () => {
  const submit = vi.fn(async (_message: unknown) => {});
  const persist = vi.fn(async (_context: unknown) => {});
  const owner = createInlineVisualizationAnnotations({
    allowed: true,
    globals: () => {},
    submit,
    persist,
  });
  owner.handleMessage({
    type: "register",
    registrationId: "chart",
    targets: [
      {
        id: "chart",
        label: "Chart",
        selector: "#chart",
        tagName: "section",
        rect: { x: 0, y: 0, width: 300, height: 100 },
      },
    ],
    annotationControls: {
      controls: [
        {
          type: "range",
          callback: "Radius",
          label: "Radius",
          min: 0,
          max: 100,
          step: 1,
          currentValue: 10,
        },
        { type: "color", callback: "Tint", label: "Tint", currentValue: "#112233" },
        { type: "toggle", callback: "Details", label: "Details", currentValue: true },
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
  owner.setPresentation({ active: true, preview: false, ready: true });
  const view = render(<InlineVisualizationAnnotationControls owner={owner} />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Adjust visualization" }));
  });
  const color = await view.findByRole("textbox", { name: "Tint" });
  const slider = view.getByRole("slider", { name: "Radius" });
  expect(view.getByRole("button", { name: "Density" })).toBeDefined();
  await act(async () => {
    slider.focus();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.change(color, { target: { value: "#aabbcc" } });
    fireEvent.click(view.getByRole("checkbox", { name: "Details" }));
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Density" }));
  });
  const relaxed = await view.findByRole("menuitem", { name: "Relaxed" });
  await act(async () => {
    fireEvent.click(relaxed);
  });
  expect(owner.getSnapshot().hasEdits).toBe(true);
  const count = persist.mock.calls.length;
  await act(async () => {
    fireEvent.change(view.getByRole("textbox", { name: "Request changes" }), {
      target: { value: "Use these settings" },
    });
  });
  expect(persist.mock.calls).toHaveLength(count);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Send changes" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.lastCall?.[0]).toMatchObject({
    prompt: "Use these settings",
    context: {
      edits: [
        {
          target: "Chart",
          changes: [
            { label: "Radius", reference: null, value: 11 },
            { label: "Tint", reference: null, value: "#aabbcc" },
            { label: "Details", reference: null, value: false },
            { label: "Density", reference: null, value: "Relaxed" },
          ],
        },
      ],
    },
  });
  await waitFor(() => expect(view.queryByRole("textbox", { name: "Tint" })).toBeNull());
  await act(async () => {
    owner.setPresentation({ active: true, preview: true, ready: true });
  });
  expect(view.queryByRole("button", { name: "Adjust visualization" })).toBeNull();
  expect(owner.getSnapshot().hasEdits).toBe(true);
  view.unmount();
  owner.dispose();
});
