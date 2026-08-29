import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { DatabaseViewReadModel } from "../../../../shared/database-views";
import { plainTextToPortableRichText } from "../../../../shared/block-documents";
import { AUTHORIZED_READ_STAMP_EXAMPLE } from "../../../../shared/testing/authorized-read-stamp-example";
import type { DatabasePageSummary } from "@/lib/types";
import { DatabaseViewReferenceSurface } from "@/components/block-documents/reference-block-surfaces";
import { BlockDisclosureStateStore } from "@/lib/block-disclosure-state";
import { ReferenceSurfaceActivationBudget } from "@/lib/reference-surface-state";

const makeCard = (
  id: string,
  title: string,
  status: DatabasePageSummary["status"],
): DatabasePageSummary => ({
  id,
  pageKey: null,
  status,
  archived: false,
  title,
  richTitle: plainTextToPortableRichText(title),
  priority: "p2-medium",
  estimate: "s",
  tags: [],
  created: new Date("2026-01-01T00:00:00.000Z"),
  order: 0,
  descriptionPreview: "",
  descriptionLength: 0,
  hasDescription: false,
});

const VIEW: DatabaseViewReadModel = {
  libraryId: "library:test",
  storeEpoch: "epoch:test",
  commitSeq: 1,
  authorization: AUTHORIZED_READ_STAMP_EXAMPLE,
  dataSourceId: "data-source:test",
  view: {
    id: "database-view:inline:story",
    databaseBlockId: "database:primary",
    projectId: "nodex",
    name: "Block-first migration",
    layout: "list",
    config: {},
    isPrimary: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  rows: [
    makeCard("bf-05", "Retire foreign-body projections", "build"),
    makeCard("bf-06", "Make cross-document moves atomic", "plan"),
    makeCard("bf-07", "Cut history and search over", "plan"),
    makeCard("bf-08", "Generalize durable Database views", "triage"),
    makeCard("bf-09", "Add document-bearing Block types", "triage"),
  ].map((card, index) => ({
    page: card,
    groupKey: null,
    subgroupKey: null,
    rankKey: String(index),
  })),
};

function DatabaseViewReferenceStory() {
  const [disclosureStore] = useState(() => new BlockDisclosureStateStore());
  const [activationBudget] = useState(() => new ReferenceSurfaceActivationBudget(2));
  return (
    <main className="min-h-screen bg-token-bg-primary p-8 text-token-text-primary">
      <div className="mx-auto max-w-3xl">
        <p className="mb-3 text-xs text-token-description-foreground">
          Durable Database View · two-editor activation budget in this fixture
        </p>
        <DatabaseViewReferenceSurface
          referenceKey="story:database-view"
          displayHint=""
          model={VIEW}
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
          visibilityOverride
          onOpenPage={() => undefined}
          renderDocument={({ card }) => (
            <div className="py-2 text-sm text-token-text-secondary">
              Independent Y.Doc surface for {card.title}
            </div>
          )}
        />
      </div>
    </main>
  );
}

const meta = {
  title: "Board/Block References/Database View",
  parameters: { layout: "fullscreen" },
  render: () => <DatabaseViewReferenceStory />,
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
