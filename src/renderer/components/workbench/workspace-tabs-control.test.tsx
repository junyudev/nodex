import { describe, expect, test, vi } from "vite-plus/test";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { act, useState } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { render, settleAsyncRender } from "@/test/dom";
import { WorkspaceTabsControl, type WorkspaceTabsControlProps } from "./workspace-tabs-control";

const tabs: WorkspaceTabsControlProps["tabs"] = [
  { id: "page", title: "Research", iconElement: <span aria-label="Page icon">P</span> },
  { id: "file", title: "README.md" },
];

function renderControl(props: Partial<WorkspaceTabsControlProps> = {}) {
  return render(
    <NodexTooltipProvider>
      <WorkspaceTabsControl
        mode="chat"
        tabs={tabs}
        activeTabId="file"
        onToggle={() => undefined}
        onSelect={() => undefined}
        {...props}
      />
    </NodexTooltipProvider>,
  );
}

async function hover(trigger: HTMLElement) {
  await act(async () => {
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.mouseEnter(trigger);
    await settleAsyncRender();
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await settleAsyncRender();
  });
}

describe("WorkspaceTabsControl", () => {
  test("click restores the content pane without opening the chooser", async () => {
    const onToggle = vi.fn();
    const view = renderControl({ onToggle });
    const trigger = view.getByRole("button", { name: "Show tabs" });
    expect(trigger.getAttribute("aria-description")).toBe("2 open tabs");

    await click(trigger);

    expect(onToggle).toHaveBeenCalledExactlyOnceWith();
    expect(view.queryByRole("menu", { name: "Open tabs" })).toBeNull();
  });

  test("hover lists retained tabs without moving focus or changing presentation", async () => {
    const onToggle = vi.fn();
    const view = renderControl({ onToggle });
    const trigger = view.getByRole("button", { name: "Show tabs" });
    await act(async () => trigger.focus());

    await hover(trigger);

    const menu = await view.findByRole("menu", { name: "Open tabs" });
    expect(within(menu).getByRole("menuitem", { name: "Research" })).not.toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: "README.md" }).getAttribute("aria-current"),
    ).toBe("true");
    expect(within(menu).getByLabelText("Page icon")).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onToggle).not.toHaveBeenCalled();
  });

  test("click from the hovered chooser still restores content and dismisses the chooser", async () => {
    const onToggle = vi.fn();
    const view = renderControl({ onToggle });
    const trigger = view.getByRole("button", { name: "Show tabs" });
    await hover(trigger);
    await view.findByRole("menu", { name: "Open tabs" });

    await click(trigger);

    expect(onToggle).toHaveBeenCalledExactlyOnceWith();
    await waitFor(() => expect(view.queryByRole("menu", { name: "Open tabs" })).toBeNull());
  });

  test.each(["split", "full"] as const)(
    "chooser opens an existing tab in %s view",
    async (mode) => {
      const onSelect = vi.fn();
      const view = renderControl({ onSelect });
      await hover(view.getByRole("button", { name: "Show tabs" }));
      const menu = await view.findByRole("menu", { name: "Open tabs" });

      await click(
        within(menu).getByRole("menuitem", {
          name: mode === "full" ? "Open Research in full view" : "Research",
        }),
      );

      expect(onSelect).toHaveBeenCalledExactlyOnceWith("page", mode);
      await waitFor(() => expect(view.queryByRole("menu", { name: "Open tabs" })).toBeNull());
    },
  );

  test("hidden tabs retain their count through split and full presentation", async () => {
    function Presentation() {
      const [mode, setMode] = useState<WorkspaceTabsControlProps["mode"]>("chat");
      return (
        <NodexTooltipProvider>
          <WorkspaceTabsControl
            mode={mode}
            tabs={tabs}
            onToggle={() => setMode((current) => (current === "split" ? "chat" : "split"))}
            onSelect={(_id, next) => setMode(next)}
          />
          <button type="button" onClick={() => setMode("full")}>
            Enter full view
          </button>
        </NodexTooltipProvider>
      );
    }
    const view = render(<Presentation />);
    await click(view.getByRole("button", { name: "Show tabs" }));
    expect(view.getByRole("button", { name: "Hide tabs" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await click(view.getByRole("button", { name: "Hide tabs" }));
    expect(view.getByRole("button", { name: "Show tabs" }).getAttribute("aria-description")).toBe(
      "2 open tabs",
    );
    await click(view.getByRole("button", { name: "Enter full view" }));
    expect(view.getByRole("button", { name: "Enter split view" })).not.toBeNull();
    await click(view.getByRole("button", { name: "Enter split view" }));
    expect(view.getByRole("button", { name: "Hide tabs" })).not.toBeNull();
  });

  test("keyboard enters the chooser and Escape returns focus to its control", async () => {
    const view = renderControl();
    const trigger = view.getByRole("button", { name: "Show tabs" });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      await settleAsyncRender();
    });
    const menu = await view.findByRole("menu", { name: "Open tabs" });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Research" })),
    );
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "End" });
      await settleAsyncRender();
    });
    expect(document.activeElement).toBe(
      within(menu).getByRole("menuitem", { name: "Open README.md in full view" }),
    );
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await settleAsyncRender();
    });
    await waitFor(() => expect(view.queryByRole("menu", { name: "Open tabs" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  test("the chooser observes title changes and disables unavailable content", async () => {
    let title = "Initial title";
    const listeners = new Set<() => void>();
    const onSelect = vi.fn();
    const view = renderControl({
      onSelect,
      tabs: [
        {
          id: "live",
          title: "Fallback title",
          titleSource: {
            getSnapshot: () => title,
            subscribe: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
        },
        { id: "unavailable", title: "Unavailable", disabled: true },
      ],
    });
    await hover(view.getByRole("button", { name: "Show tabs" }));
    const menu = await view.findByRole("menu", { name: "Open tabs" });
    expect(within(menu).getByRole("menuitem", { name: "Initial title" })).not.toBeNull();
    await act(async () => {
      title = "Updated title";
      listeners.forEach((listener) => listener());
      await settleAsyncRender();
    });
    expect(within(menu).getByRole("menuitem", { name: "Updated title" })).not.toBeNull();
    await click(within(menu).getByRole("menuitem", { name: "Unavailable" }));
    expect(onSelect).not.toHaveBeenCalled();
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  test("an empty workspace can reveal its content chooser", async () => {
    const onToggle = vi.fn();
    const view = renderControl({ tabs: [], onToggle });
    await click(view.getByRole("button", { name: "New tab" }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith();
  });
});
