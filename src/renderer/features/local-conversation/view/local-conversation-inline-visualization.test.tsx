import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  createInlineVisualizationRuntime,
  InlineVisualizationRuntime,
  InlineVisualizationSnapshot,
} from "../../../lib/inline-visualization/inline-visualization-runtime";
import { ConversationVisualizationContext } from "./inline-visualization-context";
import { LocalConversationInlineVisualization } from "./local-conversation-inline-visualization";
import type { InlineVisualizationMode } from "../../../lib/inline-visualization/inline-visualization-presentation";
import { applyLocalConversationSearchHighlights } from "./local-conversation-thread-search-dom-marks";

type RuntimeInput = Parameters<typeof createInlineVisualizationRuntime>[0];
const boundary = vi.hoisted(() => ({
  create: vi.fn<(input: RuntimeInput) => InlineVisualizationRuntime>(),
  queryPhase: "ready" as "ready" | "loading" | "error",
}));
vi.mock("../../../lib/inline-visualization/inline-visualization-runtime", () => ({
  createInlineVisualizationRuntime: boundary.create,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({
    data:
      boundary.queryPhase === "ready"
        ? { contents: "<p>Widget</p>", path: "/owned/widget.html" }
        : undefined,
    isError: boundary.queryPhase === "error",
    isSuccess: boundary.queryPhase === "ready",
    refetch: vi.fn(async () => undefined),
  }),
}));

const instances: Array<{ input: RuntimeInput; runtime: InlineVisualizationRuntime }> = [];
beforeEach(() => {
  instances.length = 0;
  boundary.queryPhase = "ready";
  boundary.create.mockReset().mockImplementation((input) => {
    const element = document.createElement("div");
    const widgetControl = document.createElement("button");
    widgetControl.textContent = "Widget control";
    element.append(widgetControl);
    const listeners = new Set<() => void>();
    let snapshot: InlineVisualizationSnapshot = {
      status: "ready",
      height: 150,
      fullscreenHeight: null,
      displayMode: "inline",
      error: null,
    };
    const runtime: InlineVisualizationRuntime = {
      element,
      getSnapshot: () => snapshot,
      captureImage: vi.fn(async () => new Uint8Array()),
      copyAsImage: vi.fn(async () => {}),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose: vi.fn(async () => {
        element.remove();
      }),
      setDisplayMode: (requested) => {
        const mode = requested === "fullscreen" && !input.canExpand?.() ? "inline" : requested;
        if (mode === snapshot.displayMode) return mode;
        snapshot = { ...snapshot, displayMode: mode };
        listeners.forEach((listener) => listener());
        return mode;
      },
    };
    instances.push({ input, runtime });
    return runtime;
  });
});

function Harness({
  mode,
  live,
  file = "widget.html",
  sourceThreadId,
  cacheKey,
}: {
  mode: InlineVisualizationMode;
  live: boolean;
  file?: string;
  sourceThreadId?: string;
  cacheKey?: string;
}) {
  return (
    <ConversationVisualizationContext.Provider
      value={{
        hostId: "local",
        threadId: "visible-thread",
        turnId: "turn",
        live,
        readChangedFilePaths: () => [],
      }}
    >
      <LocalConversationInlineVisualization
        file={file}
        mode={mode}
        sourceThreadId={sourceThreadId}
        cacheKey={cacheKey}
      />
    </ConversationVisualizationContext.Provider>
  );
}

function installPopoverFor(frame: HTMLElement) {
  let open = false;
  const matches = frame.matches.bind(frame);
  frame.showPopover = () => {
    open = true;
    frame.style.display = "flex";
  };
  frame.hidePopover = () => {
    open = false;
    frame.style.display = "";
  };
  Object.defineProperty(frame, "matches", {
    value: (selector: string) => (selector === ":popover-open" ? open : matches(selector)),
  });
}

describe("inline visualization preview presentation", () => {
  test("state belongs to the displayed Thread and raw file path across source/cache/streaming changes", async () => {
    const view = render(
      <Harness
        mode="narrow"
        live
        file="/var/widget.html"
        sourceThreadId="source-a"
        cacheKey="revision-a"
      />,
    );
    await view.findByRole("button", { name: "Widget control" });
    expect(instances[0]?.input.widgetState?.identity).toEqual({
      hostId: "local",
      threadId: "visible-thread",
      path: "/var/widget.html",
    });
    view.rerender(
      <Harness
        mode="narrow"
        live={false}
        file="/var/widget.html"
        sourceThreadId="source-b"
        cacheKey="revision-b"
      />,
    );
    await waitFor(() => expect(instances).toHaveLength(2));
    expect(instances[1]?.input.widgetState?.identity).toEqual(
      instances[0]?.input.widgetState?.identity,
    );
    expect(instances[0]?.runtime.dispose).toHaveBeenCalledOnce();
    expect(instances[1]?.input.scopeId).not.toBe(instances[0]?.input.scopeId);
  });
  test.each([
    ["narrow", false, false],
    ["narrow", true, false],
    ["wide", true, false],
    ["wide", false, true],
  ] as const)(
    "admits the preview action for mode %s and live %s: %s",
    async (mode, live, admitted) => {
      const view = render(<Harness mode={mode} live={live} />);
      await view.findByRole("button", { name: "Widget control" });
      expect(view.queryByRole("button", { name: "Open fullscreen" }) !== null).toBe(admitted);
      expect(instances[0]?.input.canExpand?.()).toBe(admitted);
    },
  );

  test("copies the same guest image through inline and fullscreen actions", async () => {
    const view = render(<Harness mode="wide" live={false} />);
    const copy = await view.findByRole("button", { name: "Copy as image" });
    await act(async () => {
      fireEvent.click(copy);
      await Promise.resolve();
    });
    expect(instances[0]?.runtime.copyAsImage).toHaveBeenCalledOnce();
    const frame = view.container.querySelector<HTMLElement>("[data-inline-visualization] > div");
    if (!frame) throw new Error("Expected the retained presentation frame");
    installPopoverFor(frame);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Open fullscreen" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Copy as image" }));
      await Promise.resolve();
    });
    expect(instances[0]?.runtime.copyAsImage).toHaveBeenCalledTimes(2);
  });

  test("lifecycle changes update preview eligibility without replacing the guest", async () => {
    const view = render(<Harness mode="wide" live />);
    const guest = await view.findByRole("button", { name: "Widget control" });
    expect(view.queryByRole("button", { name: "Open fullscreen" })).toBeNull();
    view.rerender(<Harness mode="wide" live={false} />);
    await view.findByRole("button", { name: "Open fullscreen" });
    expect(view.getByRole("button", { name: "Widget control" })).toBe(guest);
    expect(boundary.create).toHaveBeenCalledOnce();
    expect(instances[0]?.input.canExpand?.()).toBe(true);
  });

  test.each(["close-button", "backdrop"] as const)(
    "preview closes through %s while retaining the same guest",
    async (dismissal) => {
      const view = render(<Harness mode="wide" live={false} />);
      const guest = await view.findByRole("button", { name: "Widget control" });
      const open = view.getByRole("button", { name: "Open fullscreen" });
      const frame = view.container.querySelector<HTMLElement>("[data-inline-visualization] > div");
      if (!frame) throw new Error("Expected the retained presentation frame");
      installPopoverFor(frame);
      await act(async () => {
        fireEvent.click(open);
      });
      await view.findByRole("dialog", { name: "Interactive response" });
      expect(view.queryByRole("button", { name: "Open fullscreen" })).toBeNull();
      expect(view.getByRole("button", { name: "Widget control" })).toBe(guest);
      const guestPointer = new Event("pointerdown", { bubbles: true, cancelable: true });
      await act(async () => {
        fireEvent(guest, guestPointer);
      });
      expect(guestPointer.defaultPrevented).toBe(false);
      expect(view.getByRole("dialog", { name: "Interactive response" })).toBe(frame);
      const backdropPointer = new Event("pointerdown", { bubbles: true, cancelable: true });
      await act(async () => {
        if (dismissal === "backdrop") fireEvent(frame, backdropPointer);
        else fireEvent.click(view.getByRole("button", { name: "Exit fullscreen" }));
      });
      expect(backdropPointer.defaultPrevented).toBe(dismissal === "backdrop");
      await waitFor(() =>
        expect(view.queryByRole("dialog", { name: "Interactive response" })).toBeNull(),
      );
      expect(view.getByRole("button", { name: "Widget control" })).toBe(guest);
      expect(boundary.create).toHaveBeenCalledOnce();
    },
  );

  test("Find highlights assistant text without including widget failure controls", async () => {
    boundary.queryPhase = "error";
    const view = render(
      <section data-content-search-unit-key="assistant-unit">
        <p>Retry the calculation.</p>
        <Harness mode="wide" live={false} />
      </section>,
    );
    const retry = await view.findByRole("button", { name: "Retry" });
    await act(async () => {
      applyLocalConversationSearchHighlights({
        root: view.container,
        query: "Retry",
        target: { turnKey: "turn", unitKey: "assistant-unit", occurrenceIndex: 0 },
      });
    });
    expect(view.container.querySelectorAll("mark")).toHaveLength(1);
    expect(view.container.querySelector("p > mark")?.textContent).toBe("Retry");
    expect(retry.querySelector("mark")).toBeNull();
    expect(retry.parentElement?.querySelector("mark")).toBeNull();
  });
});
