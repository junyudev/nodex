import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { render, textContent } from "../../../../../test/dom";
import {
  ThreadActivityDisclosure,
  ThreadActivityHeader,
  ThreadActivityShell,
  ThreadActivitySteps,
  useIsThreadActivityStep,
} from "./tool-primitives";
import { CodexShimmerText } from "../codex-shimmer-text";

describe("ThreadActivityShell", () => {
  test("renders a static activity header without disclosure button semantics", () => {
    const { container } = render(
      <ThreadActivityShell
        testId="activity-shell"
        header={<ThreadActivityHeader testId="activity-header">Read file</ThreadActivityHeader>}
        body={<div data-testid="activity-body">details</div>}
      />,
    );

    const header = container.querySelector<HTMLElement>("[data-testid='activity-header']");
    expect(header?.tagName).toBe("DIV");
    expect(Boolean(container.querySelector("button[aria-expanded]"))).toBe(false);
    expect(Boolean(container.querySelector("[data-testid='activity-body']"))).toBe(true);
    expect(Boolean(textContent(container).includes("Read file"))).toBe(true);
  });

  test("renders disclosure headers as buttons and forwards toggle events", async () => {
    let toggleCount = 0;
    const view = render(
      <ThreadActivityShell
        header={
          <ThreadActivityHeader
            testId="activity-header"
            disclosure={{
              expanded: false,
              onToggle: () => {
                toggleCount += 1;
              },
            }}
          >
            Searching the web
          </ThreadActivityHeader>
        }
      />,
    );

    const collapsedButton = view.container.querySelector<HTMLButtonElement>(
      "[data-testid='activity-header']",
    );
    expect(collapsedButton?.tagName).toBe("BUTTON");
    expect(collapsedButton?.getAttribute("aria-expanded") ?? "").toBe("false");

    await act(async () => {
      fireEvent.click(collapsedButton as HTMLButtonElement);
      await Promise.resolve();
    });

    expect(toggleCount).toBe(1);

    view.rerender(
      <ThreadActivityShell
        header={
          <ThreadActivityHeader
            testId="activity-header"
            disclosure={{
              expanded: true,
              onToggle: () => {
                toggleCount += 1;
              },
            }}
          >
            Searching the web
          </ThreadActivityHeader>
        }
        body={<div data-testid="activity-body">result</div>}
      />,
    );

    const expandedButton = view.container.querySelector<HTMLButtonElement>(
      "[data-testid='activity-header']",
    );
    expect(expandedButton?.getAttribute("aria-expanded") ?? "").toBe("true");
    expect(Boolean(view.container.querySelector("[data-testid='activity-body']"))).toBe(true);
  });
});

describe("ThreadActivityDisclosure", () => {
  test("uses a rich overlay button labelled by its summary while preserving nested controls", () => {
    const { container } = render(
      <ThreadActivityDisclosure
        status="completed"
        headerTestId="activity-header"
        icon={<span aria-hidden="true">icon</span>}
        summary={
          <a href="/file.ts" data-agent-activity-file-link>
            Edited file.ts
          </a>
        }
      >
        <div>patch rows</div>
      </ThreadActivityDisclosure>,
    );

    const header = container.querySelector<HTMLElement>("[data-testid='activity-header']");
    const overlayButton = header?.querySelector<HTMLButtonElement>(":scope > button");
    const summary = header?.querySelector<HTMLElement>("[id]");
    expect(header?.tagName).toBe("DIV");
    expect(overlayButton?.getAttribute("aria-labelledby") ?? "").toBe(summary?.id ?? "missing");
    expect(overlayButton?.getAttribute("aria-expanded") ?? "").toBe("false");
    expect(Boolean(header?.querySelector("a[data-agent-activity-file-link]"))).toBe(true);
  });

  test("prefers an explicit accessible label for a rich overlay button", () => {
    const { container } = render(
      <ThreadActivityDisclosure
        status="completed"
        accessibleLabel="Toggle activity details"
        headerTestId="activity-header"
        icon={<span aria-hidden="true">icon</span>}
        summary="Edited file.ts"
      >
        <div>patch rows</div>
      </ThreadActivityDisclosure>,
    );

    const button = container.querySelector<HTMLButtonElement>(
      "[data-testid='activity-header'] > button",
    );
    expect(button?.getAttribute("aria-label") ?? "").toBe("Toggle activity details");
    expect(button?.getAttribute("aria-labelledby") ?? "").toBe("");
  });

  test("mounts the body only while open and lets it leave before unmounting", async () => {
    let expandCount = 0;
    const { container } = render(
      <ThreadActivityDisclosure
        status="completed"
        bodyTestId="activity-body"
        headerTestId="activity-header"
        onExpand={() => {
          expandCount += 1;
        }}
        summary="Edited a file"
      >
        <div>patch rows</div>
      </ThreadActivityDisclosure>,
    );

    const button = container.querySelector<HTMLButtonElement>("[data-testid='activity-header']");
    expect(button?.getAttribute("aria-expanded") ?? "").toBe("false");
    expect(container.querySelector("[data-testid='activity-body']")).toBe(null);

    await act(async () => {
      fireEvent.click(button as HTMLButtonElement);
      await Promise.resolve();
    });

    const expandedBody = container.querySelector<HTMLElement>("[data-testid='activity-body']");
    expect(expandCount).toBe(1);
    expect(button?.getAttribute("aria-expanded") ?? "").toBe("true");
    expect(expandedBody?.getAttribute("aria-hidden")).toBe("false");
    expect(expandedBody?.hasAttribute("inert")).toBe(false);
    expect(textContent(expandedBody as HTMLElement)).toContain("patch rows");

    await act(async () => {
      fireEvent.click(button as HTMLButtonElement);
      await Promise.resolve();
    });
    expect(button?.getAttribute("aria-expanded") ?? "").toBe("false");
    expect(expandCount).toBe(1);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='activity-body']")).toBe(null);
    });
  });

  test("opens running activities by default and preserves a manual collapse", async () => {
    const view = render(
      <ThreadActivityDisclosure
        autoExpandWhileRunning
        bodyTestId="activity-body"
        headerTestId="activity-header"
        status="running"
        summary="Creating a worktree"
      >
        <div>Preparing worktree</div>
      </ThreadActivityDisclosure>,
    );
    const button = view.container.querySelector<HTMLButtonElement>(
      "[data-testid='activity-header']",
    );
    expect(button?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      fireEvent.click(button as HTMLButtonElement);
      await Promise.resolve();
    });
    expect(button?.getAttribute("aria-expanded")).toBe("false");

    view.rerender(
      <ThreadActivityDisclosure
        autoExpandWhileRunning
        bodyTestId="activity-body"
        headerTestId="activity-header"
        status="running"
        summary="Creating a worktree"
      >
        <div>Preparing worktree with more output</div>
      </ThreadActivityDisclosure>,
    );
    expect(button?.getAttribute("aria-expanded")).toBe("false");
  });

  test("preserves an expanded body node across streaming summary updates", async () => {
    const view = render(
      <ThreadActivityDisclosure
        status="running"
        defaultExpanded
        headerTestId="activity-header"
        summary="Running command"
      >
        <div data-testid="stable-activity-body">stream output</div>
      </ThreadActivityDisclosure>,
    );
    const initialBody = view.container.querySelector<HTMLElement>(
      "[data-testid='stable-activity-body']",
    );

    await act(async () => {
      view.rerender(
        <ThreadActivityDisclosure
          status="completed"
          defaultExpanded
          headerTestId="activity-header"
          summary="Ran command"
        >
          <div data-testid="stable-activity-body">stream output complete</div>
        </ThreadActivityDisclosure>,
      );
      await Promise.resolve();
    });

    const updatedBody = view.container.querySelector<HTMLElement>(
      "[data-testid='stable-activity-body']",
    );
    expect(updatedBody).toBe(initialBody);
    expect(
      view.container
        .querySelector("[data-testid='activity-header']")
        ?.getAttribute("aria-expanded") ?? "",
    ).toBe("true");
  });

  test("renders static headers and no body when expansion is disabled", () => {
    const { container } = render(
      <ThreadActivityDisclosure
        status="completed"
        bodyTestId="activity-body"
        canExpand={false}
        headerTestId="activity-header"
        summary="Called tool"
      >
        <div>hidden rows</div>
      </ThreadActivityDisclosure>,
    );

    const header = container.querySelector<HTMLElement>("[data-testid='activity-header']");
    expect(header?.tagName).toBe("DIV");
    expect(Boolean(container.querySelector("button[aria-expanded]"))).toBe(false);
    expect(Boolean(container.querySelector("[data-testid='activity-body']"))).toBe(false);
  });
});

describe("ThreadActivitySteps", () => {
  test("marks its rows as quiet nested steps", () => {
    function StepProbe() {
      return <span data-testid="probe">{useIsThreadActivityStep() ? "step" : "row"}</span>;
    }
    const view = render(
      <>
        <StepProbe />
        <ThreadActivitySteps>
          <StepProbe />
          <CodexShimmerText>Running ls</CodexShimmerText>
        </ThreadActivitySteps>
      </>,
    );

    expect(view.getAllByTestId("probe").map((probe) => probe.textContent)).toEqual(["row", "step"]);
    expect(
      view.container.querySelector("[data-codex-shimmer]")?.getAttribute("data-codex-shimmer"),
    ).toBe("static");
  });
});
