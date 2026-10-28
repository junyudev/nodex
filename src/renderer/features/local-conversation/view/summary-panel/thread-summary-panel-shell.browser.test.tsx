import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { beforeEach, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
beforeEach(async () => {
  await page.viewport(1400, 1000);
});
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import { REDUCED_MOTION_STORAGE_KEY } from "@/lib/reduced-motion";
import { ReducedMotionProvider } from "@/lib/use-reduced-motion";
import {
  ThreadPinnedSummaryPanelShell,
  ThreadSummaryPanelPopoverShell,
} from "./thread-summary-panel-shell";
import "../../../../globals.css";

const frames = async (count = 2) => {
  for (let index = 0; index < count; index += 1)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

function renderShell(children: ReactNode, reducedMotion = false) {
  localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, reducedMotion ? "on" : "off");
  const store = createMaitaiStore();
  function Providers({ children: content }: { children: ReactNode }) {
    return (
      <MaitaiProvider store={store}>
        <ReducedMotionProvider>
          <NodexTooltipProvider>{content}</NodexTooltipProvider>
        </ReducedMotionProvider>
      </MaitaiProvider>
    );
  }
  const view = render(<Providers>{children}</Providers>);
  return {
    ...view,
    update: (next: ReactNode) => view.rerender(<Providers>{next}</Providers>),
    dispose: () => {
      view.unmount();
      disposeMaitaiStore(store);
    },
  };
}

function Pinned({ open }: { open: boolean }) {
  return (
    <div data-testid="pane" style={{ position: "relative", width: 900, height: 500 }}>
      <ThreadPinnedSummaryPanelShell open={open}>
        <button style={{ width: "100%", height: 80 }}>Summary action</button>
      </ThreadPinnedSummaryPanelShell>
    </div>
  );
}

function Popover({ paneWidth = 600, zoom = 1 }: { paneWidth?: number; zoom?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-workbench-shell
      style={
        {
          position: "relative",
          width: 1000,
          height: 650,
          zoom,
          "--codex-window-zoom": zoom,
        } as import("react").CSSProperties
      }
    >
      <header
        data-workbench-titlebar
        style={{ height: 48, display: "flex", justifyContent: "flex-end", paddingRight: 200 }}
      >
        <ThreadSummaryPanelPopoverShell open={open} onOpenChange={setOpen}>
          <div style={{ width: "100%", height: 200, background: "white" }}>
            <button>Summary action</button>
          </div>
        </ThreadSummaryPanelPopoverShell>
      </header>
      <section
        data-app-shell-main-content-layout="thread-edge-scroll"
        style={{ position: "absolute", left: 100, top: 48, width: paneWidth, height: 550 }}
      />
      <div data-panel-tab-row="right:test" style={{ position: "absolute", right: 0, top: 0 }}>
        <button>Review tab</button>
      </div>
      <button style={{ position: "absolute", bottom: 0 }}>Outside action</button>
    </div>
  );
}

function popupElement() {
  const content = document.querySelector('[data-thread-summary-panel-mode="popover"]');
  return content?.closest<HTMLElement>('[data-slot="popover-content"]') ?? null;
}

test("pinned summary slides without changing its width and becomes inert while closing", async () => {
  const view = renderShell(<Pinned open />);
  try {
    await act(async () => {
      await frames(3);
    });
    const action = view.getByRole("button", { name: "Summary action" });
    const pane = view.getByTestId("pane");
    expect(action.getBoundingClientRect().width).toBeCloseTo(300, 1);
    expect(pane.getBoundingClientRect().right - action.getBoundingClientRect().right).toBeCloseTo(
      8,
      1,
    );
    const start = action.getBoundingClientRect().left;
    await act(async () => {
      view.update(<Pinned open={false} />);
    });
    const shell = view.container.querySelector<HTMLElement>(
      '[data-thread-summary-panel-mode="pinned"]',
    )!;
    expect(shell.inert).toBe(true);
    const samples: number[] = [];
    await act(async () => {
      for (let index = 0; index < 6; index += 1) {
        await frames(1);
        const bounds = action.getBoundingClientRect();
        expect(bounds.width).toBeCloseTo(300, 1);
        samples.push(bounds.left - start);
      }
    });
    expect(samples.some((x) => x > 0 && x < 300)).toBe(true);
    await act(async () => {
      view.update(<Pinned open />);
    });
    expect(shell.inert).toBe(false);
    await waitFor(() => expect(action.getBoundingClientRect().left).toBeCloseTo(start, 0));
  } finally {
    view.dispose();
  }
});

test.each([1, 1.25])("summary popover follows the chat edge and focus at zoom %s", async (zoom) => {
  const view = renderShell(<Popover zoom={zoom} />);
  try {
    const trigger = view.getByRole("button", { name: "Toggle summary" });
    await act(async () => {
      fireEvent.click(trigger);
    });
    const pane = view.container.querySelector<HTMLElement>("[data-app-shell-main-content-layout]")!;
    await waitFor(() => expect(popupElement()).not.toBeNull());
    await waitFor(() =>
      expect(
        pane.getBoundingClientRect().right - popupElement()!.getBoundingClientRect().right,
      ).toBeCloseTo(8 * zoom, 0),
    );
    expect(popupElement()!.getBoundingClientRect().top).toBeCloseTo(
      pane.getBoundingClientRect().top + 8 * zoom,
      0,
    );
    expect(popupElement()!.getBoundingClientRect().width).toBeCloseTo(300 * zoom, 0);
    // The popup is already in place while its content slides in; focus follows once it opens.
    await waitFor(() =>
      expect(document.activeElement).toBe(view.getByRole("button", { name: "Summary action" })),
    );
    await act(async () => {
      await userEvent.click(view.getByRole("button", { name: "Review tab" }));
      await frames(2);
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      view.update(<Popover paneWidth={500} zoom={zoom} />);
      window.dispatchEvent(new Event("resize"));
      await frames(5);
    });
    await waitFor(() =>
      expect(
        pane.getBoundingClientRect().right - popupElement()!.getBoundingClientRect().right,
      ).toBeCloseTo(8 * zoom, 0),
    );
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await frames(25);
    });
    await waitFor(() => expect(popupElement()).toBeNull());
    expect(document.activeElement).toBe(trigger);
    await act(async () => {
      fireEvent.click(trigger);
    });
    const outside = view.getByRole("button", { name: "Outside action" });
    await act(async () => {
      await userEvent.click(outside);
      await frames(2);
    });
    await waitFor(() => expect(popupElement()).toBeNull());
    expect(document.activeElement).toBe(outside);
    await act(async () => {
      fireEvent.click(trigger);
    });
    await waitFor(() => expect(popupElement()).not.toBeNull());
    await act(async () => {
      await userEvent.click(pane);
      await frames(2);
    });
    await waitFor(() => expect(popupElement()).toBeNull());
    expect(document.activeElement).not.toBe(trigger);
  } finally {
    view.dispose();
  }
});

test("summary popover slides in and back out inside a still frame that the chat pane clips exactly", async () => {
  const view = renderShell(<Popover />);
  try {
    const trigger = view.getByRole("button", { name: "Toggle summary" });
    const pane = document
      .querySelector("[data-app-shell-main-content-layout]")!
      .getBoundingClientRect();
    const sampleSlide = async () => {
      const samples: { frame: DOMRect; slide: number; clipRightEdge: number | null }[] = [];
      await act(async () => {
        for (let index = 0; index < 14; index += 1) {
          await frames(1);
          const popup = popupElement();
          const frame = popup?.parentElement;
          if (!popup || !frame) continue;
          const rect = frame.getBoundingClientRect();
          const inset = /^inset\((\S+)px (\S+)px/.exec(getComputedStyle(frame).clipPath);
          expect(popup.getBoundingClientRect().width).toBeCloseTo(300, 0);
          samples.push({
            frame: rect,
            slide: new DOMMatrixReadOnly(getComputedStyle(popup).transform).m41,
            clipRightEdge: inset ? rect.right - Number(inset[2]) : null,
          });
        }
      });
      const sliding = samples.filter(({ slide }) => slide > 1 && slide < 299);
      expect(sliding.length).toBeGreaterThan(1);
      for (const sample of sliding) {
        // The frame never moves, and its clip ends exactly at the pane's edge.
        expect(sample.frame.right).toBeCloseTo(sliding[0]!.frame.right, 0);
        expect(sample.clipRightEdge).not.toBeNull();
        expect(sample.clipRightEdge!).toBeCloseTo(pane.right, 0);
      }
    };

    await act(async () => {
      fireEvent.click(trigger);
    });
    await sampleSlide();
    await act(async () => {
      await frames(25);
    });
    await waitFor(() =>
      expect(getComputedStyle(popupElement()!.parentElement!).clipPath).toBe("none"),
    );

    // Closing plays the slide back out before the popover lets the popup go.
    await act(async () => {
      fireEvent.click(trigger);
    });
    await sampleSlide();
    await waitFor(() => expect(popupElement()).toBeNull());
  } finally {
    view.dispose();
  }
});
