import { fireEvent, waitFor } from "@testing-library/react";
import { act, useState } from "react";
import { describe, expect, test, vi } from "vite-plus/test";

import { render, settleAsyncRender } from "@/test/dom";
import { NodexDropdownButtonTrigger, NodexOptionPicker } from "./dropdown";

const trigger = (label: string) => (
  <NodexDropdownButtonTrigger aria-label={label}>Select</NodexDropdownButtonTrigger>
);

describe("NodexOptionPicker", () => {
  test("keeps bounded enum choices compact and selection-only", async () => {
    const onValueChange = vi.fn();
    const view = render(
      <NodexOptionPicker
        value="asc"
        options={[
          { value: "asc", label: "Ascending" },
          { value: "desc", label: "Descending" },
        ]}
        onValueChange={onValueChange}
        triggerButton={trigger("Change direction")}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Change direction" }));
      await settleAsyncRender();
    });

    expect(view.queryByRole("combobox")).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Descending" }));
      await Promise.resolve();
    });
    expect(onValueChange).toHaveBeenCalledWith("desc");
  });

  test("filters data-driven options and resets the query after closing", async () => {
    const onValueChange = vi.fn();
    const view = render(
      <NodexOptionPicker
        value="nodex"
        search="filter"
        searchPlaceholder="Search projects…"
        searchAriaLabel="Search projects"
        options={[
          { value: "nodex", label: "Nodex" },
          { value: "bundle", label: "Readable bundle" },
          {
            value: "frontier",
            label: <span>Frontier agent</span>,
            searchText: "GPT 5.6 Codex",
          },
        ]}
        onValueChange={onValueChange}
        triggerButton={trigger("Change project")}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Change project" }));
      await settleAsyncRender();
    });
    const search = view.getByRole("combobox", { name: "Search projects" });
    await waitFor(() => expect(document.activeElement).toBe(search));

    await act(async () => {
      fireEvent.change(search, { target: { value: "5.6 codex" } });
      await Promise.resolve();
    });
    expect(view.queryByRole("option", { name: "Nodex" })).toBeNull();
    expect(view.getByRole("option", { name: "Frontier agent" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Frontier agent" }));
      await Promise.resolve();
    });
    expect(onValueChange).toHaveBeenCalledWith("frontier");
    expect(view.queryByRole("combobox", { name: "Search projects" })).toBeNull();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Change project" }));
      await settleAsyncRender();
    });
    const reopenedSearch = view.getByRole("combobox", {
      name: "Search projects",
    }) as HTMLInputElement;
    expect(reopenedSearch.value).toBe("");
  });

  test("supports query-fresh keyboard acceptance and list navigation", async () => {
    const onValueChange = vi.fn();
    const view = render(
      <NodexOptionPicker
        value="plan"
        search="filter"
        searchAriaLabel="Search statuses"
        options={[
          { value: "plan", label: "Plan" },
          { value: "build", label: "Build" },
          { value: "review", label: "Review" },
        ]}
        onValueChange={onValueChange}
        triggerButton={trigger("Change status")}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Change status" }));
      await settleAsyncRender();
    });
    const search = view.getByRole("combobox", { name: "Search statuses" });
    await act(async () => {
      fireEvent.keyDown(search, { key: "ArrowDown" });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(view.getByRole("option", { name: "Plan" }));

    await act(async () => {
      search.focus();
      fireEvent.change(search, { target: { value: "review" } });
      fireEvent.keyDown(search, { key: "Enter" });
      await Promise.resolve();
    });
    expect(onValueChange).toHaveBeenCalledWith("review");
    expect(view.queryByRole("combobox", { name: "Search statuses" })).toBeNull();
  });

  test("an owner that closes the picker also clears its query", async () => {
    function OwnedPicker() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <NodexOptionPicker
            value="nodex"
            search="filter"
            searchAriaLabel="Search projects"
            open={open}
            onOpenChange={setOpen}
            options={[{ value: "nodex", label: "Nodex" }]}
            onValueChange={() => {}}
            triggerButton={trigger("Change project")}
          />
          <button type="button" onClick={() => setOpen((current) => !current)}>
            Toggle from owner
          </button>
        </>
      );
    }
    const view = render(<OwnedPicker />);
    const search = await view.findByRole("combobox", { name: "Search projects" });
    await act(async () => {
      fireEvent.change(search, { target: { value: "missing" } });
      await Promise.resolve();
    });
    expect(view.getByText("No matching options")).toBeTruthy();
    for (let toggle = 0; toggle < 2; toggle += 1)
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Toggle from owner", hidden: true }));
        await settleAsyncRender();
      });
    const reopened = view.getByRole("combobox", { name: "Search projects" }) as HTMLInputElement;
    expect(reopened.value).toBe("");
    expect(view.getByRole("option", { name: "Nodex" })).toBeTruthy();
  });
});
