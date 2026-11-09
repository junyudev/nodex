import { fireEvent, waitFor } from "@testing-library/react";
import { act, useState, type ComponentProps } from "react";
import { describe, expect, test, vi } from "vite-plus/test";

import { render } from "@/test/dom";
import {
  NodexContextMenuContent,
  NodexContextMenuPortal,
  NodexContextMenuRoot,
  NodexContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { DatabasePropertyValueType } from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { testPropertySemantics } from "../../../shared/testing/database-property-record";
import type { DataSourcePropertyEditorBinding } from "./data-source-property-editor-binding";
import { DataSourcePagePropertyContextMenuItems } from "./data-source-page-property-context-menu";
import { dataSourcePagePropertyMenuSourceFromBindings } from "./data-source-page-property-menu-source";
import type { DataSourcePagePropertyMenuSource } from "./data-source-page-property-menu-source";
import type { DatePropertyEditor } from "./date-property-editor";
import type { RelationPropertyEditor } from "./relation-property-editor";

type DatePropertyEditorAdapterProps = Pick<
  ComponentProps<typeof DatePropertyEditor>,
  "host" | "label"
>;
type RelationPropertyEditorAdapterProps = Pick<
  ComponentProps<typeof RelationPropertyEditor>,
  "host" | "label"
>;

vi.mock("./date-property-editor", () => ({
  DatePropertyEditor: ({ host, label }: DatePropertyEditorAdapterProps) => (
    <input aria-label={`${label} date`} data-property-editor-host={host} />
  ),
}));

vi.mock("./relation-property-editor", () => ({
  RelationPropertyEditor: ({ host, label }: RelationPropertyEditorAdapterProps) => (
    <input
      role="combobox"
      aria-label={`Search ${label} target pages`}
      data-property-editor-host={host}
    />
  ),
}));

const property = (
  propertyId: string,
  name: string,
  valueType: DatabasePropertyValueType,
): DataSourcePropertyRecordV2 =>
  ({
    propertyId,
    dataSourceId: "source-1",
    name,
    valueType,
    ...testPropertySemantics(valueType, 2),
    config: {},
    rankKey: name,
    lifecycle: "active",
    revision: 1,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  }) as DataSourcePropertyRecordV2;

const EMPTY_PROPERTY_BINDINGS: readonly DataSourcePropertyEditorBinding[] = [];

function Harness({
  bindings = EMPTY_PROPERTY_BINDINGS,
  source,
  groupingPropertyId = null,
  query = "",
}: {
  readonly bindings?: readonly DataSourcePropertyEditorBinding[];
  readonly source?: DataSourcePagePropertyMenuSource;
  readonly groupingPropertyId?: string | null;
  readonly query?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <NodexContextMenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
      <NodexContextMenuTrigger>
        <button type="button">Page row</button>
      </NodexContextMenuTrigger>
      <NodexContextMenuPortal>
        <NodexContextMenuContent>
          <DataSourcePagePropertyContextMenuItems
            source={source ?? dataSourcePagePropertyMenuSourceFromBindings(bindings)}
            groupingPropertyId={groupingPropertyId}
            query={query}
            onContextMenuCommit={() => setMenuOpen(false)}
          />
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
    </NodexContextMenuRoot>
  );
}

const openMenu = async (trigger: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.contextMenu(trigger, { clientX: 120, clientY: 80 });
    await Promise.resolve();
  });
};

describe("DataSourcePagePropertyContextMenuItems", () => {
  test("resolves only the Property submenu that actually opens", async () => {
    const statusBinding: DataSourcePropertyEditorBinding = {
      property: property("status", "Status", "select"),
      value: "ready",
      revision: 1,
      disabled: false,
      options: [
        { id: "ready", name: "Ready", color: "blue" },
        { id: "done", name: "Done", color: "green" },
      ],
      optionRegistryState: "ready",
      onChange: vi.fn(),
    };
    const resolveBinding = vi.fn(() => statusBinding);
    const source: DataSourcePagePropertyMenuSource = {
      descriptors: [
        {
          property: statusBinding.property,
          disabled: false,
          pending: false,
        },
      ],
      resolveBinding,
    };
    const view = render(<Harness source={source} groupingPropertyId="status" />);

    await openMenu(view.getByRole("button", { name: "Page row" }));
    expect(resolveBinding).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.pointerMove(view.getByRole("menuitem", { name: "Status" }), {
        pointerType: "mouse",
      });
      await Promise.resolve();
    });

    await view.findByRole("option", { name: "Done" });
    expect(resolveBinding).toHaveBeenCalledTimes(1);
    expect(resolveBinding).toHaveBeenCalledWith("status");
  });

  test("hosts the shared semantic Status picker in a submenu and commits its option", async () => {
    const onChange = vi.fn();
    const view = render(
      <Harness
        bindings={[
          {
            property: property("status", "Status", "select"),
            value: "ready",
            revision: 1,
            disabled: false,
            options: [
              { id: "ready", name: "Ready", color: "blue" },
              { id: "done", name: "Done", color: "green" },
            ],
            optionRegistryState: "ready",
            onChange,
          },
        ]}
        groupingPropertyId="status"
      />,
    );

    await openMenu(view.getByRole("button", { name: "Page row" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Status" }));
      await Promise.resolve();
    });

    const done = await view.findByRole("option", { name: "Done" });
    expect(view.getByRole("combobox", { name: "Search Status options" })).toBeTruthy();
    expect(view.queryByRole("option", { name: "Clear value" })).toBeNull();
    await act(async () => {
      fireEvent.click(done);
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledWith("done");
    await waitFor(() => expect(view.queryByRole("option", { name: "Done" })).toBeNull());
    expect(view.queryByRole("menuitem", { name: "Status" })).toBeNull();
  });

  test("hosts the shared Tags picker in a submenu and keeps multi-select open", async () => {
    const onPatchOptions = vi.fn();
    const onCreateOption = vi.fn(async () => undefined);
    const view = render(
      <Harness
        bindings={[
          {
            property: property("tags", "Tags", "multi_select"),
            value: ["one"],
            revision: 1,
            disabled: false,
            options: [
              { id: "one", name: "Research", color: "orange" },
              { id: "two", name: "Design", color: "purple" },
            ],
            optionRegistryState: "ready",
            onChange: vi.fn(),
            onPatchOptions,
            onCreateOption,
          },
        ]}
      />,
    );

    await openMenu(view.getByRole("button", { name: "Page row" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Tags" }));
      await Promise.resolve();
    });
    const design = await view.findByRole("option", { name: "Design" });
    await act(async () => {
      fireEvent.click(design);
      await Promise.resolve();
    });

    expect(onPatchOptions).toHaveBeenCalledWith({
      addOptionIds: ["two"],
      removeOptionIds: [],
    });
    expect(view.getByRole("combobox", { name: "Search Tags options" })).toBeTruthy();
    await act(async () => {
      fireEvent.change(view.getByRole("combobox", { name: "Search Tags options" }), {
        target: { value: "Context created" },
      });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create “Context created”" }));
      await Promise.resolve();
    });
    expect(onCreateOption).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Context created",
      }),
    );
    expect(view.getByRole("combobox", { name: "Search Tags options" })).toBeTruthy();
  });

  test("edits a text Property with the compact scalar submenu", async () => {
    const onChange = vi.fn();
    const view = render(
      <Harness
        bindings={[
          {
            property: property("p_NOTES001", "Notes", "text"),
            value: "Sam",
            revision: 1,
            disabled: false,
            onChange,
          },
        ]}
      />,
    );

    await openMenu(view.getByRole("button", { name: "Page row" }));
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "More properties…" }));
      await Promise.resolve();
    });
    const notesOption = await view.findByRole("menuitem", { name: "Notes" });
    await act(async () => {
      fireEvent.click(notesOption);
      await Promise.resolve();
    });
    const input = await view.findByRole("textbox", { name: "Notes value" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "Alex" } });
      fireEvent.click(view.getByRole("menuitem", { name: "Save" }));
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenCalledWith("Alex");
  });

  test("opens Date and Relation editor content without nested Empty triggers", async () => {
    const dateView = render(
      <Harness
        bindings={[
          {
            property: property("due_date", "Due date", "date"),
            value: null,
            revision: 1,
            disabled: false,
            onChange: vi.fn(),
          },
        ]}
      />,
    );

    await openMenu(dateView.getByRole("button", { name: "Page row" }));
    await act(async () => {
      fireEvent.click(dateView.getByRole("menuitem", { name: "Due date" }));
      await Promise.resolve();
    });
    const dateEditor = await dateView.findByRole("textbox", { name: "Due date date" });
    expect(dateEditor.getAttribute("data-property-editor-host")).toBe("embedded");
    expect(dateView.queryByRole("button", { name: "Edit Due date" })).toBeNull();
    expect(dateView.queryByText("Empty", { exact: true })).toBeNull();
    dateView.unmount();

    const relationView = render(
      <Harness
        query="related"
        bindings={[
          {
            property: property("related", "Related", "relation"),
            value: null,
            revision: 1,
            disabled: false,
            onChange: vi.fn(),
          },
        ]}
      />,
    );
    await openMenu(relationView.getByRole("button", { name: "Page row" }));
    await act(async () => {
      fireEvent.click(relationView.getByRole("menuitem", { name: "Related" }));
      await Promise.resolve();
    });
    const relationEditor = await relationView.findByRole("combobox", {
      name: "Search Related target pages",
    });
    expect(relationEditor.getAttribute("data-property-editor-host")).toBe("embedded");
    expect(relationView.queryByRole("button", { name: "Edit Related relation" })).toBeNull();
    expect(relationView.queryByText("Empty", { exact: true })).toBeNull();
  });

  test("search exposes a custom Property without the overflow hop", async () => {
    const customer = property("p_customer", "Customer success", "text");
    const view = render(
      <Harness
        query="success"
        bindings={[
          {
            property: customer,
            value: null,
            revision: 1,
            disabled: false,
            onChange: vi.fn(),
          },
        ]}
      />,
    );

    await openMenu(view.getByRole("button", { name: "Page row" }));
    const item = view.getByRole("menuitem", { name: "Customer success" });
    expect(item).toBeTruthy();
    expect(view.queryByRole("menuitem", { name: /More properties/ })).toBeNull();
    await act(async () => {
      fireEvent.click(item);
      await Promise.resolve();
    });
    expect(await view.findByRole("textbox", { name: "Customer success value" })).toBeTruthy();
  });
});
