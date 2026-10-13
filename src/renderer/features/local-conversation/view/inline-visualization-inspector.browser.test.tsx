import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import type { CDPSession } from "@vitest/browser-playwright";
import { createInlineVisualizationAnnotations } from "@/lib/inline-visualization/inline-visualization-annotations";
import { InlineVisualizationAnnotationControls } from "./inline-visualization-annotation-controls";
import "../../../globals.css";

function inspectorOwner() {
  const submit = vi.fn(async () => {});
  const owner = createInlineVisualizationAnnotations({ allowed: true, globals: () => {}, submit });
  owner.handleMessage({
    type: "register",
    registrationId: "chart",
    targets: [
      {
        id: "chart",
        label: "Chart",
        selector: "#chart",
        tagName: "section",
        rect: { x: 0, y: 0, width: 100, height: 100 },
      },
    ],
    annotationControls: {
      controls: [
        { type: "color", callback: "Tint", label: "Tint", currentValue: "#11223344" },
        { type: "toggle", callback: "Details", label: "Details", currentValue: true },
      ],
    },
  });
  owner.setPresentation({ active: true, preview: false, ready: true });
  return owner;
}

// CDP input belongs to this isolated Chromium test. Coordinates include the runner iframe;
// it verifies browser pointer routing, not macOS window hit-testing.
async function mouse(
  type: "mousePressed" | "mouseMoved" | "mouseReleased",
  x: number,
  y: number,
  pressed: boolean,
) {
  const frame = window.frameElement?.getBoundingClientRect();
  await act(async () => {
    const session: CDPSession = cdp();
    await session.send("Input.dispatchMouseEvent", {
      type,
      x: x + (frame?.left ?? 0),
      y: y + (frame?.top ?? 0),
      button: pressed || type === "mouseReleased" ? "left" : "none",
      buttons: pressed ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
      pointerType: "mouse",
    });
  });
}
async function openInspector(owner: ReturnType<typeof inspectorOwner>) {
  const view = render(<InlineVisualizationAnnotationControls owner={owner} />);
  await act(async () => {
    await userEvent.click(view.getByRole("button", { name: "Adjust visualization" }));
  });
  expect(document.activeElement).toBe(view.getByRole("button", { name: "Adjust visualization" }));
  const header = view.getByText("Design controls").closest("header")!;
  const panel = header.closest<HTMLElement>('[data-slot="popover-content"]')!;
  await waitFor(() => {
    const bounds = panel.getBoundingClientRect();
    expect(bounds.width).toBeGreaterThan(300);
    expect(bounds.right).toBeCloseTo(window.innerWidth - 16, 0);
    expect(bounds.top).toBeGreaterThanOrEqual(62);
  });
  return { view, header, panel };
}

test("the floating inspector keeps its opposite edges during pointer resize, snaps after dragging and retains only its size on reopening", async () => {
  await page.viewport(1200, 900);
  const owner = inspectorOwner();
  const { view, header, panel } = await openInspector(owner);
  let last = panel.getBoundingClientRect();
  try {
    const left = view.getAllByRole("separator", { name: "Resize design controls width" })[0]!;
    const handle = left.getBoundingClientRect();
    await mouse("mouseMoved", handle.left + 1, handle.top + 30, false);
    await mouse("mousePressed", handle.left + 1, handle.top + 30, true);
    expect(left.hasPointerCapture(1)).toBe(true);
    await mouse("mouseMoved", handle.left - 59, handle.top + 30, true);
    await waitFor(() =>
      expect(panel.getBoundingClientRect().width).toBeCloseTo(last.width + 60, 0),
    );
    expect(panel.getBoundingClientRect().right).toBeCloseTo(last.right, 0);
    expect(panel.getBoundingClientRect().bottom).toBeCloseTo(last.bottom, 0);
    await mouse("mouseReleased", handle.left - 59, handle.top + 30, false);
    last = panel.getBoundingClientRect();
    const top = view.getByRole("separator", { name: "Resize design controls height" });
    await act(async () => {
      top.focus();
      await userEvent.keyboard("{ArrowUp}");
    });
    await waitFor(() =>
      expect(panel.getBoundingClientRect().height).toBeCloseTo(last.height + 10, 0),
    );
    await act(async () => {
      await userEvent.dblClick(left);
    });
    await waitFor(() => expect(panel.getBoundingClientRect().width).toBeCloseTo(368, 0));
    expect(panel.getBoundingClientRect().height).toBeCloseTo(last.height + 10, 0);
    const beforeMove = panel.getBoundingClientRect();
    const heading = header.getBoundingClientRect();
    await mouse("mouseMoved", heading.left + 50, heading.top + 10, false);
    await mouse("mousePressed", heading.left + 50, heading.top + 10, true);
    await mouse("mouseMoved", -200, heading.top + 10, true);
    await waitFor(() => expect(panel.getBoundingClientRect().left).toBeCloseTo(8, 0));
    await mouse("mouseReleased", -200, heading.top + 10, false);
    await waitFor(() => expect(panel.getBoundingClientRect().left).toBeCloseTo(16, 0));
    expect(panel.getBoundingClientRect().height).toBeCloseTo(beforeMove.height, 0);
    await act(async () => {
      await userEvent.click(view.getByRole("button", { name: "Close design controls" }));
    });
    await waitFor(() => expect(panel.isConnected).toBe(false));
    await act(async () => {
      await userEvent.click(view.getByRole("button", { name: "Adjust visualization" }));
    });
    const returned = view
      .getByText("Design controls")
      .closest("header")!
      .closest<HTMLElement>('[data-slot="popover-content"]')!;
    await waitFor(() =>
      expect(returned.getBoundingClientRect().right).toBeCloseTo(window.innerWidth - 16, 0),
    );
    expect(returned.getBoundingClientRect().height).toBeCloseTo(beforeMove.height, 0);
  } finally {
    await mouse("mouseReleased", 10, 10, false);
    view.unmount();
    owner.dispose();
  }
});

test("saturation dragging keeps the popup top fixed while previewing, and keyboard colors reach the same declared owner", async () => {
  await page.viewport(1200, 900);
  const owner = inspectorOwner();
  const { view } = await openInspector(owner);
  try {
    await act(async () => {
      await userEvent.click(view.getByRole("button", { name: "Choose tint" }));
    });
    const hex = await view.findByRole("textbox", { name: "Tint HEX" });
    const popup = hex.closest<HTMLElement>('[data-slot="popover-content"]')!;
    const saturation = popup.querySelector<HTMLElement>(".react-colorful__saturation")!;
    const original = popup.getBoundingClientRect();
    const square = saturation.getBoundingClientRect();
    const x = square.left + square.width * 0.75,
      y = square.top + square.height * 0.4;
    await mouse("mouseMoved", x, y, false);
    await mouse("mousePressed", x, y, true);
    await mouse("mouseMoved", x - 30, y + 10, true);
    await waitFor(() =>
      expect(popup.getBoundingClientRect().height).toBeLessThan(original.height - 20),
    );
    expect(popup.getBoundingClientRect().top).toBeCloseTo(original.top, 0);
    expect(owner.getSnapshot().hasEdits).toBe(true);
    expect(view.queryByRole("textbox", { name: "Tint HEX" })).toBeNull();
    await mouse("mouseReleased", x - 30, y + 10, false);
    await waitFor(() =>
      expect(popup.getBoundingClientRect().height).toBeCloseTo(original.height, 0),
    );
    const hue = popup.querySelector<HTMLElement>('.react-colorful__hue [role="slider"]')!;
    const before = owner
      .getSnapshot()
      .selected!.changes.find((change) => change.callback === "Tint")!.value;
    await act(async () => {
      hue.focus();
      await userEvent.keyboard("{ArrowRight}");
    });
    await waitFor(() =>
      expect(
        owner.getSnapshot().selected!.changes.find((change) => change.callback === "Tint")!.value,
      ).not.toEqual(before),
    );
    await act(async () => {
      await userEvent.keyboard("{Escape}");
    });
    await waitFor(() => expect(view.queryByRole("textbox", { name: "Tint HEX" })).toBeNull());
    await act(async () => {
      fireEvent.change(view.getByRole("textbox", { name: "Request changes" }), {
        target: { value: "Keep these" },
      });
      await userEvent.click(view.getByRole("button", { name: "Reset all" }));
    });
    expect((view.getByRole("textbox", { name: "Tint" }) as HTMLInputElement).value).toBe(
      "#11223344",
    );
    expect(
      (view.getByRole("textbox", { name: "Request changes" }) as HTMLTextAreaElement).value,
    ).toBe("Keep these");
    expect(owner.getSnapshot().hasEdits).toBe(false);
  } finally {
    await mouse("mouseReleased", 10, 10, false);
    view.unmount();
    owner.dispose();
  }
});

test("a shrinking viewport clamps the panel without clearing edits, and nonmodal focus and composing Escape preserve it", async () => {
  await page.viewport(1200, 900);
  const owner = inspectorOwner();
  const { view, panel } = await openInspector(owner);
  const outside = document.createElement("input");
  outside.setAttribute("aria-label", "Outside editor");
  document.body.append(outside);
  try {
    await act(async () => {
      fireEvent.change(view.getByRole("textbox", { name: "Tint" }), { target: { value: "#abc" } });
      fireEvent.change(view.getByRole("textbox", { name: "Request changes" }), {
        target: { value: "Retain this draft" },
      });
      outside.focus();
    });
    expect(document.activeElement).toBe(outside);
    expect(owner.getSnapshot().open).toBe(true);
    await act(async () => {
      await page.viewport(320, 260);
    });
    await waitFor(() => {
      const rect = panel.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(8);
      expect(rect.top).toBeGreaterThanOrEqual(62);
      expect(rect.right).toBeLessThanOrEqual(312);
      expect(rect.bottom).toBeLessThanOrEqual(252);
    });
    const request = view.getByRole("textbox", { name: "Request changes" });
    await act(async () => {
      request.focus();
      fireEvent.keyDown(request, { key: "Escape", isComposing: true });
    });
    expect(owner.getSnapshot().open).toBe(true);
    expect((request as HTMLTextAreaElement).value).toBe("Retain this draft");
    await act(async () => {
      await userEvent.keyboard("{Escape}");
    });
    await waitFor(() => expect(panel.isConnected).toBe(false));
    expect(owner.getSnapshot().body).toBe("Retain this draft");
    expect(owner.getSnapshot().hasEdits).toBe(true);
  } finally {
    outside.remove();
    view.unmount();
    owner.dispose();
    await page.viewport(1200, 900);
  }
});
