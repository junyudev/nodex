import type { Meta, StoryObj } from "@storybook/react-vite";
import { LayoutTemplate } from "@/components/shared/icons/generic-icons";
import { RefreshIcon } from "@/components/shared/icons";
import { useState } from "react";
import { DocumentBearingShellVisual } from "./document-bearing-shell-block";
import { BlockDisclosureStateStore } from "@/lib/block-disclosure-state";
import { ReferenceSurfaceActivationBudget } from "@/lib/reference-surface-state";

function InteractiveShells() {
  const [disclosureStore] = useState(() => new BlockDisclosureStateStore());
  const [activationBudget] = useState(() => new ReferenceSurfaceActivationBudget(2));
  const renderDocument = ({ ownerBlockId }: { ownerBlockId: string }) => (
    <div className="py-2 text-sm text-token-text-secondary">
      Editing <span className="font-medium">{ownerBlockId}</span> through its independent
      collaborative Document.
    </div>
  );
  const sharedState = {
    disclosureStore,
    activationBudget,
    visibilityOverride: true,
    renderDocument,
  } as const;

  return (
    <main className="min-h-screen bg-token-bg-primary p-8 text-token-text-primary">
      <div className="mx-auto flex max-w-2xl flex-col gap-1">
        <p className="mb-2 text-xs text-token-description-foreground">
          Expand a shell to mount its independent provider. Collapsed shells retain only stable
          identity in the host Document.
        </p>
        <DocumentBearingShellVisual
          {...sharedState}
          icon={RefreshIcon}
          label="Synced block"
          detail="Shared launch notes"
          identity="synced-source:launch-notes"
          disclosureKey="story:synced"
        />
        <DocumentBearingShellVisual
          {...sharedState}
          icon={LayoutTemplate}
          label="Template"
          detail="Incident review"
          identity="template:incident-review"
          disclosureKey="story:template"
        />
      </div>
    </main>
  );
}

const meta = {
  title: "Board/Document-bearing Blocks/Shells",
  component: DocumentBearingShellVisual,
  parameters: { layout: "fullscreen" },
  render: () => <InteractiveShells />,
} satisfies Meta<typeof DocumentBearingShellVisual>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    icon: RefreshIcon,
    label: "Synced block",
    detail: "Shared launch notes",
  },
};
