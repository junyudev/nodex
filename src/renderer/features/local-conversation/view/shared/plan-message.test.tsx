import { beforeEach, describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { NodexTooltipProvider as TooltipProvider } from "../../../../components/ui/tooltip";
import { render, textContent } from "../../../../test/dom";
import { PlanMessage } from "./plan-message";

describe("PlanMessage", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:plan",
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: () => {},
    });
  });

  test("renders a completed preview card that opens the plan side panel", async () => {
    let openCount = 0;
    const { container, getByRole, queryByRole } = render(
      <TooltipProvider>
        <PlanMessage
          completed
          content={`# Plan\n\n1. Inspect the codebase.\n2. Implement the change.\n3. Verify the result.`}
          onOpenInSidePanel={() => {
            openCount += 1;
          }}
        />
      </TooltipProvider>,
    );

    const body = container.querySelector("[data-plan-preview-body='true']");
    const overlay = container.querySelector("button[aria-hidden='true'][tabindex='-1']");

    expect(Boolean(body)).toBe(true);
    expect(Boolean(body?.getAttribute("style")?.includes("max-height: 160px"))).toBe(true);
    expect(Boolean(body?.hasAttribute("inert"))).toBe(false);
    expect(Boolean(overlay)).toBe(true);
    expect(Boolean(getByRole("button", { name: "Open plan in side panel" }))).toBe(true);
    expect(Boolean(queryByRole("button", { name: "Expand plan summary" }))).toBe(false);
    expect(Boolean(queryByRole("button", { name: "Expand plan" }))).toBe(false);

    await act(async () => {
      fireEvent.click(overlay as HTMLButtonElement);
    });
    expect(openCount).toBe(1);
  });

  test("collapses the mounted body and close overlay when the side panel is active", async () => {
    let closeCount = 0;
    const { container, getByRole } = render(
      <TooltipProvider>
        <PlanMessage
          completed
          content={`# Plan\n\n1. Inspect the codebase.`}
          isSidePanelActive
          onCloseSidePanel={() => {
            closeCount += 1;
          }}
        />
      </TooltipProvider>,
    );

    const body = container.querySelector("[data-plan-preview-body='true']");
    const actionGroup = container.querySelector("[data-plan-action-group='true']");
    const closeButton = getByRole("button", { name: "Close plan side panel" });

    expect(Boolean(body)).toBe(true);
    expect(body?.getAttribute("aria-hidden")).toBe("true");
    expect(Boolean(body?.hasAttribute("inert"))).toBe(true);
    expect(Boolean(body?.getAttribute("style")?.includes("max-height: 0px"))).toBe(true);
    expect(actionGroup?.getAttribute("aria-hidden")).toBe("true");
    expect(Boolean(actionGroup?.hasAttribute("hidden"))).toBe(true);

    await act(async () => {
      fireEvent.click(closeButton);
    });
    expect(closeCount).toBe(1);
  });

  test("renders streaming writing state without side panel actions", () => {
    const { container, queryByRole } = render(
      <TooltipProvider>
        <PlanMessage
          completed={false}
          content={`# Plan\n\n1. Inspect the codebase.`}
          parseIncompleteMarkdown
        />
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Writing plan"))).toBe(true);
    expect(Boolean(container.querySelector(".loading-shimmer-pure-text"))).toBe(true);
    expect(Boolean(queryByRole("button", { name: "Open plan in side panel" }))).toBe(false);
  });

  test.each([
    { completed: false, content: "# In progress" },
    { completed: true, content: "   \n" },
  ])("does not export unfinished or empty plans ($completed)", ({ completed, content }) => {
    const view = render(
      <TooltipProvider>
        <PlanMessage completed={completed} content={content} />
      </TooltipProvider>,
    );
    expect(view.queryByRole("button", { name: "Download plan" })).toBeNull();
    expect(view.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  test("downloads markdown as PLAN.md", async () => {
    const originalCreateElement = document.createElement;
    let downloadedName = "";
    document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement.call(document, tagName, options);
      if (tagName.toLowerCase() === "a") {
        Object.defineProperty(element, "click", {
          configurable: true,
          value: () => {
            downloadedName = (element as HTMLAnchorElement).download;
          },
        });
      }
      return element;
    }) as typeof document.createElement;

    try {
      const { getByRole } = render(
        <TooltipProvider>
          <PlanMessage completed content={"## Plan heading\n\nParagraph body.\n\n- First bullet"} />
        </TooltipProvider>,
      );

      await act(async () => {
        fireEvent.click(getByRole("button", { name: "Download plan" }));
      });
      expect(downloadedName).toBe("PLAN.md");
    } finally {
      document.createElement = originalCreateElement;
    }
  });

  test("renders plan markdown content", () => {
    const { container } = render(
      <TooltipProvider>
        <PlanMessage completed content={"## Plan heading\n\nParagraph body.\n\n- First bullet"} />
      </TooltipProvider>,
    );

    expect(container.querySelector("h2")?.textContent).toBe("Plan heading");
    expect(container.querySelector("p")?.textContent).toBe("Paragraph body.");
    expect(container.querySelector("ul")?.textContent?.trim()).toBe("First bullet");
  });
});
