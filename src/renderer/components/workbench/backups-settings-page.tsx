import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import { useDocumentRecovery } from "@/features/document-recovery/recovery-entry";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import { NodexButton } from "../ui/button";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SettingsSection,
} from "../ui/settings";
import { BackupSettingsControl } from "./backup-settings-control";

/** The way back to every Library draft, including ones already resolved. */
function UnsavedEditsRow({ libraryId }: { readonly libraryId: string }) {
  const recovery = useDocumentRecovery({ libraryId, routingContext: { kind: "library" } }, null);
  const count = recovery.state.pendingCount + recovery.state.stagedCount;
  return (
    <SettingRow
      label="Unsaved edits"
      description={
        count > 0
          ? `${count} ${count === 1 ? "draft needs" : "drafts need"} review.`
          : "Edits that couldn’t be saved wait here until you review them."
      }
    >
      <NodexButton variant="outline" size="sm" onClick={() => recovery.review()}>
        Review
      </NodexButton>
    </SettingRow>
  );
}

export function BackupsSettingsPage({ open }: SettingsSectionPageProps) {
  const library = useLibraryMetadata(open);
  return (
    <SettingsPageSurface
      title="Backups"
      subtitle="Snapshot cadence, retention, and restore operations."
    >
      <div className="flex flex-col gap-[var(--padding-panel)]">
        {library.data?.libraryId ? (
          <SettingsSection title="Recovery">
            <UnsavedEditsRow libraryId={library.data.libraryId} />
          </SettingsSection>
        ) : null}
        <BackupSettingsControl open={open} />
      </div>
    </SettingsPageSurface>
  );
}
