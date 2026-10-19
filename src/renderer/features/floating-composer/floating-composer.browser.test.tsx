import "../../globals.css";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { clearPersistedAtomStoreForTests, readAtom } from "@/lib/persisted-atom-store";
import {
  ComposerContextRail,
  ComposerContextRailSlot,
} from "@/features/local-conversation/view/composer-context-rail";
import { FloatingComposer, type FloatingComposerState } from "./floating-composer";

const PANE = { left: 40, top: 30, width: 1000, height: 700 };
const PREFERENCE_KEY = "nodex:floating-composer:v1";

async function storedPreference() {
  return (await readAtom(PREFERENCE_KEY, null)) as { width?: number; dock?: string } | null;
}

const states: FloatingComposerState[] = [];

const SHOWN: FloatingComposerState = { visible: true };

function Harness({
  initialState = SHOWN,
  transcript,
}: {
  initialState?: FloatingComposerState;
  transcript?: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<FloatingComposerState>(initialState);
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      ref={setTarget}
      data-testid="pane"
      style={{ position: "fixed", ...PANE }}
      className="bg-token-main-surface-primary"
    >
      <FloatingComposer
        target={target}
        control={{
          state,
          attention: "none",
          onStateChange: (patch) =>
            setState((current) => {
              const next = { ...current, ...patch };
              states.push(next);
              return next;
            }),
        }}
        title="Plan the release"
        transcript={transcript}
        expanded={expanded}
        onExpandedChange={setExpanded}
      >
        <ComposerContextRailSlot visible>
          <ComposerContextRail>
            <span className="px-2 text-sm">Work locally</span>
          </ComposerContextRail>
        </ComposerContextRailSlot>
        <div className="flex h-11 items-center px-3">
          <div
            data-codex-composer="true"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-label="Prompt"
            className="min-w-0 flex-1 outline-none"
          />
        </div>
      </FloatingComposer>
    </div>
  );
}

function renderHarness(props: Parameters<typeof Harness>[0] = {}) {
  return renderWithAppMaitai(
    <NodexTooltipProvider>
      <Harness {...props} />
    </NodexTooltipProvider>,
  );
}

/** Top docks rest below the pane's toolbar strip. */
function paneToolbarHeight() {
  return (
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--height-toolbar-pane"),
    ) || 0
  );
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

function frameElement(): HTMLElement {
  const frame = document.querySelector<HTMLElement>("[data-floating-composer-frame]");
  if (!frame) throw new Error("Expected the floating composer frame");
  return frame;
}

function paneRect(element: Element) {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left - PANE.left,
    top: rect.top - PANE.top,
    right: PANE.left + PANE.width - rect.right,
    bottom: PANE.top + PANE.height - rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

/** Presses at `from`, moves in steps through `to`, then releases there. */
async function dragPointer(
  element: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const pointer = { isPrimary: true, pointerId: 1, pointerType: "mouse" };
  await act(async () => {
    fireEvent.pointerDown(element, {
      ...pointer,
      button: 0,
      buttons: 1,
      clientX: from.x,
      clientY: from.y,
    });
    await nextFrame();
  });
  try {
    for (let step = 1; step <= 8; step += 1) {
      await act(async () => {
        fireEvent.pointerMove(document, {
          ...pointer,
          buttons: 1,
          clientX: from.x + ((to.x - from.x) * step) / 8,
          clientY: from.y + ((to.y - from.y) * step) / 8,
        });
        await nextFrame();
      });
    }
  } finally {
    await act(async () => {
      fireEvent.pointerUp(document, { ...pointer, button: 0, clientX: to.x, clientY: to.y });
      await nextFrame();
    });
  }
}

function headerDragPoint() {
  const slot = document.querySelector("[data-floating-composer-header-slot]");
  if (!slot) throw new Error("Expected the header row");
  const rect = slot.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

describe("FloatingComposer", () => {
  beforeEach(async () => {
    states.length = 0;
    clearPersistedAtomStoreForTests();
    await page.viewport(1100, 780);
  });

  afterEach(() => {
    clearPersistedAtomStoreForTests();
  });

  test("reveals its header for the prompt, minimizes to a corner bubble, and restores into the prompt", async () => {
    const view = renderHarness();
    await waitFor(() => expect(frameElement().dataset.floatingComposerChrome).toBe("hidden"));
    // The compact composer rests at the bottom centre, its surface 16px above the pane edge.
    await waitFor(() => expect(paneRect(frameElement()).bottom).toBeCloseTo(10, 0));

    await act(async () => {
      await userEvent.click(view.getByRole("textbox", { name: "Prompt" }));
    });
    await waitFor(() => expect(frameElement().dataset.floatingComposerChrome).toBe("revealed"));

    await act(async () => {
      await userEvent.click(view.getByRole("button", { name: "Minimize composer" }));
    });
    const bubble = await view.findByRole("button", { name: "Restore composer" });
    expect(states.at(-1)).toMatchObject({ visible: false });
    await waitFor(() => {
      const rect = paneRect(bubble);
      expect(rect.right).toBeCloseTo(16, 0);
      expect(rect.bottom).toBeCloseTo(16, 0);
    });

    await act(async () => {
      await userEvent.click(bubble);
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(view.getByRole("textbox", { name: "Prompt" })),
    );
    expect(states.at(-1)).toMatchObject({ visible: true });
  });

  test("minimizes from the move handle's menu", async () => {
    const view = renderHarness();
    await act(async () => {
      await userEvent.click(view.getByRole("textbox", { name: "Prompt" }));
    });
    await act(async () => {
      await userEvent.click(view.getByRole("button", { name: "Move composer" }));
    });
    // The menu is portaled; its clicks must reach the item rather than the handle.
    const item = await view.findByRole("menuitem", { name: "Minimize composer" });
    await act(async () => {
      await userEvent.click(item);
    });
    expect(await view.findByRole("button", { name: "Restore composer" })).toBeTruthy();
    expect(states.at(-1)).toMatchObject({ visible: false });
  });

  test("settles a dragged composer into the nearest dock and minimizes into a corner", async () => {
    const view = renderHarness();
    await act(async () => {
      await userEvent.click(view.getByRole("textbox", { name: "Prompt" }));
    });
    await waitFor(() => expect(frameElement().dataset.floatingComposerChrome).toBe("revealed"));

    const start = headerDragPoint();
    await dragPointer(frameElement(), start, { x: PANE.left + 200, y: PANE.top + 60 });
    await waitFor(() => expect(states.at(-1)).toMatchObject({ dock: "top-left" }));
    expect(paneToolbarHeight()).toBeGreaterThan(0);
    await waitFor(() => {
      const rect = paneRect(frameElement());
      expect(rect.left).toBeCloseTo(10, 0);
      expect(rect.top).toBeCloseTo(paneToolbarHeight() + 10, 0);
    });
    expect((await storedPreference())?.dock).toBe("top-left");

    // Pressing the pointer into the bottom-left corner minimizes there; the frame keeps its dock.
    await dragPointer(frameElement(), headerDragPoint(), {
      x: PANE.left + 40,
      y: PANE.top + PANE.height - 20,
    });
    const bubble = await view.findByRole("button", { name: "Restore composer" });
    expect(states.at(-1)).toMatchObject({
      visible: false,
      dock: "top-left",
      minimizedDock: "bottom-left",
    });
    await waitFor(() => {
      const rect = paneRect(bubble);
      expect(rect.left).toBeCloseTo(16, 0);
      expect(rect.bottom).toBeCloseTo(16, 0);
    });
  });

  test("keeps a width resized from either edge", async () => {
    const view = renderHarness();
    await waitFor(() => expect(paneRect(frameElement()).width).toBe(572));
    const [, rightEdge] = view.getAllByRole("separator", { name: "Resize composer width" });
    if (!rightEdge) throw new Error("Expected the right resize edge");
    const edge = rightEdge.getBoundingClientRect();
    const from = { x: edge.left + edge.width / 2, y: edge.top + edge.height / 2 };

    await dragPointer(rightEdge, from, { x: from.x + 100, y: from.y });

    await waitFor(() => expect(paneRect(frameElement()).width).toBeCloseTo(672, 0));
    // The frame glides back to the centre once released.
    await waitFor(() => {
      const rect = paneRect(frameElement());
      expect(rect.left).toBeCloseTo(rect.right, 0);
    });
    await waitFor(async () => expect((await storedPreference())?.width).toBe(660));
  });

  test("expands into its conversation from the header and collapses on Escape", async () => {
    const view = renderHarness({ transcript: <p>Shipped the release notes.</p> });
    await act(async () => {
      await userEvent.click(view.getByRole("textbox", { name: "Prompt" }));
    });
    await waitFor(() => expect(frameElement().dataset.floatingComposerChrome).toBe("revealed"));

    // The context rail is portaled into the header; a click on it still toggles the presentation.
    await act(async () => {
      await userEvent.click(view.getByText("Work locally"));
    });
    await waitFor(() =>
      expect(frameElement().dataset.floatingComposerPresentation).toBe("expanded"),
    );
    expect(view.getByText("Shipped the release notes.")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Collapse composer" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(view.getByRole("separator", { name: "Resize composer height" })).toBeTruthy();
    await waitFor(() =>
      expect(paneRect(frameElement()).height).toBeCloseTo(
        Math.min(640, PANE.height - paneToolbarHeight() - 32),
        0,
      ),
    );

    await act(async () => {
      await userEvent.click(view.getByRole("textbox", { name: "Prompt" }));
      await userEvent.keyboard("{Escape}");
    });
    await waitFor(() =>
      expect(frameElement().dataset.floatingComposerPresentation).toBe("compact"),
    );
    expect(view.queryByText("Shipped the release notes.")).toBeNull();
  });
});
