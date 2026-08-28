import { describe, expect, test } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import { render, textContent } from "../../../../test/dom";
import { parseTodoSteps, TodoListCompactPillContent, TodoListSurface } from "./todo-list-surface";

describe("parseTodoSteps", () => {
  test("prefers structured raw plan steps when available", () => {
    const steps = parseTodoSteps({
      markdownText: "1. Ignored markdown fallback",
      status: "completed",
      rawItem: {
        plan: [
          { step: "Review failing stories", status: "completed" },
          { step: "Patch MCP renderer", status: "in_progress" },
        ],
      },
    });

    expect(steps.length).toBe(2);
    expect(steps[0]?.status).toBe("completed");
    expect(steps[1]?.status).toBe("in_progress");
  });

  test("marks the first pending markdown step as in progress while the turn is still running", () => {
    const steps = parseTodoSteps({
      markdownText: [
        "- [x] Audit the bundle",
        "- [ ] Port the todo shell",
        "- [ ] Update stories",
      ].join("\n"),
      status: "inProgress",
      rawItem: undefined,
    });

    expect(steps[0]?.status).toBe("completed");
    expect(steps[1]?.status).toBe("in_progress");
    expect(steps[2]?.status).toBe("pending");
  });
});

describe("TodoListSurface", () => {
  test("renders compact above-composer step progress from parsed todo steps", () => {
    const { container } = render(
      <TooltipProvider>
        <TodoListCompactPillContent
          item={{
            markdownText: [
              "- [x] Audit the bundle",
              "- [ ] Port the todo shell",
              "- [ ] Update stories",
            ].join("\n"),
            status: "inProgress",
            rawItem: undefined,
          }}
        />
      </TooltipProvider>,
    );

    expect(Boolean(textContent(container).includes("Step 2 / 3"))).toBe(true);
    expect(Boolean(textContent(container).includes("1 out of 3 tasks completed"))).toBe(false);
    const donut = container.querySelector("svg");
    expect(donut?.getAttribute("width")).toBe("12");
    expect(donut?.querySelectorAll("circle").length).toBe(2);
    expect(donut?.querySelector("circle:last-child")?.getAttribute("pathLength")).toBe("100");
  });

  test("renders the Codex-style completion summary and expandable step list", () => {
    const { container, getByRole } = render(
      <TodoListSurface
        item={{
          markdownText: [
            "- [x] Audit the bundle",
            "- [ ] Port the todo shell",
            "- [ ] Update stories",
          ].join("\n"),
          status: "inProgress",
          rawItem: undefined,
        }}
      />,
    );

    const toggle = getByRole("button", { name: "Collapse todo list" });
    expect(Boolean(textContent(container).includes("1 out of 3 tasks completed"))).toBe(true);
    expect(Boolean(textContent(container).includes("Port the todo shell"))).toBe(true);
    expect(toggle.getAttribute("aria-label")).toBe("Collapse todo list");
    expect(container.querySelector('[data-thread-find-skip="true"]')).toBe(null);
    const collapseIcon = toggle.querySelector("path")?.getAttribute("d");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-label")).toBe("Expand todo list");
    expect(container.querySelector('[data-thread-find-skip="true"]')).not.toBeNull();
    expect(toggle.querySelector("path")?.getAttribute("d")).not.toBe(collapseIcon);
  });
});
