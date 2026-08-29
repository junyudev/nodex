import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import type { DatabaseViewReadModel } from "../../../shared/database-views";
import { AUTHORIZED_READ_STAMP_EXAMPLE } from "../../../shared/testing/authorized-read-stamp-example";
import type { DatabasePageSummary } from "@/lib/types";
import { BlockDisclosureStateStore } from "@/lib/block-disclosure-state";
import { ReferenceSurfaceActivationBudget } from "@/lib/reference-surface-state";
import { render } from "@/test/dom";
import { DatabaseViewReferenceSurface } from "./reference-block-surfaces";

const makeCard = (id: string, title: string): DatabasePageSummary => ({
  id,
  pageKey: null,
  status: "build",
  archived: false,
  title,
  richTitle: plainTextToPortableRichText(title),
  priority: "p1-high",
  estimate: "m",
  tags: [],
  created: new Date("2026-01-01T00:00:00.000Z"),
  order: 0,
  descriptionPreview: "",
  descriptionLength: 0,
  hasDescription: false,
});

describe("DatabaseViewReferenceSurface", () => {
  test("preserves Library access when a referenced Page opens", () => {
    const card = makeCard("card-a", "Card A");
    const opened: unknown[] = [];
    const model: DatabaseViewReadModel = {
      libraryId: "library:test",
      storeEpoch: "epoch:test",
      commitSeq: 1,
      authorization: AUTHORIZED_READ_STAMP_EXAMPLE,
      dataSourceId: "data-source:test",
      view: {
        id: "library-view",
        databaseBlockId: "database-1",
        projectId: null,
        name: "Library view",
        layout: "list",
        config: {},
        isPrimary: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      rows: [{ page: card, groupKey: null, subgroupKey: null, rankKey: "a" }],
    };
    const view = render(
      <DatabaseViewReferenceSurface
        referenceKey="library-view"
        displayHint=""
        model={model}
        accessContext={{ kind: "library" }}
        onOpenPage={(input) => {
          opened.push(input);
        }}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "Open Card A" }));

    expect(opened).toEqual([
      {
        accessContext: { kind: "library" },
        pageId: "card-a",
        titleSnapshot: "Card A",
      },
    ]);
  });

  test("does not mount a Database row that closes an ancestor Card cycle", () => {
    const card = makeCard("card-a", "Card A");
    const model: DatabaseViewReadModel = {
      libraryId: "library:test",
      storeEpoch: "epoch:test",
      commitSeq: 1,
      authorization: AUTHORIZED_READ_STAMP_EXAMPLE,
      dataSourceId: "data-source:test",
      view: {
        id: "cycle-view",
        databaseBlockId: "database-1",
        projectId: "database-project",
        name: "Cycle view",
        layout: "list",
        config: {},
        isPrimary: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      rows: [{ page: card, groupKey: "triage", subgroupKey: null, rankKey: "a" }],
    };
    const view = render(
      <DatabaseViewReferenceSurface
        referenceKey="card-b-view"
        displayHint=""
        model={model}
        hostPageId="card-b"
        ancestorPageIds={["card-a", "card-b"]}
        visibilityOverride
        renderDocument={() => <div>Must not mount</div>}
      />,
    );

    expect(
      (view.getByRole("button", { name: "Expand Card A" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(view.getByText("Cycle").textContent).toBe("Cycle");
  });

  test("bounds simultaneous referenced Card providers across a large expanded view", async () => {
    const cards = [
      makeCard("card-1", "Card One"),
      makeCard("card-2", "Card Two"),
      makeCard("card-3", "Card Three"),
      makeCard("card-4", "Card Four"),
    ];
    const model: DatabaseViewReadModel = {
      libraryId: "library:test",
      storeEpoch: "epoch:test",
      commitSeq: 1,
      authorization: AUTHORIZED_READ_STAMP_EXAMPLE,
      dataSourceId: "data-source:test",
      view: {
        id: "view-1",
        databaseBlockId: "database-1",
        projectId: "database-project",
        name: "Focused work",
        layout: "list",
        config: {},
        isPrimary: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      rows: cards.map((card, index) => ({
        page: card,
        groupKey: null,
        subgroupKey: null,
        rankKey: String(index),
      })),
    };
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(2);
    const view = render(
      <DatabaseViewReferenceSurface
        referenceKey="host:view-1"
        displayHint=""
        model={model}
        disclosureStore={disclosureStore}
        activationBudget={activationBudget}
        visibilityOverride
        renderDocument={({ accessContext, card }) => (
          <div data-testid="database-row-document">
            {accessContext.kind === "project" ? accessContext.projectId : "library"}:{card.id}
          </div>
        )}
      />,
    );

    await act(async () => {
      for (const card of cards) {
        fireEvent.click(view.getByRole("button", { name: `Expand ${card.title}` }));
        await Promise.resolve();
      }
    });
    await waitFor(() => {
      expect(view.getAllByTestId("database-row-document").length).toBe(2);
    });
    const activeText = view
      .getAllByTestId("database-row-document")
      .map((element) => element.textContent)
      .join(",");
    expect(activeText.includes("database-project:card-3")).toBe(true);
    expect(activeText.includes("database-project:card-4")).toBe(true);
    expect(activeText.includes("card-1")).toBe(false);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Collapse Card Four" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      const resumedText = view
        .getAllByTestId("database-row-document")
        .map((element) => element.textContent)
        .join(",");
      expect(resumedText.includes("database-project:card-2")).toBe(true);
      expect(resumedText.includes("database-project:card-3")).toBe(true);
    });
  });

  test("keeps the focused inline editor resident when a newer row activates", async () => {
    const cards = [
      makeCard("focus-1", "Focus One"),
      makeCard("focus-2", "Focus Two"),
      makeCard("focus-3", "Focus Three"),
    ];
    const model: DatabaseViewReadModel = {
      libraryId: "library:test",
      storeEpoch: "epoch:test",
      commitSeq: 1,
      authorization: AUTHORIZED_READ_STAMP_EXAMPLE,
      dataSourceId: "data-source:test",
      view: {
        id: "focus-view",
        databaseBlockId: "database-1",
        projectId: "database-project",
        name: "Focus order",
        layout: "list",
        config: {},
        isPrimary: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      rows: cards.map((card, index) => ({
        page: card,
        groupKey: null,
        subgroupKey: null,
        rankKey: String(index),
      })),
    };
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(2);
    const view = render(
      <DatabaseViewReferenceSurface
        referenceKey="focus-view"
        displayHint=""
        model={model}
        disclosureStore={disclosureStore}
        activationBudget={activationBudget}
        visibilityOverride
        renderDocument={({ card }) => (
          <input data-testid={`focus-${card.id}`} defaultValue={card.title} />
        )}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Expand Focus One" }));
      fireEvent.click(view.getByRole("button", { name: "Expand Focus Two" }));
      await Promise.resolve();
    });
    fireEvent.focus(view.getByTestId("focus-focus-1"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Expand Focus Three" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.queryByTestId("focus-focus-1") === null).toBe(false);
      expect(view.queryByTestId("focus-focus-2") === null).toBe(true);
      expect(view.queryByTestId("focus-focus-3") === null).toBe(false);
    });
  });
});
