import { fireEvent } from "@testing-library/react";
import { act, createRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { NodexHoverCard, NodexHoverCardProvider } from "./hover-card";
import { dismissNodexFloatingSurfaces } from "./floating-surface";
import { NodexTooltip, NodexTooltipProvider } from "./tooltip";

function makeRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({}),
  };
}

async function advanceTimers(milliseconds: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds);
    await Promise.resolve();
  });
}

function HoverCardHarness({
  children,
  defaultOpen,
  disabled,
  dismissOnReferencePress,
  onOpenChange,
}: {
  children?: ReactNode;
  defaultOpen?: boolean;
  disabled?: boolean;
  dismissOnReferencePress?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <NodexHoverCardProvider>
      <NodexHoverCard
        ariaLabel="Project details"
        defaultOpen={defaultOpen}
        disabled={disabled}
        dismissOnReferencePress={dismissOnReferencePress}
        hoverCardContent={children ?? <button type="button">Open project</button>}
        onOpenChange={onOpenChange}
      >
        <button type="button">Project row</button>
      </NodexHoverCard>
    </NodexHoverCardProvider>
  );
}

describe("NodexHoverCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("opens after 700 ms and closes after 100 ms", async () => {
    const view = render(<HoverCardHarness />);
    const reference = view.getByRole("button", { name: "Project row" });

    fireEvent.mouseEnter(reference, { clientX: 50, clientY: 15 });
    await advanceTimers(699);
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();

    await advanceTimers(1);
    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();

    fireEvent.mouseLeave(reference, { clientX: 0, clientY: 15 });
    await advanceTimers(99);
    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();

    await advanceTimers(1);
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();
  });

  test("cancels a pending close when the pointer re-enters", async () => {
    const view = render(<HoverCardHarness />);
    const reference = view.getByRole("button", { name: "Project row" });

    fireEvent.mouseEnter(reference, { clientX: 50, clientY: 15 });
    await advanceTimers(700);
    fireEvent.mouseLeave(reference, { clientX: 0, clientY: 15 });
    await advanceTimers(50);
    fireEvent.mouseEnter(reference, { clientX: 50, clientY: 15 });
    await advanceTimers(100);

    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();
  });

  test("activating a reference cancels hover and requires a new pointer entry", async () => {
    const view = render(<HoverCardHarness dismissOnReferencePress />);
    const reference = view.getByRole("button", { name: "Project row" });

    await act(async () => {
      fireEvent.mouseEnter(reference);
      await Promise.resolve();
    });
    await advanceTimers(350);
    await act(async () => {
      fireEvent.click(reference);
      await Promise.resolve();
    });
    await advanceTimers(700);
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();

    await act(async () => {
      fireEvent.mouseMove(reference);
      await Promise.resolve();
    });
    await advanceTimers(700);
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();

    await act(async () => {
      fireEvent.mouseLeave(reference);
      fireEvent.mouseEnter(reference);
      await Promise.resolve();
    });
    await advanceTimers(700);
    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();

    await act(async () => {
      fireEvent.click(reference);
      await Promise.resolve();
    });
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();
    await act(async () => {
      fireEvent.mouseMove(reference);
      await Promise.resolve();
    });
    await advanceTimers(700);
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();
  });

  test("an activated reference can reveal details again after keyboard focus leaves", async () => {
    const view = render(
      <>
        <HoverCardHarness dismissOnReferencePress />
        <button type="button">After card</button>
      </>,
    );
    const reference = view.getByRole("button", { name: "Project row" });
    await act(async () => {
      reference.focus();
      await Promise.resolve();
    });
    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();

    await act(async () => {
      fireEvent.click(reference);
      await Promise.resolve();
    });
    await advanceTimers(700);
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();

    await act(async () => {
      view.getByRole("button", { name: "After card" }).focus();
      reference.focus();
      await Promise.resolve();
    });
    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();
  });

  test("keeps the card open across the eight-pixel safe transit corridor", async () => {
    const view = render(<HoverCardHarness />);
    const reference = view.getByRole("button", { name: "Project row" });

    Object.defineProperty(reference, "getBoundingClientRect", {
      configurable: true,
      value: () => makeRect(300, 0, 100, 30),
    });
    fireEvent.mouseEnter(reference, { clientX: 50, clientY: 15 });
    await advanceTimers(700);

    const dialog = view.getByRole("dialog", { name: "Project details" });
    Object.defineProperty(dialog, "getBoundingClientRect", {
      configurable: true,
      value: () => makeRect(98, 0, 200, 120),
    });

    fireEvent.mouseLeave(reference, { clientX: 300, clientY: 15 });
    fireEvent.mouseMove(document, { clientX: 299, clientY: 22 });
    await advanceTimers(100);
    fireEvent.mouseEnter(dialog, { clientX: 290, clientY: 22 });
    await advanceTimers(150);

    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();
  });

  test("hands an open card to a peer immediately and resets after 300 ms", async () => {
    const view = render(
      <NodexHoverCardProvider>
        <NodexHoverCard ariaLabel="First details" hoverCardContent="First content">
          <button type="button">First row</button>
        </NodexHoverCard>
        <NodexHoverCard ariaLabel="Second details" hoverCardContent="Second content">
          <button type="button">Second row</button>
        </NodexHoverCard>
      </NodexHoverCardProvider>,
    );
    const first = view.getByRole("button", { name: "First row" });
    const second = view.getByRole("button", { name: "Second row" });

    fireEvent.mouseEnter(first);
    await advanceTimers(700);
    expect(view.getByRole("dialog", { name: "First details" })).not.toBeNull();

    fireEvent.mouseEnter(second);
    await advanceTimers(1);
    expect(view.queryByRole("dialog", { name: "First details" })).toBeNull();
    expect(view.getByRole("dialog", { name: "Second details" })).not.toBeNull();

    fireEvent.mouseLeave(second, { clientX: 0, clientY: 0 });
    await advanceTimers(100);
    await advanceTimers(300);
    fireEvent.mouseEnter(first);
    await advanceTimers(699);
    expect(view.queryByRole("dialog", { name: "First details" })).toBeNull();

    await advanceTimers(1);
    expect(view.getByRole("dialog", { name: "First details" })).not.toBeNull();
  });

  test("opens from focus and Escape returns focus without trapping the page", async () => {
    const view = render(
      <>
        <HoverCardHarness />
        <button type="button">After card</button>
      </>,
    );
    const reference = view.getByRole("button", { name: "Project row" });

    await act(async () => {
      fireEvent.keyDown(window, { key: "Tab" });
      reference.focus();
      await Promise.resolve();
    });

    const dialog = view.getByRole("dialog", { name: "Project details" });
    expect(reference.getAttribute("aria-haspopup")).toBe("dialog");
    expect(reference.getAttribute("aria-controls")).toBe(dialog.id);

    const action = view.getByRole("button", { name: "Open project" });
    await act(async () => {
      action.focus();
      fireEvent.keyDown(action, { key: "Escape" });
      await Promise.resolve();
    });

    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();
    expect(document.activeElement).toBe(reference);

    await act(async () => {
      view.getByRole("button", { name: "After card" }).focus();
    });
    expect(document.activeElement).toBe(view.getByRole("button", { name: "After card" }));
  });

  test("preserves reference handlers and closes on context menu or disable", async () => {
    const pointerEnter = vi.fn();
    const contextMenu = vi.fn();
    const referenceRef = createRef<HTMLButtonElement>();

    function DisabledHarness() {
      const [disabled, setDisabled] = useState(false);
      return (
        <NodexHoverCardProvider>
          <NodexHoverCard
            ariaLabel="Project details"
            defaultOpen
            disabled={disabled}
            hoverCardContent="Project content"
          >
            <button
              ref={referenceRef}
              type="button"
              onContextMenu={contextMenu}
              onPointerEnter={pointerEnter}
            >
              Project row
            </button>
          </NodexHoverCard>
          <button
            type="button"
            onClick={() => {
              setDisabled(true);
            }}
          >
            Disable
          </button>
        </NodexHoverCardProvider>
      );
    }

    const view = render(<DisabledHarness />);
    const reference = view.getByRole("button", { name: "Project row" });

    expect(referenceRef.current).toBe(reference);
    fireEvent.pointerEnter(reference);
    expect(pointerEnter).toHaveBeenCalledTimes(1);
    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();

    fireEvent.contextMenu(reference);
    expect(contextMenu).toHaveBeenCalledTimes(1);
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();

    fireEvent.mouseEnter(reference);
    await advanceTimers(1);
    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Disable" }));
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();
  });

  test("supports controlled state and global dismissal", async () => {
    const openChanges: boolean[] = [];

    function ControlledHarness() {
      const [open, setOpen] = useState(true);
      return (
        <NodexHoverCardProvider>
          <NodexHoverCard
            ariaLabel="Project details"
            hoverCardContent="Project content"
            open={open}
            onOpenChange={(nextOpen) => {
              openChanges.push(nextOpen);
              setOpen(nextOpen);
            }}
          >
            <button type="button">Project row</button>
          </NodexHoverCard>
        </NodexHoverCardProvider>
      );
    }

    const view = render(<ControlledHarness />);
    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();

    await act(async () => {
      dismissNodexFloatingSurfaces();
    });

    expect(openChanges).toEqual([false]);
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();
  });

  test("reports an open surface as closed when its owner unmounts", async () => {
    const onOpenChange = vi.fn();
    const view = render(<HoverCardHarness defaultOpen onOpenChange={onOpenChange} />);

    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();

    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("dismisses on window blur and hidden-document transitions", async () => {
    const view = render(<HoverCardHarness defaultOpen />);

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();

    fireEvent.mouseEnter(view.getByRole("button", { name: "Project row" }));
    await advanceTimers(1);
    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();

    const originalVisibilityState = document.visibilityState;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    try {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } finally {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: originalVisibilityState,
      });
    }

    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();
  });

  test("keeps the hover card open when a nested descriptive tooltip opens", () => {
    const view = render(
      <NodexHoverCardProvider>
        <NodexTooltipProvider>
          <NodexHoverCard
            ariaLabel="Project details"
            defaultOpen
            hoverCardContent={
              <NodexTooltip defaultOpen tooltipContent="Pin this project">
                <button type="button">Pin</button>
              </NodexTooltip>
            }
          >
            <button type="button">Project row</button>
          </NodexHoverCard>
        </NodexTooltipProvider>
      </NodexHoverCardProvider>,
    );

    expect(view.getByRole("dialog", { name: "Project details" })).not.toBeNull();
    expect(view.getByRole("tooltip")).not.toBeNull();
  });
});
