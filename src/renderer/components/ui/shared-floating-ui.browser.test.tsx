import { act, fireEvent, render } from "@testing-library/react";
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
