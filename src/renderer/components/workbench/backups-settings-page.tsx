import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import { useDocumentRecovery } from "@/features/document-recovery/recovery-entry";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import { NodexButton } from "../ui/button";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
} from "../ui/settings";
import { BackupSettingsControl } from "./backup-settings-control";

/** The way back to every Library draft, including ones already resolved. */
function UnsavedEditsRow({ libraryId }: { readonly libraryId: string }) {
  const intl = useIntl();
  const recovery = useDocumentRecovery({ libraryId, routingContext: { kind: "library" } }, null);
  const count = recovery.state.pendingCount + recovery.state.stagedCount;
  return (
    <SettingRow
      label={intl.formatMessage({
        id: "settings.backups.unsavedEdits",
        defaultMessage: "Unsaved edits",
      })}
      description={
        count > 0
          ? intl.formatMessage(
              {
                id: "settings.backups.draftReviewCount",
                defaultMessage:
                  "{count, plural, one {# draft needs review.} other {# drafts need review.}}",
              },
              { count },
            )
          : intl.formatMessage({
              id: "settings.backups.editsThatCouldntBeSavedWait",
              defaultMessage: "Edits that couldn’t be saved wait here until you review them.",
            })
      }
    >
      <NodexButton variant="outline" size="sm" onClick={() => recovery.review()}>
        {intl.formatMessage({ id: "settings.backups.review2", defaultMessage: "Review" })}
      </NodexButton>
    </SettingRow>
  );
}

export function BackupsSettingsPage({ open }: SettingsSectionPageProps) {
  const intl = useIntl();
  const library = useLibraryMetadata(open);
  return (
    <SettingsPageSurface
      title={intl.formatMessage(settingsMessages.backupsTitle)}
      subtitle={intl.formatMessage(
        settingsMessages.backupsSnapshotCadenceRetentionAndRestoreOperations,
      )}
    >
      <BackupSettingsControl
        open={open}
        recovery={
          library.data?.libraryId ? <UnsavedEditsRow libraryId={library.data.libraryId} /> : null
        }
      />
    </SettingsPageSurface>
  );
}
