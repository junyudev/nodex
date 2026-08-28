import { useQuery } from "@tanstack/react-query";
import { BackIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { LazySourceViewer } from "@/components/ui/lazy-source-viewer";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsSection as SettingsSection,
} from "@/components/ui/settings";
import { queryKeys } from "@/lib/query-keys";
import { invoke } from "./workbench-settings-overlay-deps";

export function OpenSourceLicensesSettingsPage({ onBack }: { onBack: () => void }) {
  const noticesQuery = useQuery({
    queryKey: queryKeys.settings.thirdPartyNotices(),
    queryFn: () => invoke("settings:third-party-notices:get"),
    staleTime: 60_000,
  });
  const noticesText = noticesQuery.data?.text;

  let content;
  if (noticesQuery.isLoading) {
    content = (
      <div className="text-sm text-token-text-secondary" role="status">
        Loading…
      </div>
    );
  } else {
    content = (
      <SettingsSection cardClassName="overflow-hidden rounded-2xl">
        {noticesText ? (
          <div
            role="document"
            aria-label={noticesText}
            className="h-[min(70vh,48rem)] min-h-96 overflow-hidden rounded bg-token-surface-secondary"
          >
            <LazySourceViewer
              value={noticesText}
              ariaLabel="Open source license text"
              sourceIdentity="open-source-licenses"
              wrap
              className="h-full"
            />
          </div>
        ) : (
          <div className="text-sm text-token-text-secondary">
            No third-party notices were found.
          </div>
        )}
      </SettingsSection>
    );
  }

  return (
    <SettingsPageSurface
      title="Open source licenses"
      subtitle="Third-party notices for dependencies included in this app"
      contentClassName="max-w-3xl"
      backSlot={
        <NodexButton
          aria-label="Back to General"
          className="no-drag"
          variant="ghost"
          size="xs"
          onClick={onBack}
        >
          <BackIcon className="icon-xs" />
          Back
        </NodexButton>
      }
    >
      {content}
    </SettingsPageSurface>
  );
}
