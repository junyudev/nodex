import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexDialog, NodexDialogContent, NodexDialogTitle } from "@/components/ui/dialog";
import { render } from "@/test/dom";
import { PropertyOptionPicker } from "./property-option-picker";

const options = [
  { id: "one", name: "Needs review", color: "orange" },
  { id: "two", name: "Ready", color: "green" },
] as const;

describe("PropertyOptionPicker", () => {
  test("renders Board multi-select values as sibling chips on one picker trigger", async () => {
    const view = render(
      <PropertyOptionPicker
        label="Tags"
        mode="multiple"
        presentation="board"
        options={options}
        selectedIds={["one", "two"]}
        onSelectedIdsChange={vi.fn()}
      />,
    );

    const trigger = view.getByRole("button", {
      name: "Edit Tags: Needs review, Ready",
    });
    expect(trigger.textContent).toBe("Needs reviewReady");
    expect(view.getAllByRole("button")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    expect(view.getByRole("combobox", { name: "Search Tags options" })).toBeTruthy();
  });

  test("portals above a clipping dialog while preserving focus and interaction", async () => {
    const onChange = vi.fn();
    const view = render(
      <NodexDialog open>
        <NodexDialogContent>
          <NodexDialogTitle>Property dialog</NodexDialogTitle>
          <PropertyOptionPicker
            label="Tags"
            mode="multiple"
            options={options}
            selectedIds={[]}
            onSelectedIdsChange={onChange}
          />
        </NodexDialogContent>
      </NodexDialog>,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Tags" }));
      await Promise.resolve();
    });
    const dialog = view
      .getByRole("heading", { name: "Property dialog" })
      .closest('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const input = view.getByRole("combobox", { name: "Search Tags options" });
    expect(dialog?.contains(input)).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(input));

    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Needs review" }));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith(["one"]);
    expect(
      view.getByRole("heading", { name: "Property dialog" }).closest('[role="dialog"]'),
    ).not.toBeNull();
  });

  test("renders an empty multi-select as only the shared Empty value", () => {
    const view = render(
      <PropertyOptionPicker
        label="Tags"
        mode="multiple"
        options={options}
        selectedIds={[]}
        onSelectedIdsChange={vi.fn()}
      />,
    );

    const trigger = view.getByRole("button", { name: "Edit Tags" });
    expect(trigger.textContent).toBe("Empty");
    expect(trigger.querySelector("svg")).toBeNull();
  });

  test("keeps multi-select open while toggling and exposes explicit token removal", async () => {
    const onChange = vi.fn();
    const view = render(
      <PropertyOptionPicker
        label="Tags"
        mode="multiple"
        options={options}
        selectedIds={["one"]}
        onSelectedIdsChange={onChange}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Tags" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Ready" }));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith(["one", "two"]);
    expect(view.getByRole("combobox", { name: "Search Tags options" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Remove Needs review" }));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  test("keeps an embedded single-select editor expanded after choosing a value", async () => {
    const onChange = vi.fn();
    const view = render(
      <PropertyOptionPicker
        host="embedded"
        label="Status"
        mode="single"
        options={options}
        selectedIds={[]}
        onSelectedIdsChange={onChange}
      />,
    );

    const search = view.getByRole("combobox", { name: "Search Status options" });
    expect(search.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Ready" }));
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledWith(["two"]);
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByRole("option", { name: "Needs review" })).toBeTruthy();
  });

  test("filters options and delegates creation without inventing an identity", async () => {
    const onCreate = vi.fn(async () => undefined);
    const view = render(
      <PropertyOptionPicker
        label="Tags"
        mode="multiple"
        options={options}
        selectedIds={[]}
        allowCreate
        onSelectedIdsChange={vi.fn()}
        onCreateOption={onCreate}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Tags" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.change(view.getByRole("combobox", { name: "Search Tags options" }), {
        target: { value: "New tag" },
      });
      await Promise.resolve();
    });
    expect(view.queryByRole("option", { name: "Ready" })).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create “New tag”" }));
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledWith("New tag");
  });

  test("supports list navigation, token backspace, and escape without mutating selection", async () => {
    const onChange = vi.fn();
    const view = render(
      <PropertyOptionPicker
        label="Tags"
        mode="multiple"
        options={options}
        selectedIds={["one", "two"]}
        onSelectedIdsChange={onChange}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Tags" }));
      await Promise.resolve();
    });
    const input = view.getByRole("combobox", { name: "Search Tags options" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Home" });
      fireEvent.keyDown(input, { key: "End" });
      fireEvent.keyDown(input, { key: "Backspace" });
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith(["one"]);

    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });
    expect(view.queryByRole("combobox", { name: "Search Tags options" })).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("closes a single picker without re-emitting its current selection", async () => {
    const onChange = vi.fn();
    const view = render(
      <PropertyOptionPicker
        label="Status"
        mode="single"
        options={options}
        selectedIds={["one"]}
        allowClear={false}
        onSelectedIdsChange={onChange}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Status" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Needs review" }));
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(view.queryByRole("combobox", { name: "Search Status options" })).toBeNull();
  });

  test("keeps a multi picker open while one patch is pending and resumes afterward", async () => {
    const onChange = vi.fn();
    const props = {
      label: "Tags",
      mode: "multiple" as const,
      options,
      disabled: false,
      onSelectedIdsChange: onChange,
    };
    const view = render(<PropertyOptionPicker {...props} selectedIds={[]} />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Tags" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Needs review" }));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith(["one"]);

    view.rerender(<PropertyOptionPicker {...props} selectedIds={["one"]} pending />);
    expect(
      (
        view.getByRole("combobox", {
          name: "Search Tags options",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    view.rerender(<PropertyOptionPicker {...props} selectedIds={["one"]} />);
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Ready" }));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenLastCalledWith(["one", "two"]);
    expect(view.getByRole("combobox", { name: "Search Tags options" })).toBeTruthy();
  });

  test("closes an already-open picker when it becomes read-only", async () => {
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    const view = render(
      <PropertyOptionPicker
        label="Tags"
        mode="multiple"
        options={options}
        selectedIds={[]}
        onOpenChange={onOpenChange}
        onSelectedIdsChange={onChange}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Tags" }));
      await Promise.resolve();
    });
    view.rerender(
      <PropertyOptionPicker
        label="Tags"
        mode="multiple"
        options={options}
        selectedIds={[]}
        disabled
        onOpenChange={onOpenChange}
        onSelectedIdsChange={onChange}
      />,
    );
    expect(view.queryByRole("combobox", { name: "Search Tags options" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onOpenChange.mock.calls.map(([open]) => open)).toEqual([true, false]);
  });

  test("requests the next option window without closing the picker", async () => {
    const onLoadMore = vi.fn();
    const view = render(
      <PropertyOptionPicker
        label="Tags"
        mode="multiple"
        options={options}
        selectedIds={[]}
        hasMore
        onLoadMore={onLoadMore}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Tags" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load more" }));
      await Promise.resolve();
    });
    expect(onLoadMore).toHaveBeenCalledOnce();
    expect(view.getByRole("combobox", { name: "Search Tags options" })).toBeTruthy();
  });

  test("requests refreshed authority when an open picker returns to loading", async () => {
    const onOpen = vi.fn();
    const props = {
      label: "Tags",
      mode: "multiple" as const,
      options,
      selectedIds: [] as readonly string[],
      onOpen,
      onSelectedIdsChange: vi.fn(),
    };
    const view = render(<PropertyOptionPicker {...props} />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Tags" }));
      await Promise.resolve();
    });
    expect(onOpen).toHaveBeenCalledOnce();
    view.rerender(<PropertyOptionPicker {...props} loading />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(view.getByRole("combobox", { name: "Search Tags options" })).toBeTruthy();
  });

  test("hides option mutation details behind actionable local feedback", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(
      <PropertyOptionPicker
        label="Tags"
        mode="multiple"
        options={[]}
        selectedIds={[]}
        allowCreate
        onSelectedIdsChange={vi.fn()}
        onCreateOption={() => Promise.reject(new Error("databaseApplyV2 leaked detail"))}
      />,
    );
    try {
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit Tags" }));
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.change(view.getByRole("combobox", { name: "Search Tags options" }), {
          target: { value: "Research" },
        });
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Create “Research”" }));
        await Promise.resolve();
      });
      expect(await view.findByText("Couldn’t create option. Try again.")).toBeTruthy();
      expect(view.queryByText(/databaseApplyV2/)).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("offers an in-popover retry when the option registry fails", async () => {
    const onOpen = vi.fn();
    const view = render(
      <PropertyOptionPicker
        label="Tags"
        mode="multiple"
        options={[]}
        selectedIds={[]}
        registryError
        onOpen={onOpen}
        onSelectedIdsChange={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Tags" }));
      await Promise.resolve();
    });
    expect(onOpen).toHaveBeenCalledOnce();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Couldn’t load options. Retry" }));
      await Promise.resolve();
    });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  test("keeps cached options usable while a failed registry can be retried", async () => {
    const onOpen = vi.fn();
    const onSelectedIdsChange = vi.fn();
    const view = render(
      <PropertyOptionPicker
        label="Status"
        mode="single"
        options={[{ id: "ready", name: "Ready" }]}
        selectedIds={[]}
        registryError
        onOpen={onOpen}
        onSelectedIdsChange={onSelectedIdsChange}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Status" }));
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Couldn’t load options. Retry" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Ready" }));
      await Promise.resolve();
    });
    expect(onSelectedIdsChange).toHaveBeenCalledWith(["ready"]);
  });
});
