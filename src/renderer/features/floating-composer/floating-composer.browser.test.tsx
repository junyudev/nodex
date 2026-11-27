import "../../globals.css";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithAppMaitai } from "@/test/app-maitai";
import {
  clearPersistedAtomStoreForTests,
  getPersistedAtomTransport,
} from "@/lib/persisted-atom-store";
import {
  ComposerContextRail,
  ComposerContextRailSlot,
} from "@/features/local-conversation/view/composer-context-rail";
import {
  RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_PX,
  RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_VAR,
} from "@/lib/right-panel-composer-overlay-reserve";
import {
  FloatingComposer,
  type FloatingComposerMenuItem,
  type FloatingComposerState,
} from "./floating-composer";

const PANE = { left: 40, top: 30, width: 1000, height: 700 };
const PREFERENCE_KEY = "nodex:floating-composer:v1";

async function storedPreference() {
  const { values } = await getPersistedAtomTransport().readSnapshot();
  return values[PREFERENCE_KEY] as { width?: number; dock?: string } | undefined;
}

const states: FloatingComposerState[] = [];

const SHOWN: FloatingComposerState = { visible: true };

function Harness({
  initialState = SHOWN,
  transcript,
  menuItems,
  groupWidth,
  anchorToGroup = false,
}: {
  initialState?: FloatingComposerState;
  transcript?: ReactNode;
  menuItems?: readonly FloatingComposerMenuItem[];
  groupWidth?: number;
  anchorToGroup?: boolean;
}) {
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const [group, setGroup] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<FloatingComposerState>(initialState);
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      ref={setPane}
      data-testid="pane"
      style={{ position: "fixed", ...PANE }}
      className="bg-token-main-surface-primary"
    >
      {groupWidth === undefined ? null : (
        <div
          ref={setGroup}
          data-testid="right-group"
          style={{ position: "absolute", inset: "0 0 0 auto", width: groupWidth }}
        />
      )}
      <FloatingComposer
        target={(anchorToGroup ? group : null) ?? pane}
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
        menuItems={menuItems}
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

/** Presses at `from`, moves in steps through `to`, then releases (or loses the pointer) there. */
async function dragPointer(
  element: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
  end: "release" | "cancel" = "release",
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
      const release = { ...pointer, button: 0, clientX: to.x, clientY: to.y };
      if (end === "cancel") fireEvent.pointerCancel(document, release);
      else fireEvent.pointerUp(document, release);
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

  test("retargets and resizes the body portal while keeping the prompt and conversation mounted", async () => {
    const renderComposer = (groupWidth: number, anchorToGroup: boolean) => (
      <NodexTooltipProvider>
        <Harness
          groupWidth={groupWidth}
          anchorToGroup={anchorToGroup}
          transcript={<p>Shipped the release notes.</p>}
        />
      </NodexTooltipProvider>
    );
    const view = renderWithAppMaitai(renderComposer(500, false));
    const prompt = await view.findByRole("textbox", { name: "Prompt" });
    const pane = view.getByTestId("pane");
    const group = view.getByTestId("right-group");
    const portal = view.getByTestId("right-panel-composer-overlay-host");
    expect(portal.parentElement).toBe(document.body);
    const reserve = `${RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_PX}px`;
    expect(pane.style.getPropertyValue(RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_VAR)).toBe(reserve);

    await act(async () => {
      await userEvent.fill(prompt, "Keep this draft");
    });
    await act(async () => {
      await userEvent.click(view.getByText("Work locally"));
    });
    const transcript = await view.findByText("Shipped the release notes.");

    view.rerender(renderComposer(500, true));
    const expectPortalOver = (target: HTMLElement) => {
      const { left, top, width, height } = target.getBoundingClientRect();
      expect(portal.getBoundingClientRect()).toMatchObject({ left, top, width, height });
    };
    expectPortalOver(group);
    expect(pane.style.getPropertyValue(RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_VAR)).toBe("");
    expect(group.style.getPropertyValue(RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_VAR)).toBe(reserve);

    view.rerender(renderComposer(420, true));
    await waitFor(() => expectPortalOver(group));
    expect(view.getByRole("textbox", { name: "Prompt" })).toBe(prompt);
    expect(prompt.textContent).toBe("Keep this draft");
    expect(view.getByText("Shipped the release notes.")).toBe(transcript);

    view.rerender(renderComposer(420, false));
    expectPortalOver(pane);
    expect(group.style.getPropertyValue(RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_VAR)).toBe("");
    expect(pane.style.getPropertyValue(RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_VAR)).toBe(reserve);
    expect(view.getByText("Shipped the release notes.")).toBe(transcript);
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

  test("minimizes into its corner and restores the same conversation where it was read", async () => {
    const openFullView = vi.fn();
    const view = renderHarness({
      menuItems: [{ id: "full-view", label: "Open in full view", onSelect: openFullView }],
      transcript: (
        <div data-testid="conversation-log" className="min-h-0 flex-1 overflow-y-auto">
          <p style={{ height: 2000 }}>Shipped the release notes.</p>
        </div>
      ),
    });
    await act(async () => {
      await userEvent.click(view.getByRole("textbox", { name: "Prompt" }));
    });
    await act(async () => {
      await userEvent.click(view.getByText("Work locally"));
    });
    const log = await view.findByTestId("conversation-log");
    // Read once the expanded surface has settled at its height.
    await waitFor(() =>
      expect(paneRect(frameElement()).height).toBeCloseTo(
        Math.min(640, PANE.height - paneToolbarHeight() - 32),
        0,
      ),
    );
    await act(async () => {
      log.scrollTop = 300;
      await nextFrame();
    });
    const readTo = log.scrollTop;
    expect(readTo).toBeGreaterThan(0);
    await act(async () => {
      await userEvent.click(view.getByRole("button", { name: "Move composer" }));
    });
    // The portaled placement item still receives its click through the drag handle.
    const placement = await view.findByRole("menuitem", { name: "Open in full view" });
    await act(async () => {
      await userEvent.click(placement);
    });
    expect(openFullView).toHaveBeenCalledOnce();

    await act(async () => {
      await userEvent.click(view.getByRole("button", { name: "Minimize composer" }));
    });
    const restore = await view.findByRole("button", { name: "Restore composer" });
    expect(states.at(-1)).toMatchObject({ visible: false });
    // The surface collapses onto its bubble; the conversation stays mounted, out of reach.
    // The surface glides into the corner as it collapses.
    await waitFor(() => {
      const rect = paneRect(restore);
      expect(rect.right).toBeCloseTo(16, 0);
      expect(rect.bottom).toBeCloseTo(16, 0);
    });
    expect(log.isConnected).toBe(true);
    expect(log.closest("[inert]")).not.toBeNull();
    const logRect = log.getBoundingClientRect();
    const covered = document.elementFromPoint(
      logRect.left + logRect.width / 2,
      logRect.top + logRect.height / 2,
    );
    expect(frameElement().contains(covered)).toBe(false);

    // Minimizing keeps the presentation: the same conversation returns, still where it was read.
    await act(async () => {
      await userEvent.click(restore);
    });
    await waitFor(() => expect(log.closest("[inert]")).toBeNull());
    expect(view.getByTestId("conversation-log")).toBe(log);
    expect(log.scrollTop).toBe(readTo);
    expect(
      view.getByRole("button", { name: "Collapse composer" }).getAttribute("aria-expanded"),
    ).toBe("true");
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
    await waitFor(async () => expect((await storedPreference())?.dock).toBe("top-left"));

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

  test("returns home without minimizing when the platform cancels a drag over the minimize corner", async () => {
    const view = renderHarness();
    await act(async () => {
      await userEvent.click(view.getByRole("textbox", { name: "Prompt" }));
    });
    await waitFor(() => expect(frameElement().dataset.floatingComposerChrome).toBe("revealed"));

    await dragPointer(
      frameElement(),
      headerDragPoint(),
      { x: PANE.left + 40, y: PANE.top + PANE.height - 20 },
      "cancel",
    );
    // Motion reports a cancelled drag's end after its next render.
    await act(async () => {
      await nextFrame();
      await nextFrame();
    });

    expect(view.queryByRole("button", { name: "Restore composer" })).toBeNull();
    expect(states.some((state) => state.visible === false)).toBe(false);
    // The frame glides back to its centred dock.
    await waitFor(() => {
      const rect = paneRect(frameElement());
      expect(rect.left).toBeCloseTo(rect.right, 0);
    });
  });

  test("drags its bubble to another corner, where it stays", async () => {
    const view = renderHarness({ initialState: { visible: false } });
    const bubble = await view.findByRole("button", { name: "Restore composer" });
    await waitFor(() => expect(paneRect(bubble).right).toBeCloseTo(16, 0));
    const rect = bubble.getBoundingClientRect();
    await dragPointer(
      bubble,
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      { x: PANE.left + 60, y: PANE.top + 80 },
    );
    await waitFor(() => expect(states.at(-1)).toMatchObject({ minimizedDock: "top-left" }));
    await waitFor(() => {
      const resting = paneRect(bubble);
      expect(resting.left).toBeCloseTo(16, 0);
      expect(resting.top).toBeCloseTo(paneToolbarHeight() + 16, 0);
    });
    expect(states.at(-1)).toMatchObject({ visible: false });
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
