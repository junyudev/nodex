import { describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, within } from "@testing-library/react";

import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import type { BoardSummary, DatabasePageSummary, Project } from "@/lib/types";
import { render } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import { PanelDestinationPickerSurface } from "./panel-destination-picker";

const TEST_DATE = new Date("2026-01-01T00:00:00.000Z");

function makeProject(id: string, name: string): Project {
  return {
    id,
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name,
    description: "",
    appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: TEST_DATE,
    updated: TEST_DATE,
  };
}

function makePage(
  id: string,
  pageKey: string,
  title: string,
  status: DatabasePageSummary["status"],
): DatabasePageSummary {
  return {
    id,
    pageKey,
    status,
    archived: false,
    title,
    richTitle: plainTextToPortableRichText(title),
    tags: [],
    created: TEST_DATE,
    order: 0,
    revision: 1,
    descriptionPreview: "",
    descriptionLength: 0,
    hasDescription: false,
  };
}

describe("PanelDestinationPickerSurface", () => {
  test("uses status-led Page rows without repeating Page keys or section Project context", () => {
    const projects = [
      makeProject("current", "Current Project"),
      makeProject("other", "Other Project"),
    ];
    const boardMap = new Map<string, BoardSummary>([
      [
        "current",
        {
          columns: [
            {
              id: "triage",
              name: "Triage",
              cards: [makePage("current-page", "CUR-13", "Current result", "triage")],
            },
          ],
        },
      ],
      [
        "other",
        {
          columns: [
            {
              id: "build",
              name: "Build",
              cards: [makePage("other-page", "OTH-21", "Other result", "build")],
            },
          ],
        },
      ],
    ]);
    const view = render(
      <TestQueryProvider>
        <PanelDestinationPickerSurface
          projects={projects}
          boardMap={boardMap}
          databaseDescriptorMap={new Map()}
          loading={false}
          scope="page-only"
          currentProjectId="current"
          onAccept={() => undefined}
          onClose={() => undefined}
        />
      </TestQueryProvider>,
    );

    const currentSection = view.getByText("Current project").parentElement?.parentElement;
    const otherSection = view.getByText("Other projects").parentElement?.parentElement;
    if (!currentSection || !otherSection) throw new Error("Expected grouped Page sections");

    const currentRow = within(currentSection).getByRole("option", { name: "Current result" });
    expect(currentRow.textContent).toBe("Current result");
    expect(currentRow.querySelector("svg")).not.toBeNull();
    expect(currentRow.querySelector("[title]")).toBeNull();

    const otherRow = within(otherSection).getByRole("option", {
      name: "Other resultOther Project",
    });
    expect(otherRow.textContent).toBe("Other resultOther Project");
    expect(otherRow.querySelector("svg")).not.toBeNull();
    expect(otherRow.querySelector("[title]")).toBeNull();
  });
});

test("composition confirmation does not open a destination", async () => {
  const onAccept = vi.fn();
  const view = render(
    <TestQueryProvider>
      <PanelDestinationPickerSurface
        projects={[makeProject("current", "Current Project")]}
        boardMap={
          new Map([
            [
              "current",
              {
                columns: [
                  {
                    id: "triage",
                    name: "Triage",
                    cards: [makePage("one", "ONE-1", "One", "triage")],
                  },
                ],
              },
            ],
          ])
        }
        databaseDescriptorMap={new Map()}
        loading={false}
        scope="page-only"
        currentProjectId="current"
        onAccept={onAccept}
        onClose={() => undefined}
      />
    </TestQueryProvider>,
  );
  const input = view.getByRole("combobox");
  await act(async () => {
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    await Promise.resolve();
  });
  expect(onAccept).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
  });
  expect(onAccept).toHaveBeenCalledOnce();
});
