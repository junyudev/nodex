import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";
import { RecoveryEntry } from "@/features/document-recovery/recovery-entry";
import { useLibraryMetadata } from "@/lib/use-library-navigation";
import { NodexSettingsPageSurface as SettingsPageSurface } from "../ui/settings";
import { BackupSettingsControl } from "./backup-settings-control";

export function BackupsSettingsPage({ open }: SettingsSectionPageProps) {
  const library = useLibraryMetadata(open);
  return (
    <SettingsPageSurface
      title="Backups"
      subtitle="Snapshot cadence, retention, and restore operations."
    >
      {library.data?.libraryId ? (
        <div className="mb-5">
          <RecoveryEntry
            scope={{ libraryId: library.data.libraryId, routingContext: { kind: "library" } }}
            alwaysVisible
          />
        </div>
      ) : null}
      <BackupSettingsControl open={open} />
    </SettingsPageSurface>
  );
}
