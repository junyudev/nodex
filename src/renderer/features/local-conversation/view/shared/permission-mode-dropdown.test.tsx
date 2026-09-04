import { fireEvent, waitFor } from "@testing-library/react";
import { act, useState, type ComponentProps } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { NodexModalHost } from "@/lib/modal-registry";
import { renderWithMaitai } from "@/test/thread-maitai";
import { PermissionModeDropdown } from "./permission-mode-dropdown";

type PermissionModeDropdownProps = ComponentProps<typeof PermissionModeDropdown>;

function renderPermissionDropdown(overrides: Partial<PermissionModeDropdownProps> = {}) {
  const props: PermissionModeDropdownProps = {
    selectedMode: "auto",
    availableModes: ["auto", "guardian-approvals", "full-access", "custom"],
    autoReviewAvailable: true,
    onSelect: () => undefined,
    ...overrides,
  };

  return renderWithMaitai(
    <NodexTooltipProvider delay={0}>
      <PermissionModeDropdown {...props} />
      <NodexModalHost />
    </NodexTooltipProvider>,
  );
}

async function openPermissionMenu(view: ReturnType<typeof renderPermissionDropdown>) {
  await act(async () => {
    const trigger = view.getByRole("button", { name: "Change permissions" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await Promise.resolve();
  });

  return view.getByRole("menu");
}

describe("permission mode dropdown", () => {
  test("uses the compact Nodex permission menu copy", async () => {
    const view = renderPermissionDropdown({ selectedMode: "guardian-approvals" });

    expect(view.getByText("Approve for me")).toBeTruthy();

    await openPermissionMenu(view);

    expect(view.getByText("How should Nodex actions be approved?")).toBeTruthy();
    expect(view.getByText("Always ask to edit external files and use the internet")).toBeTruthy();
    expect(view.getByText("Only ask for actions detected as potentially unsafe")).toBeTruthy();
    expect(view.queryByText("Guardian approvals")).toBeNull();
  });

  test("keeps unavailable fixed modes visible and disabled without replacing their descriptions", async () => {
    const view = renderPermissionDropdown({
      availableModes: ["auto", "full-access"],
      autoReviewAvailable: false,
    });

    await openPermissionMenu(view);

    const autoReviewItem = view.getByRole("menuitem", { name: /Approve for me/ });
    expect(autoReviewItem.getAttribute("aria-disabled")).toBe("true");
    expect(view.getByText("Only ask for actions detected as potentially unsafe")).toBeTruthy();

    await act(async () => {
      fireEvent.focus(autoReviewItem);
      await Promise.resolve();
    });
    expect(
      await view.findByText("Requires default sandboxed permissions in this workspace"),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(autoReviewItem);
      await Promise.resolve();
    });

    expect(view.getByRole("menu")).toBeTruthy();
  });

  test("only shows Custom when it is available or currently selected", async () => {
    const unavailableView = renderPermissionDropdown({
      availableModes: ["auto", "guardian-approvals", "full-access"],
    });
    await openPermissionMenu(unavailableView);

    expect(unavailableView.queryByText("Custom (config.toml)")).toBeNull();
    unavailableView.unmount();

    const currentCustomView = renderPermissionDropdown({
      selectedMode: "custom",
      availableModes: ["auto", "full-access"],
      autoReviewAvailable: false,
    });
    expect(currentCustomView.getByText("Custom (config.toml)")).toBeTruthy();
    await openPermissionMenu(currentCustomView);

    expect(currentCustomView.getAllByText("Custom (config.toml)")).toHaveLength(2);
    expect(currentCustomView.getByText("Uses permissions defined in config.toml")).toBeTruthy();
  });

  test("selects Custom directly when it is available", async () => {
    const onSelect = vi.fn();
    const view = renderPermissionDropdown({ onSelect });
    await openPermissionMenu(view);

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: /Custom \(config.toml\)/ }));
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledWith("custom");
  });

  test("supports an explicit inherit row without inventing a permission mode", async () => {
    const onInherit = vi.fn();
    const view = renderPermissionDropdown({
      selectedMode: null,
      allowInherit: true,
      onInherit,
    });

    expect(view.getByText("Use current/default")).toBeTruthy();
    await openPermissionMenu(view);
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Use current/default" }));
      await Promise.resolve();
    });

    expect(onInherit).toHaveBeenCalledTimes(1);
  });

  test("can expose Full access as unavailable without opening a consent dialog", async () => {
    const onSelect = vi.fn();
    const view = renderPermissionDropdown({
      onSelect,
      confirmFullAccess: false,
      fullAccessDisabledReason: "Enable Full access in Composer first",
    });
    await openPermissionMenu(view);

    const fullAccess = view.getByRole("menuitem", { name: /Full access/u });
    expect(fullAccess.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.focus(fullAccess);
      fireEvent.click(fullAccess);
      await Promise.resolve();
    });

    expect(await view.findByText("Enable Full access in Composer first")).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("confirms Full access after the menu closes", async () => {
    const onSelect = vi.fn();
    const view = renderPermissionDropdown({ onSelect });
    await openPermissionMenu(view);

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: /Full access/ }));
      await Promise.resolve();
    });

    await view.findByRole("dialog", { name: "Turn on Full Access?" });
    expect(view.queryByRole("menu")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      view.getByText("Read, create, modify, upload, or delete files anywhere on this computer"),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(onSelect).not.toHaveBeenCalled();

    await openPermissionMenu(view);
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: /Full access/ }));
      await Promise.resolve();
    });
    await view.findByRole("dialog", { name: "Turn on Full Access?" });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Confirm" }));
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("full-access");
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("owns the Full access dialog outside the composer trigger subtree", async () => {
    const parentPointerDown = vi.fn();
    let hideTrigger: () => void = () => undefined;

    function Harness() {
      const [showTrigger, setShowTrigger] = useState(true);
      hideTrigger = () => setShowTrigger(false);

      return (
        <NodexTooltipProvider>
          {showTrigger ? (
            <div onPointerDown={parentPointerDown}>
              <PermissionModeDropdown
                selectedMode="auto"
                availableModes={["auto", "full-access"]}
                onSelect={() => undefined}
              />
            </div>
          ) : null}
          <NodexModalHost />
        </NodexTooltipProvider>
      );
    }

    const view = renderWithMaitai(<Harness />);
    await openPermissionMenu(view);
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: /Full access/ }));
      await Promise.resolve();
    });

    const dialog = await view.findByRole("dialog", { name: "Turn on Full Access?" });
    parentPointerDown.mockClear();

    await act(async () => {
      fireEvent.pointerDown(dialog);
      hideTrigger();
      await Promise.resolve();
    });

    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(view.getByRole("dialog", { name: "Turn on Full Access?" })).toBeTruthy();
  });
});
