import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "../../globals.css";
import { PropertyOptionPicker } from "@/components/database/property-option-picker";
import { NFM_EDITOR_FLOATING_UI_Z_INDEX } from "@/components/board/editor/nfm-blocknote-floating-ui";
import { Circle } from "@/components/shared/icons/generic-icons";
import { openNodexMenu } from "@/test/dom";
import { APP_SHELL_MODAL_LAYER_INDEX, APP_SHELL_TOAST_LAYER_INDEX } from "@/lib/app-shell-layers";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexOptionPicker,
} from "./dropdown";
import { NodexDialog, NodexDialogContent, NodexDialogTitle } from "./dialog";
import { NodexHoverCard, NodexHoverCardProvider } from "./hover-card";
import { NodexPopover, NodexPopoverAnchor, NodexPopoverContent } from "./popover";
import { __resetNodexToastStoreForTests, NodexToastProvider, toast } from "./toast";
import { NodexTooltip, NodexTooltipProvider } from "./tooltip";

const settleFloatingSurface = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

function ProbeIcon({ testId, className = "size-3" }: { testId: string; className?: string }) {
  return <Circle data-testid={testId} className={`${className} fill-current`} aria-hidden="true" />;
}

function DialogPopoverEscapeProbe() {
  const [dialogOpen, setDialogOpen] = useState(true);
  const [popoverOpen, setPopoverOpen] = useState(true);
  const [actionDisabled, setActionDisabled] = useState(false);

  return (
    <NodexDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <NodexDialogContent data-testid="outer-dialog" initialFocus={false}>
        <NodexDialogTitle>Outer dialog</NodexDialogTitle>
        <NodexPopover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <NodexPopoverAnchor>
            <button type="button">Filter trigger</button>
          </NodexPopoverAnchor>
          <NodexPopoverContent data-testid="dialog-popover" finalFocus={false}>
            <button type="button" disabled={actionDisabled} onClick={() => setActionDisabled(true)}>
              Nested filter action
            </button>
          </NodexPopoverContent>
        </NodexPopover>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function NestedDialogLayerProbe() {
  return (
    <NodexDialog open onOpenChange={() => undefined}>
      <NodexDialogContent data-testid="parent-dialog" initialFocus={false}>
        <NodexDialogTitle>Parent dialog</NodexDialogTitle>
        <NodexDialog open onOpenChange={() => undefined}>
          <NodexDialogContent data-testid="child-dialog" initialFocus={false}>
            <NodexDialogTitle>Child dialog</NodexDialogTitle>
          </NodexDialogContent>
        </NodexDialog>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function DialogWithBackgroundPopoverProbe() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <NodexPopover open>
        <NodexPopoverAnchor>
          <button type="button">Background filter</button>
        </NodexPopoverAnchor>
        <NodexPopoverContent
          data-testid="background-popover"
          initialFocus={false}
          finalFocus={false}
        >
          Background options
        </NodexPopoverContent>
      </NodexPopover>
      <NodexDialog open={open} onOpenChange={setOpen}>
        <NodexDialogContent>
          <NodexDialogTitle>Foreground dialog</NodexDialogTitle>
          <input aria-label="Foreground input" />
        </NodexDialogContent>
      </NodexDialog>
    </>
  );
}

afterEach(async () => {
  await act(async () => {
    __resetNodexToastStoreForTests();
    await Promise.resolve();
  });
});

describe("shared floating UI in Chromium", () => {
  test("lets Escape close a nested popover without dismissing its dialog owner", async () => {
    const view = render(<DialogPopoverEscapeProbe />);
    await act(settleFloatingSurface);

    const nestedAction = view.getByRole("button", { name: "Nested filter action" });
    await act(async () => {
      await userEvent.click(nestedAction);
      await userEvent.keyboard("{Escape}");
      await settleFloatingSurface();
    });

    expect(view.queryByRole("button", { name: "Nested filter action" })).toBeNull();
    expect(view.getByRole("dialog", { name: "Outer dialog" })).toBeTruthy();
  });

  test("ignores a background popover made inert by the active modal when assigning Escape", async () => {
    const view = render(<DialogWithBackgroundPopoverProbe />);
    const input = view.getByRole("textbox", { name: "Foreground input" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(
      view
        .getByTestId("background-popover")
        .closest('[aria-hidden="true"], [inert], [data-base-ui-inert]'),
    ).not.toBeNull();

    await act(async () => userEvent.keyboard("{Escape}"));
    await waitFor(() =>
      expect(view.queryByRole("dialog", { name: "Foreground dialog" })).toBeNull(),
    );
  });

  test("stacks dialogs above editor chrome and their floating descendants above the dialog", async () => {
    const view = render(<DialogPopoverEscapeProbe />);
    await act(settleFloatingSurface);

    const overlay = document.querySelector<HTMLElement>('[data-slot="codex-dialog-overlay"]');
    const dialog = view.getByTestId("outer-dialog");
    const nestedPopover = view.getByTestId("dialog-popover");
    if (!overlay) throw new Error("Expected the dialog overlay.");

    const overlayLayer = Number(getComputedStyle(overlay).zIndex);
    const dialogLayer = Number(getComputedStyle(dialog).zIndex);
    const popoverLayer = Number(getComputedStyle(nestedPopover).zIndex);
    expect(overlayLayer).toBe(APP_SHELL_MODAL_LAYER_INDEX);
    expect(dialogLayer).toBe(APP_SHELL_MODAL_LAYER_INDEX);
    expect(dialogLayer).toBeGreaterThan(NFM_EDITOR_FLOATING_UI_Z_INDEX);
    expect(popoverLayer).toBe(dialogLayer + 1);
  });

  test("increments the modal layer for a nested dialog", async () => {
    const view = render(<NestedDialogLayerProbe />);
    await act(settleFloatingSurface);

    const parentLayer = Number(getComputedStyle(view.getByTestId("parent-dialog")).zIndex);
    const childLayer = Number(getComputedStyle(view.getByTestId("child-dialog")).zIndex);
    expect(parentLayer).toBe(APP_SHELL_MODAL_LAYER_INDEX);
    expect(childLayer).toBe(parentLayer + 1);
  });

  test("keeps actionable toasts outside the window drag region on one visual axis", async () => {
    const view = render(
      <NodexToastProvider>
        <div />
      </NodexToastProvider>,
    );

    await act(async () => {
      toast.info("Page draft closed", {
        duration: 0,
        action: {
          label: "Restore",
          onClick: () => false,
        },
      });
      await settleFloatingSurface();
    });

    const alert = view.getByRole("alert");
    const title = view.getByText("Page draft closed");
    const restore = view.getByRole("button", { name: "Restore" });
    const dismiss = view.getByRole("button", { name: "Dismiss notification" });
    const levelIcon = alert.querySelector("svg");
    if (!levelIcon) throw new Error("Expected a toast level icon.");

    const surfaceCenter =
      alert.getBoundingClientRect().top + alert.getBoundingClientRect().height / 2;
    for (const element of [title, restore, dismiss, levelIcon]) {
      const rect = element.getBoundingClientRect();
      expect(Math.abs(rect.top + rect.height / 2 - surfaceCenter)).toBeLessThanOrEqual(1);
    }
    expect(getComputedStyle(alert).getPropertyValue("-webkit-app-region")).toBe("no-drag");
    const toastLayer = alert.closest('[data-slot="toast-viewport"]')?.parentElement;
    if (!toastLayer) throw new Error("Expected the toast layer.");
    expect(Number(getComputedStyle(toastLayer).zIndex)).toBe(APP_SHELL_TOAST_LAYER_INDEX);
    expect(Number(getComputedStyle(toastLayer).zIndex)).toBeGreaterThan(
      APP_SHELL_MODAL_LAYER_INDEX,
    );
  });

  test("lays out an actionable toast at the top center with its compact rhythm", async () => {
    const view = render(
      <NodexToastProvider>
        <div />
      </NodexToastProvider>,
    );

    await act(async () => {
      toast.info("Archived chat", {
        duration: 0,
        secondaryAction: { label: "View", onClick: () => false },
        action: { label: "Undo", onClick: () => false },
      });
      await settleFloatingSurface();
    });

    const alert = view.getByRole("alert");
    const edges = (element: Element) => element.getBoundingClientRect();
    const title = edges(view.getByText("Archived chat"));
    const secondary = view.getByRole("button", { name: "View" });
    const primary = view.getByRole("button", { name: "Undo" });
    const dismiss = edges(view.getByRole("button", { name: "Dismiss notification" }));

    await waitFor(() => expect(edges(alert).top).toBe(48));
    expect(edges(alert).height).toBe(42);
    expect(
      Math.abs(edges(alert).left + edges(alert).width / 2 - window.innerWidth / 2),
    ).toBeLessThanOrEqual(1);

    // Icon slot, title, actions, then the dismiss slot: 4, 12, 8 and 4 pixels apart.
    expect(title.left - edges(alert).left).toBe(1 + 12 + 24 + 4);
    expect(edges(secondary).left - title.right).toBeCloseTo(12, 0);
    expect(edges(primary).left - edges(secondary).right).toBeCloseTo(8, 0);
    expect(dismiss.left - edges(primary).right).toBeCloseTo(4, 0);
    expect(edges(alert).right - dismiss.right).toBe(12 + 1);

    for (const button of [secondary, primary]) {
      expect(edges(button).height).toBe(24);
      expect(getComputedStyle(button).fontSize).toBe("12px");
    }
    expect(getComputedStyle(alert).boxShadow).toContain("0px 4px 12px");
  });

  test("moves toast actions below a description and animates through the shared duration", async () => {
    const view = render(
      <NodexToastProvider>
        <div />
      </NodexToastProvider>,
    );

    await act(async () => {
      toast.danger("Unable to transcribe audio", {
        description: "The recording could not be read.",
        duration: 0,
        action: { label: "Retry", onClick: () => false },
      });
      await settleFloatingSurface();
    });

    const description = view.getByText("The recording could not be read.");
    const retry = view.getByRole("button", { name: "Retry" });
    expect(retry.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      description.getBoundingClientRect().bottom,
    );

    const item = view.getByRole("alert").closest("[data-sonner-toast]");
    if (!item) throw new Error("Expected the toast to sit in the notification stack.");
    expect(getComputedStyle(item).transitionDuration.split(", ")[0]).toBe("0.3s");
    expect(getComputedStyle(item).position).toBe("absolute");
  });

  test("stacks up to three toasts and fans them out on hover", async () => {
    const view = render(
      <NodexToastProvider>
        <div />
      </NodexToastProvider>,
    );

    await act(async () => {
      for (const title of ["First", "Second", "Third", "Fourth"]) {
        toast.info(title, { duration: 0 });
        await settleFloatingSurface();
      }
    });

    const items = () =>
      Array.from(view.baseElement.querySelectorAll<HTMLElement>("[data-sonner-toast]"));
    await waitFor(() => expect(items().length).toBe(4));
    expect(items().filter((item) => item.dataset.visible === "true").length).toBe(3);

    const stack = view.baseElement.querySelector("[data-sonner-toaster]");
    if (!stack) throw new Error("Expected the notification stack.");
    await act(async () => {
      fireEvent.mouseEnter(stack);
      fireEvent.mouseMove(stack);
      await settleFloatingSurface();
    });

    await waitFor(() => {
      const [front, second] = items();
      if (!front || !second) throw new Error("Expected two toasts.");
      expect(front.dataset.expanded).toBe("true");
      // 42px surface plus the 8px gap once the transition settles.
      expect(second.getBoundingClientRect().top - front.getBoundingClientRect().top).toBeCloseTo(
        50,
        0,
      );
    });
  });

  test("renders compact property-chip and menu leading icons at 16 pixels", async () => {
    const view = render(
      <div>
        <PropertyOptionPicker
          label="Status"
          mode="single"
          presentation="chip"
          triggerPrefix={<ProbeIcon testId="property-chip-status-icon" />}
          options={[{ id: "triage", name: "Triage", color: "gray" }]}
          selectedIds={["triage"]}
          onSelectedIdsChange={() => undefined}
        />
        <NodexOptionPicker
          value="triage"
          onValueChange={() => undefined}
          options={[
            {
              value: "triage",
              label: "Triage",
              leftSlot: <ProbeIcon testId="menu-status-icon" />,
            },
          ]}
          triggerButton={
            <NodexDropdownButtonTrigger size="xs" shape="pill" showChevron={false}>
              <ProbeIcon testId="dropdown-chip-status-icon" className="size-4" />
              Triage
            </NodexDropdownButtonTrigger>
          }
        />
        <NodexDropdownButtonTrigger size="rule" aria-label="Rule selector">
          Rule
        </NodexDropdownButtonTrigger>
      </div>,
    );

    expect(view.getByTestId("property-chip-status-icon").getBoundingClientRect().width).toBe(16);
    expect(view.getByTestId("dropdown-chip-status-icon").getBoundingClientRect().width).toBe(16);
    const ruleChevron = view.getByRole("button", { name: "Rule selector" }).querySelector("svg");
    if (!ruleChevron) throw new Error("Expected a rule selector chevron.");
    expect(ruleChevron.getBoundingClientRect().width).toBe(14);
    const dropdownTrigger = view.getByTestId("dropdown-chip-status-icon").closest("button");
    if (!dropdownTrigger) throw new Error("Expected a compact dropdown trigger.");

    await openNodexMenu(dropdownTrigger);

    expect(view.getByTestId("menu-status-icon").getBoundingClientRect().width).toBe(16);
  });

  test("renders filtered option selection with app-owned combobox chrome", async () => {
    const view = render(
      <NodexOptionPicker
        value="nodex"
        search="filter"
        searchPlaceholder="Search projects…"
        searchAriaLabel="Search projects"
        options={[
          { value: "nodex", label: "Nodex" },
          { value: "bundle", label: "Readable bundle" },
        ]}
        onValueChange={() => undefined}
        triggerButton={<NodexDropdownButtonTrigger>Project</NodexDropdownButtonTrigger>}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Project" }));
      await settleFloatingSurface();
    });
    const search = view.getByRole("combobox", {
      name: "Search projects",
    }) as HTMLInputElement;
    expect(search.type).toBe("text");
    expect(document.activeElement).toBe(search);
    expect(view.getAllByRole("option")).toHaveLength(2);
  });

  test("stacks tooltips above editor floating menus", async () => {
    const view = render(
      <NodexTooltipProvider>
        <NodexTooltip defaultOpen tooltipContent="Bold">
          <button type="button">Formatting action</button>
        </NodexTooltip>
      </NodexTooltipProvider>,
    );

    await act(settleFloatingSurface);
    const tooltip = view.getByRole("tooltip");
    const tooltipZIndex = Number(getComputedStyle(tooltip).zIndex);
    expect(tooltipZIndex).toBeGreaterThan(NFM_EDITOR_FLOATING_UI_Z_INDEX);
  });

  test("keeps dropdown trigger tooltips padded around compact shortcut chips", async () => {
    const view = render(
      <NodexTooltipProvider delay={0}>
        <NodexDropdownMenu
          triggerButton={<button type="button">Model</button>}
          triggerTooltipContent="Select model"
          triggerTooltipShortcutLabel="Ctrl+Shift+M"
        >
          <div>Model option</div>
        </NodexDropdownMenu>
      </NodexTooltipProvider>,
    );
    const trigger = view.getByRole("button", { name: "Model" });

    await act(async () => {
      fireEvent.mouseEnter(trigger);
      await settleFloatingSurface();
    });

    const tooltip = view.getByRole("tooltip");
    const shortcut = tooltip.querySelector("kbd");
    if (!shortcut) throw new Error("Expected a tooltip shortcut chip.");
    const style = getComputedStyle(tooltip);
    expect(style.paddingLeft).toBe("8px");
    expect(style.paddingRight).toBe("8px");
    expect(style.paddingTop).toBe("4px");
    expect(style.paddingBottom).toBe("4px");
    expect(shortcut.tagName).toBe("KBD");
    expect(shortcut.getBoundingClientRect().height).toBe(18);
  });

  test("preserves button semantics for non-native dropdown triggers", async () => {
    const view = render(
      <NodexDropdownMenu triggerButton={<div>Environment</div>} triggerNativeButton={false}>
        <NodexDropdownItem>Local</NodexDropdownItem>
      </NodexDropdownMenu>,
    );
    const trigger = view.getByRole("button", { name: "Environment" });

    expect(trigger.tagName).toBe("DIV");
    await act(async () => {
      await userEvent.click(trigger);
      await settleFloatingSurface();
    });

    expect(view.getByRole("menuitem", { name: "Local" })).toBeTruthy();
  });

  test("increments the layer for recursively portalled floating surfaces", async () => {
    const view = render(
      <NodexPopover open>
        <NodexPopoverAnchor>
          <button type="button">Outer floating action</button>
        </NodexPopoverAnchor>
        <NodexPopoverContent data-testid="outer-floating-surface">
          <NodexPopover open>
            <NodexPopoverAnchor>
              <button type="button">Inner floating action</button>
            </NodexPopoverAnchor>
            <NodexPopoverContent data-testid="inner-floating-surface">
              Nested floating content
            </NodexPopoverContent>
          </NodexPopover>
        </NodexPopoverContent>
      </NodexPopover>,
    );

    await act(settleFloatingSurface);
    const outerSurface = view.getByTestId("outer-floating-surface");
    const innerSurface = view.getByTestId("inner-floating-surface");
    expect(document.body.contains(outerSurface)).toBe(true);
    expect(document.body.contains(innerSurface)).toBe(true);
    expect(outerSurface.contains(innerSurface)).toBe(false);
    expect(Number(getComputedStyle(innerSurface).zIndex)).toBe(
      Number(getComputedStyle(outerSurface).zIndex) + 1,
    );
  });

  test("carries the floating layer through nested Floating UI portals", async () => {
    const view = render(
      <NodexHoverCardProvider>
        <NodexHoverCard
          defaultOpen
          ariaLabel="Floating owner"
          hoverCardContent={
            <NodexPopover open>
              <NodexPopoverAnchor>
                <button type="button">Nested hover-card action</button>
              </NodexPopoverAnchor>
              <NodexPopoverContent data-testid="hover-card-child-surface">
                Nested child
              </NodexPopoverContent>
            </NodexPopover>
          }
        >
          <button type="button">Hover-card trigger</button>
        </NodexHoverCard>
      </NodexHoverCardProvider>,
    );

    await act(settleFloatingSurface);
    const hoverCard = view.getByRole("dialog", { name: "Floating owner" });
    const childSurface = view.getByTestId("hover-card-child-surface");
    expect(hoverCard.contains(childSurface)).toBe(false);
    expect(Number(getComputedStyle(childSurface).zIndex)).toBe(
      Number(getComputedStyle(hoverCard).zIndex) + 1,
    );
  });
});
