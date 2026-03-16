import { describe, expect, mock, test } from "bun:test";
import { render, textContent } from "../../test/dom";

const mockController: Record<string, unknown> = {
  card: { id: "card-1" },
  saving: false,
  historyPanelActive: false,
  limitMainContentWidth: true,
  showRawContent: false,
  handleClose: async () => undefined,
  handleDelete: async () => undefined,
  handleToggleContentWidth: () => undefined,
  handleToggleShowRawContent: () => undefined,
  onOpenHistoryPanel: undefined,
  updateConflict: null,
  scrollContainerRef: { current: null },
  handleScroll: () => undefined,
  contentGutterClassName: "",
  contentShellClassName: "",
  title: "Task",
  handleTitleChange: () => undefined,
  handleTitleBlur: () => undefined,
  priority: undefined,
  estimate: "none",
  dueDate: "",
  currentColumnId: "in_progress",
  currentColumnName: "In progress",
  handlePriorityChange: () => undefined,
  handleEstimateChange: () => undefined,
  handleDueDateChange: () => undefined,
  handleClearDueDate: () => undefined,
  handleSetDueDateToday: () => undefined,
  handleColumnChange: async () => undefined,
  description: "# Raw card\n\n- item",
  handleDescriptionChange: () => undefined,
  handleDescriptionBlur: () => undefined,
};

mock.module("./card-stage/use-card-stage-controller", () => ({
  useCardStageController: () => mockController,
}));

mock.module("./editor/nfm-editor", () => ({
  NfmEditor: () => <div>Mock editor</div>,
}));

mock.module("./card-stage/inline-property-strip", () => ({
  CardStageInlinePropertyStrip: () => <div>Inline property strip</div>,
}));

mock.module("./card-stage/properties-section", () => ({
  CardStagePropertiesSection: () => <div>Properties section</div>,
}));

mock.module("./card-stage/toolbar", () => ({
  CardStageToolbar: () => <div>Toolbar</div>,
}));

describe("card stage", () => {
  test("renders the rich editor when raw mode is disabled", async () => {
    mockController.showRawContent = false;
    const { CardStage } = await import("./card-stage");
    const { getByText, queryByText } = render(
      <CardStage
        onClose={() => undefined}
        card={null}
        columnId="in_progress"
        columnName="In progress"
        projectId="default"
        availableTags={[]}
        onUpdate={async () => ({ status: "updated", card: {} as never })}
        onPatch={() => undefined}
        onDelete={async () => undefined}
        onMove={async () => undefined}
      />,
    );

    expect(getByText("Mock editor").textContent).toBe("Mock editor");
    expect(queryByText("Raw format")).toBe(null);
  });

  test("renders read-only raw content when raw mode is enabled", async () => {
    mockController.showRawContent = true;
    const { CardStage } = await import("./card-stage");
    const { container, getByText, queryByText } = render(
      <CardStage
        onClose={() => undefined}
        card={null}
        columnId="in_progress"
        columnName="In progress"
        projectId="default"
        availableTags={[]}
        onUpdate={async () => ({ status: "updated", card: {} as never })}
        onPatch={() => undefined}
        onDelete={async () => undefined}
        onMove={async () => undefined}
      />,
    );

    expect(getByText("Raw format").textContent).toBe("Raw format");
    expect(getByText("Read-only").textContent).toBe("Read-only");
    expect(queryByText("Mock editor")).toBe(null);
    expect(textContent(container).includes("# Raw card")).toBeTrue();
  });
});
