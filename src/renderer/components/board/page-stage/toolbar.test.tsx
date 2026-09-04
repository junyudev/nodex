import { describe, expect, test } from "vite-plus/test";
import { fireEvent, within } from "@testing-library/react";
import { act, useEffect } from "react";
import { NodexTooltipProvider, dismissNodexTooltips } from "@/components/ui/tooltip";
import { render, openNodexMenu } from "@/test/dom";
import { PageStageToolbar } from "./toolbar";

describe("page stage toolbar", () => {
  test("history and overflow actions survive capture-phase tooltip dismissal", async () => {
    let historyCalls = 0;
    let deleteCalls = 0;

    function ToolbarHarness() {
      useEffect(() => {
        const dismissOnPointerDown = () => {
          dismissNodexTooltips();
        };

        document.addEventListener("pointerdown", dismissOnPointerDown, true);
        return () => {
          document.removeEventListener("pointerdown", dismissOnPointerDown, true);
        };
      }, []);

      return (
        <NodexTooltipProvider>
          <PageStageToolbar
            saving={false}
            historyPanelActive={false}
            limitMainContentWidth={true}
            showRawContent={false}
            onCopyDeeplink={() => undefined}
            onDelete={() => {
              deleteCalls += 1;
            }}
            onToggleContentWidth={() => undefined}
            onToggleShowRawContent={() => undefined}
            onToggleHistoryPanel={() => {
              historyCalls += 1;
            }}
          />
        </NodexTooltipProvider>
      );
    }

    const view = render(<ToolbarHarness />);
    const historyButton = view.getByRole("button", { name: "History" });
    const pageActionsButton = view.getByRole("button", { name: "Page actions" });

    await act(async () => {
      fireEvent.pointerDown(historyButton);
      fireEvent.click(historyButton);
      fireEvent.pointerDown(pageActionsButton, { button: 0, ctrlKey: false });
      fireEvent.mouseDown(pageActionsButton, { button: 0, ctrlKey: false });
      fireEvent.click(pageActionsButton);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Delete" }));
      await Promise.resolve();
    });

    expect(historyCalls).toBe(1);
    expect(deleteCalls).toBe(1);
  });

  test("keeps direct controls concise and groups page actions in the trailing menu", async () => {
    let copyCalls = 0;
    const view = render(
      <NodexTooltipProvider>
        <PageStageToolbar
          saving={false}
          historyPanelActive={false}
          limitMainContentWidth={true}
          showRawContent={false}
          onCopyDeeplink={() => {
            copyCalls += 1;
          }}
          onDelete={() => undefined}
          onToggleContentWidth={() => undefined}
          onToggleShowRawContent={() => undefined}
        />
      </NodexTooltipProvider>,
    );

    const labels = view
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter(Boolean)
      .join(",");
    expect(labels).toBe("Show raw,Full width,History,Page actions");

    const trigger = view.getByRole("button", { name: "Page actions" });
    await openNodexMenu(trigger);

    expect(view.getByRole("menuitem", { name: "Copy deeplink" })).toBeTruthy();
    expect(view.getByRole("menuitem", { name: "Delete" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Copy deeplink" }));
      await Promise.resolve();
    });
    expect(copyCalls).toBe(1);
  });

  test("renders nested page ancestry as accessible navigation", async () => {
    const openedPages: Array<{ pageId: string; index: number }> = [];
    const view = render(
      <NodexTooltipProvider>
        <PageStageToolbar
          saving={false}
          historyPanelActive={false}
          limitMainContentWidth={true}
          showRawContent={false}
          onCopyDeeplink={() => undefined}
          onDelete={() => undefined}
          onToggleContentWidth={() => undefined}
          onToggleShowRawContent={() => undefined}
          breadcrumb={{
            ancestors: [
              { projectId: "alpha", pageId: "root", title: "Root page" },
              { projectId: "alpha", pageId: "child", title: "Child page" },
            ],
            currentTitle: "Nested page",
            onOpenAncestor: (ancestor, index) => {
              openedPages.push({ pageId: ancestor.pageId, index });
            },
          }}
        />
      </NodexTooltipProvider>,
    );

    const breadcrumb = view.getByRole("navigation", { name: "Page hierarchy" });
    expect(breadcrumb.querySelector('[aria-current="page"]')?.textContent).toBe("Nested page");

    await act(async () => {
      fireEvent.click(within(breadcrumb).getByRole("button", { name: "Child page" }));
      await Promise.resolve();
    });

    expect(openedPages).toEqual([{ pageId: "child", index: 1 }]);
  });

  test("keeps overflowed middle ancestors navigable", async () => {
    const openedPages: string[] = [];
    const view = render(
      <NodexTooltipProvider>
        <PageStageToolbar
          saving={false}
          historyPanelActive={false}
          limitMainContentWidth={true}
          showRawContent={false}
          onCopyDeeplink={() => undefined}
          onDelete={() => undefined}
          onToggleContentWidth={() => undefined}
          onToggleShowRawContent={() => undefined}
          breadcrumb={{
            ancestors: [
              { projectId: "alpha", pageId: "root", title: "Root" },
              { projectId: "alpha", pageId: "middle", title: "Middle" },
              { projectId: "alpha", pageId: "child", title: "Child" },
              { projectId: "alpha", pageId: "parent", title: "Parent" },
            ],
            currentTitle: "Nested",
            onOpenAncestor: (ancestor) => openedPages.push(ancestor.pageId),
          }}
        />
      </NodexTooltipProvider>,
    );

    await act(async () => {
      const trigger = view.getByRole("button", { name: "More ancestor pages" });
      fireEvent.pointerDown(trigger, {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Middle" }));
      await Promise.resolve();
    });

    expect(openedPages).toEqual(["middle"]);
  });
});
