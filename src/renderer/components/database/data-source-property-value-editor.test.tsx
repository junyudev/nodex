import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render, settleAsyncRender, settleLazyRender } from "@/test/dom";
import { parseDataSourceId, parseDataSourcePropertyId } from "../../../shared/database-identities";
import { testPropertySemantics } from "../../../shared/testing/database-property-record";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import type { DatabasePropertyValueType } from "../../../shared/database-kernel";
import { DataSourcePropertyValueEditor } from "./data-source-property-value-editor";

const statusProperty: DataSourcePropertyRecordV2 = {
  propertyId: parseDataSourcePropertyId("status"),
  dataSourceId: parseDataSourceId("source-1"),
  name: "Workflow",
  ...testPropertySemantics("select"),
  valueType: "select",
  config: {},
  optionCount: 5,
  rankKey: "a",
  lifecycle: "active",
  revision: 2,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

function emptyEditorProps(valueType: DatabasePropertyValueType, id = "p_property") {
  return {
    property: {
      ...statusProperty,
      ...testPropertySemantics(valueType),
      propertyId: parseDataSourcePropertyId(id),
      valueType,
    },
    value: null,
    revision: 1,
    disabled: false,
    onChange: vi.fn(),
  };
}

describe("DataSourcePropertyValueEditor", () => {
  const popoverCases = [
    { id: "status", valueType: "select", role: "combobox", name: "Search Workflow options" },
    { id: "p_select__", valueType: "select", role: "combobox", name: "Search Workflow options" },
    {
      id: "p_multi___",
      valueType: "multi_select",
      role: "combobox",
      name: "Search Workflow options",
    },
    {
      id: "p_relation",
      valueType: "relation",
      role: "combobox",
      name: "Search Workflow target pages",
    },
    { id: "p_date____", valueType: "date", role: "textbox", name: "Workflow date" },
    { id: "p_datetime", valueType: "datetime", role: "textbox", name: "Workflow date" },
  ] as const;

  test.each(popoverCases)(
    "$id opens with focus once and closes normally",
    async ({ id, valueType, role, name }) => {
      const props = emptyEditorProps(valueType, id);
      const view = render(<DataSourcePropertyValueEditor {...props} openOnMount />);
      const trigger = view.getByRole("button", { name: /^Edit Workflow/ });
      await settleLazyRender();
      const input = await view.findByRole(role, { name });
      await waitFor(() => expect(document.activeElement).toBe(input));
      await act(async () => {
        fireEvent.keyDown(input, { key: "Escape" });
      });
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      view.rerender(<DataSourcePropertyValueEditor {...props} revision={2} openOnMount />);
      await settleAsyncRender();
      expect(view.queryByRole(role, { name })).toBeNull();
    },
  );

  test.each(popoverCases)(
    "$id stays closed when mount opening is absent or unavailable",
    async ({ id, valueType, role, name }) => {
      const props = emptyEditorProps(valueType, id);
      const view = render(
        <>
          <DataSourcePropertyValueEditor {...props} />
          <DataSourcePropertyValueEditor {...props} openOnMount disabled />
          <DataSourcePropertyValueEditor {...props} openOnMount pending />
        </>,
      );
      await settleAsyncRender();
      expect(view.queryByRole(role, { name })).toBeNull();
      view.rerender(
        <>
          <DataSourcePropertyValueEditor {...props} openOnMount />
          <DataSourcePropertyValueEditor {...props} openOnMount />
          <DataSourcePropertyValueEditor {...props} openOnMount />
        </>,
      );
      await settleAsyncRender();
      expect(view.queryByRole(role, { name })).toBeNull();
    },
  );

  test.each([
    { valueType: "text", role: "textbox", presentation: "page" },
    { valueType: "number", role: "textbox", presentation: "page" },
    { valueType: "checkbox", role: "checkbox", presentation: "page" },
    { valueType: "checkbox", role: "checkbox", presentation: "board" },
  ] as const)(
    "$presentation $valueType focuses only on an eligible mount",
    async ({ valueType, role, presentation }) => {
      const props = { ...emptyEditorProps(valueType), presentation };
      const view = render(
        <>
          <DataSourcePropertyValueEditor key="requested" {...props} openOnMount />
          <DataSourcePropertyValueEditor key="default" {...props} />
          <DataSourcePropertyValueEditor key="disabled" {...props} openOnMount disabled />
          <DataSourcePropertyValueEditor key="pending" {...props} openOnMount pending />
          <DataSourcePropertyValueEditor
            key="embedded"
            {...props}
            openOnMount
            overlayHost="embedded"
          />
          <button type="button">Elsewhere</button>
        </>,
      );
      const [input] = view.getAllByRole(role, { name: /^Workflow value/ });
      expect(document.activeElement).toBe(input);
      const elsewhere = view.getByRole("button", { name: "Elsewhere" });
      await act(async () => {
        elsewhere.focus();
      });
      view.rerender(
        <>
          <DataSourcePropertyValueEditor key="requested" {...props} openOnMount />
          <DataSourcePropertyValueEditor key="default" {...props} openOnMount />
          <DataSourcePropertyValueEditor key="disabled" {...props} openOnMount />
          <DataSourcePropertyValueEditor key="pending" {...props} openOnMount />
          <DataSourcePropertyValueEditor key="embedded" {...props} openOnMount />
          <button type="button">Elsewhere</button>
        </>,
      );
      expect(document.activeElement).toBe(elsewhere);
      expect(props.onChange).not.toHaveBeenCalled();
    },
  );

  test("renders Board Priority as an icon-only, value-named trigger", async () => {
    const view = render(
      <DataSourcePropertyValueEditor
        property={{
          ...statusProperty,
          propertyId: parseDataSourcePropertyId("priority"),
          name: "Priority",
        }}
        value="p1-high"
        revision={3}
        disabled={false}
        showLabel={false}
        presentation="board"
        options={[{ id: "p1-high", name: "High" }]}
        onChange={vi.fn()}
      />,
    );

    const trigger = view.getByRole("button", { name: "Edit Priority: High" });
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger.textContent).toBe("");
    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    expect(view.getByRole("option", { name: "High" })).toBeTruthy();
  });

  test("keeps Board checkbox semantics on the chip itself", async () => {
    const onChange = vi.fn();
    const view = render(
      <DataSourcePropertyValueEditor
        property={{
          ...statusProperty,
          propertyId: parseDataSourcePropertyId("p_checkbox"),
          name: "Verified",
          ...testPropertySemantics("checkbox"),
          valueType: "checkbox",
        }}
        value={false}
        revision={1}
        disabled={false}
        showLabel={false}
        presentation="board"
        onChange={onChange}
      />,
    );
    const checkbox = view.getByRole("checkbox", { name: "Verified value: No" });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.click(checkbox);
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test("uses the semantic Status presenter while keeping registry names authoritative", async () => {
    const onChange = vi.fn();
    const view = render(
      <DataSourcePropertyValueEditor
        property={statusProperty}
        value="doing"
        revision={3}
        disabled={false}
        showLabel={false}
        presentation="page"
        options={[
          { id: "doing", name: "In progress" },
          { id: "done", name: "Released" },
        ]}
        onChange={onChange}
      />,
    );
    expect(view.getByText("In progress")).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Workflow" }));
      await Promise.resolve();
    });
    expect(view.queryByRole("option", { name: "Empty" })).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Released" }));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith("done");
  });

  test("uses the shared Empty value for focused semantic Properties", () => {
    const view = render(
      <>
        <DataSourcePropertyValueEditor
          property={{
            ...statusProperty,
            propertyId: parseDataSourcePropertyId("priority"),
            name: "Priority",
          }}
          value={null}
          revision={3}
          disabled={false}
          showLabel={false}
          presentation="page"
          options={[]}
          onChange={vi.fn()}
        />
        <DataSourcePropertyValueEditor
          property={{
            ...statusProperty,
            propertyId: parseDataSourcePropertyId("estimate"),
            name: "Estimate",
          }}
          value={null}
          revision={3}
          disabled={false}
          showLabel={false}
          presentation="page"
          options={[]}
          onChange={vi.fn()}
        />
      </>,
    );
    expect(view.getByRole("button", { name: "Edit Priority" }).textContent).toBe("Empty");
    expect(view.getByRole("button", { name: "Edit Estimate" }).textContent).toBe("Empty");
  });

  test("cancels a scalar draft on Escape instead of committing it on blur", async () => {
    const onChange = vi.fn();
    const property: DataSourcePropertyRecordV2 = {
      ...statusProperty,
      propertyId: parseDataSourcePropertyId("p_0123abcd"),
      name: "Notes",
      ...testPropertySemantics("text"),
      valueType: "text",
      optionCount: 0,
    };
    const view = render(
      <DataSourcePropertyValueEditor
        property={property}
        value="Committed"
        revision={3}
        disabled={false}
        showLabel={false}
        presentation="page"
        onChange={onChange}
      />,
    );
    const input = view.getByRole("textbox", { name: "Notes value" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "Draft" } });
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("Committed");
  });

  test("preserves intentional whitespace in text Property values", async () => {
    const onChange = vi.fn();
    const property: DataSourcePropertyRecordV2 = {
      ...statusProperty,
      propertyId: parseDataSourcePropertyId("p_0123abcd"),
      name: "Notes",
      ...testPropertySemantics("text"),
      valueType: "text",
      optionCount: 0,
    };
    const view = render(
      <DataSourcePropertyValueEditor
        property={property}
        value="Committed"
        revision={3}
        disabled={false}
        showLabel={false}
        presentation="page"
        onChange={onChange}
      />,
    );
    const input = view.getByRole("textbox", { name: "Notes value" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "  keep me  " } });
      fireEvent.blur(input);
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith("  keep me  ");
  });

  test("does not commit a scalar draft after the host makes it busy", async () => {
    const onChange = vi.fn();
    const property: DataSourcePropertyRecordV2 = {
      ...statusProperty,
      propertyId: parseDataSourcePropertyId("p_0123abcd"),
      name: "Notes",
      ...testPropertySemantics("text"),
      valueType: "text",
      optionCount: 0,
    };
    const props = {
      property,
      value: "Committed",
      revision: 3,
      disabled: false,
      showLabel: false,
      presentation: "page" as const,
      onChange,
    };
    const view = render(<DataSourcePropertyValueEditor {...props} />);
    const input = view.getByRole("textbox", { name: "Notes value" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "Stale draft" } });
      view.rerender(<DataSourcePropertyValueEditor {...props} pending />);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.blur(input);
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("replaces a focused scalar draft when its committed revision advances", async () => {
    const onChange = vi.fn();
    const props = {
      property: {
        ...statusProperty,
        propertyId: parseDataSourcePropertyId("p_0123abcd"),
        name: "Notes",
        ...testPropertySemantics("text"),
        valueType: "text" as const,
        optionCount: 0,
      },
      value: "Committed",
      revision: 3,
      disabled: false,
      onChange,
    };
    const view = render(<DataSourcePropertyValueEditor {...props} />);
    const input = view.getByRole("textbox", { name: "Notes value" }) as HTMLInputElement;
    await act(async () => {
      input.focus();
      fireEvent.change(input, { target: { value: "Unsaved draft" } });
      await Promise.resolve();
    });
    view.rerender(<DataSourcePropertyValueEditor {...props} revision={4} />);
    expect(view.getByRole("textbox", { name: "Notes value" })).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Committed");
    await act(async () => {
      fireEvent.blur(input);
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("emits only the user multi-select delta instead of replacing a stale whole set", async () => {
    const onChange = vi.fn();
    const onPatchOptions = vi.fn();
    const property: DataSourcePropertyRecordV2 = {
      ...statusProperty,
      propertyId: parseDataSourcePropertyId("p_0123abcd"),
      name: "Signals",
      ...testPropertySemantics("multi_select"),
      valueType: "multi_select",
      optionCount: 2,
    };
    const view = render(
      <DataSourcePropertyValueEditor
        property={property}
        value={["o_AAAAAAAA"]}
        revision={3}
        disabled={false}
        showLabel={false}
        presentation="page"
        options={[
          { id: "o_AAAAAAAA", name: "Existing" },
          { id: "o_BBBBBBBB", name: "New signal" },
        ]}
        onChange={onChange}
        onPatchOptions={onPatchOptions}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Signals" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "New signal" }));
      await Promise.resolve();
    });
    expect(onPatchOptions).toHaveBeenCalledWith({
      addOptionIds: ["o_BBBBBBBB"],
      removeOptionIds: [],
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("does not offer option creation before all registry windows are loaded", async () => {
    const property: DataSourcePropertyRecordV2 = {
      ...statusProperty,
      propertyId: parseDataSourcePropertyId("p_0123abcd"),
      name: "Signal",
      optionCount: 2,
    };
    const view = render(
      <DataSourcePropertyValueEditor
        property={property}
        value={null}
        revision={3}
        disabled={false}
        showLabel={false}
        presentation="page"
        options={[{ id: "o_AAAAAAAA", name: "Existing" }]}
        optionRegistryState="ready"
        optionRegistryHasMore
        onChange={vi.fn()}
        onCreateOption={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Signal" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.change(view.getByRole("combobox", { name: "Search Signal options" }), {
        target: { value: "New signal" },
      });
      await Promise.resolve();
    });
    expect(view.queryByRole("button", { name: "Create “New signal”" })).toBeNull();
  });

  test("excludes the current Page from the Waits for picker", async () => {
    const onPatchRelation = vi.fn();
    const view = render(
      <DataSourcePropertyValueEditor
        property={{
          ...statusProperty,
          propertyId: parseDataSourcePropertyId("blocked_by"),
          name: "Waits for",
          ...testPropertySemantics("relation"),
          schema: {
            kind: "relation",
            targetDataSourceId: statusProperty.dataSourceId,
            cardinality: "many",
          },
          valueType: "relation",
          optionCount: 0,
        }}
        value={null}
        revision={0}
        disabled={false}
        relationSourcePageId="page:self"
        relationCandidates={[
          { pageId: "page:self", title: "Current task" },
          { pageId: "page:other", title: "Prerequisite" },
        ]}
        onChange={vi.fn()}
        onPatchRelation={onPatchRelation}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Waits for relation" }));
      await Promise.resolve();
    });
    expect(view.queryByRole("option", { name: "Current task" })).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Prerequisite" }));
      await Promise.resolve();
    });
    expect(onPatchRelation).toHaveBeenCalledWith({ addPageIds: ["page:other"], removeEdgeIds: [] });
  });

  test("keeps self-targets available for ordinary self-Relations", async () => {
    const onPatchRelation = vi.fn();
    const property: DataSourcePropertyRecordV2 = {
      ...statusProperty,
      propertyId: parseDataSourcePropertyId("p_0123abcd"),
      name: "Related",
      ...testPropertySemantics("relation"),
      valueType: "relation",
      optionCount: 0,
    };
    const view = render(
      <DataSourcePropertyValueEditor
        property={property}
        value={null}
        revision={1}
        disabled={false}
        showLabel={false}
        presentation="page"
        relationSourcePageId="page:self"
        relationCandidates={[{ pageId: "page:self", title: "Current task" }]}
        onChange={vi.fn()}
        onPatchRelation={onPatchRelation}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Related relation" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Current task" }));
      await Promise.resolve();
    });
    expect(onPatchRelation).toHaveBeenCalledWith({
      addPageIds: ["page:self"],
      removeEdgeIds: [],
    });
  });
});
