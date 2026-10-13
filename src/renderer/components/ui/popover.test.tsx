import { describe, expect, test } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { act, useState } from "react";
import { render, settleAsyncRender } from "@/test/dom";
import {
  NodexPopover,
  NodexPopoverContent,
  NodexPopoverTitle,
  NodexPopoverTrigger,
} from "./popover";

describe("nodex popover", () => {
  test("portals content by default", async () => {
    let view!: ReturnType<typeof render>;

    await act(async () => {
      view = render(
        <div data-testid="owner">
          <NodexPopover>
            <NodexPopoverTrigger>
              <button type="button">Open popover</button>
            </NodexPopoverTrigger>
            <NodexPopoverContent>
              <NodexPopoverTitle>Popover title</NodexPopoverTitle>
              <div>Popover body</div>
            </NodexPopoverContent>
          </NodexPopover>
        </div>,
      );
    });

    const trigger = view.getByText("Open popover");

    await act(async () => {
      fireEvent.click(trigger);
      await settleAsyncRender();
    });

    const content = view.container.ownerDocument.body.querySelector(
      '[data-slot="popover-content"]',
    );
    expect(content).not.toBeNull();
    expect(view.getByTestId("owner").querySelector('[data-slot="popover-content"]')).toBeNull();
    expect(view.getByText("Popover title").textContent).toBe("Popover title");
    expect(view.getByText("Popover body").textContent).toBe("Popover body");
  });

  test("can keep content inline with its structural owner", async () => {
    let view!: ReturnType<typeof render>;

    await act(async () => {
      view = render(
        <div data-testid="owner">
          <NodexPopover open>
            <NodexPopoverTrigger>
              <button type="button">Open inline popover</button>
            </NodexPopoverTrigger>
            <NodexPopoverContent portalled={false}>
              <div>Inline popover body</div>
            </NodexPopoverContent>
          </NodexPopover>
        </div>,
      );
      await settleAsyncRender();
    });

    const owner = view.getByTestId("owner");
    expect(owner.querySelector('[data-slot="popover-content"]')).not.toBeNull();
    expect(view.getByText("Inline popover body").textContent).toBe("Inline popover body");
  });
});

function FocusStablePopover() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">Outside control</button>
      <NodexPopover
        open={open}
        modal={false}
        onOpenChange={(next, details) => {
          if (
            details.reason === "focus-out" ||
            (details.event instanceof KeyboardEvent && details.event.isComposing)
          ) {
            details.cancel();
            return;
          }
          setOpen(next);
        }}
      >
        <NodexPopoverTrigger>
          <button type="button">Edit object</button>
        </NodexPopoverTrigger>
        <NodexPopoverContent initialFocus={false}>
          <input aria-label="Object value" />
        </NodexPopoverContent>
      </NodexPopover>
    </>
  );
}

test("nonmodal owners can reject focus dismissal and composing Escape while retaining ordinary Escape", async () => {
  const view = render(<FocusStablePopover />);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Edit object" }));
    await settleAsyncRender();
  });
  const input = view.getByRole("textbox", { name: "Object value" });
  await act(async () => {
    input.focus();
    view.getByRole("button", { name: "Outside control" }).focus();
    await settleAsyncRender();
  });
  expect(view.getByRole("textbox", { name: "Object value" })).toBe(input);
  await act(async () => {
    input.focus();
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    await settleAsyncRender();
  });
  expect(view.getByRole("textbox", { name: "Object value" })).toBe(input);
  await act(async () => {
    fireEvent.keyDown(input, { key: "Escape" });
    await settleAsyncRender();
  });
  expect(view.queryByRole("textbox", { name: "Object value" })).toBeNull();
});
