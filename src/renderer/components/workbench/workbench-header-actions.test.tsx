import { describe, expect, test, vi } from "vite-plus/test";
import { StrictMode } from "react";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { useMotionValue } from "motion/react";
import {
  HeaderAction,
  HeaderActionProvider,
  HeaderInlineActionRail,
  HeaderShellSlot,
  collectHeaderActions,
} from "./workbench-header-actions";
import { render, settleAsyncRender, textContent } from "@/test/dom";

function LaterActionDeclaration() {
  return (
    <HeaderAction actionId="third" slotPosition="right" align="end" order={30}>
      <button type="button">Third</button>
    </HeaderAction>
  );
}

function EarlierActionDeclaration() {
  return (
    <HeaderAction actionId="first" slotPosition="right" align="end" order={10}>
      <button type="button">First</button>
    </HeaderAction>
  );
}

function MiddleActionDeclaration() {
  return (
    <HeaderAction actionId="second" slotPosition="right" align="end" order={20}>
      <button type="button">Second</button>
    </HeaderAction>
  );
}

function MotionWidthSlot() {
  const slotWidth = useMotionValue(188);
  return (
    <HeaderActionProvider
      actions={
        <HeaderAction actionId="motion-width-action" slotPosition="right" align="end" order={10}>
          <button type="button">Motion</button>
        </HeaderAction>
      }
    >
      <HeaderShellSlot
        side="right"
        slotWidth={slotWidth}
        minWidth={70}
        fallbackWidth={70}
        fallbackRailWidth={62}
        onMeasuredWidthChange={() => undefined}
        onMeasuredRailWidthChange={() => undefined}
      />
    </HeaderActionProvider>
  );
}

describe("workbench header actions", () => {
  test("publishes mounted actions, replaces their behavior and releases declarations", async () => {
    const oldClick = vi.fn();
    const newClick = vi.fn();
    function Declaration({ active, onClick }: { active: boolean; onClick: () => void }) {
      if (!active) return null;
      return (
        <HeaderAction actionId="live" slotPosition="center" align="end" order={10}>
          <button type="button" onClick={onClick}>
            Live action
          </button>
        </HeaderAction>
      );
    }
    const rail = <HeaderInlineActionRail slotPosition="center" data-testid="live-header-rail" />;
    const content = (active: boolean, onClick: () => void) => (
      <StrictMode>
        <HeaderActionProvider actions={<Declaration active={active} onClick={onClick} />}>
          {rail}
        </HeaderActionProvider>
      </StrictMode>
    );
    const view = render(content(false, oldClick));
    expect(view.queryByRole("button", { name: "Live action" })).toBeNull();
    view.rerender(content(true, oldClick));
    const button = await within(view.getByTestId("live-header-rail")).findByRole("button", {
      name: "Live action",
    });
    await act(async () => {
      button.focus();
      fireEvent.click(button);
    });
    expect(oldClick).toHaveBeenCalledOnce();
    view.rerender(content(true, newClick));
    await waitFor(() =>
      expect(
        within(view.getByTestId("live-header-rail")).getByRole("button", { name: "Live action" }),
      ).toBe(button),
    );
    expect(document.activeElement).toBe(button);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(oldClick).toHaveBeenCalledOnce();
    expect(newClick).toHaveBeenCalledOnce();
    view.rerender(content(false, newClick));
    await waitFor(() => expect(view.queryByRole("button", { name: "Live action" })).toBeNull());
  });

  test("sorts actions by order then action id with duplicate ids using the last declaration", () => {
    const entries = collectHeaderActions(
      <>
        <HeaderAction actionId="beta" slotPosition="right" align="end" order={20}>
          Old beta
        </HeaderAction>
        <HeaderAction actionId="alpha" slotPosition="right" align="end" order={10}>
          Alpha
        </HeaderAction>
        <HeaderAction actionId="beta" slotPosition="right" align="end" order={20}>
          New beta
        </HeaderAction>
        <HeaderAction actionId="gamma" slotPosition="left" align="start" order={20}>
          Gamma
        </HeaderAction>
      </>,
    );

    expect(entries.map((entry) => entry.actionId).join(",")).toBe("alpha,beta,gamma");
    expect(String(entries.find((entry) => entry.actionId === "beta")?.children)).toBe("New beta");
  });

  test("renders separate declaration components into one right-side rail", async () => {
    const measuredWidths: number[] = [];
    const measuredRailWidths: number[] = [];
    const view = render(
      <HeaderActionProvider
        actions={
          <>
            <LaterActionDeclaration />
            <EarlierActionDeclaration />
            <MiddleActionDeclaration />
          </>
        }
      >
        <HeaderShellSlot
          side="right"
          slotWidth={144}
          minWidth={70}
          fallbackWidth={70}
          fallbackRailWidth={62}
          onMeasuredWidthChange={(width) => {
            measuredWidths.push(width);
          }}
          onMeasuredRailWidthChange={(width) => {
            measuredRailWidths.push(width);
          }}
        />
      </HeaderActionProvider>,
    );

    await settleAsyncRender();

    const slot = view.container.querySelector('[data-test-id="header-shell-slot"]');
    const rail = slot?.querySelector('[data-workbench-header-action-rail="visible"]');
    if (!(slot instanceof HTMLElement) || !(rail instanceof HTMLElement)) {
      throw new Error("Expected visible header shell slot");
    }

    expect(slot.className.includes("no-drag")).toBe(true);
    expect(slot.className.includes("pointer-events-none")).toBe(true);
    expect(slot.getAttribute("style")?.includes("width: 144px")).toBe(true);
    expect(slot.getAttribute("style")?.includes("min-width: 70px")).toBe(true);
    expect(rail.className.includes("no-drag")).toBe(true);
    expect(textContent(rail)).toBe("FirstSecondThird");
    expect(measuredWidths[measuredWidths.length - 1]).toBe(70);
    expect(measuredRailWidths[measuredRailWidths.length - 1]).toBe(62);
  });

  test("accepts a MotionValue as the visible slot width", async () => {
    const view = render(<MotionWidthSlot />);
    await settleAsyncRender();

    const slot = view.container.querySelector('[data-test-id="header-shell-slot"]');
    if (!(slot instanceof HTMLElement)) {
      throw new Error("Expected visible header shell slot");
    }

    expect(slot.getAttribute("style")?.includes("width: 188px")).toBe(true);
    expect(textContent(slot)).toBe("Motion");
  });

  test("renders center actions through an inline rail", async () => {
    const view = render(
      <HeaderActionProvider
        actions={
          <>
            <HeaderAction actionId="right-action" slotPosition="right" align="end" order={10}>
              <button type="button">Right</button>
            </HeaderAction>
            <HeaderAction actionId="center-action" slotPosition="center" align="end" order={10}>
              <button type="button">Center</button>
            </HeaderAction>
          </>
        }
      >
        <HeaderInlineActionRail
          slotPosition="center"
          data-testid="center-header-actions"
          className="ms-auto"
        />
      </HeaderActionProvider>,
    );

    await settleAsyncRender();

    const railHost = view.getByTestId("center-header-actions");
    const visibleRail = railHost.querySelector('[data-workbench-header-action-rail="visible"]');
    expect(visibleRail instanceof HTMLElement).toBe(true);
    expect(textContent(railHost)).toBe("Center");
  });
});
