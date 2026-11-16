import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { BackIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { LazySourceViewer } from "@/components/ui/lazy-source-viewer";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsSection as SettingsSection,
} from "@/components/ui/settings";
import { queryKeys } from "@/lib/query-keys";
import { readThirdPartyNotices } from "./workbench-settings-overlay-deps";

export function OpenSourceLicensesSettingsPage({ onBack }: { onBack: () => void }) {
  const intl = useIntl();
  const noticesQuery = useQuery({
    queryKey: queryKeys.settings.thirdPartyNotices(),
    queryFn: readThirdPartyNotices,
    staleTime: 60_000,
  });
  const noticesText = noticesQuery.data?.text;

  let content;
  if (noticesQuery.isLoading) {
    content = (
      <div className="text-sm text-token-text-secondary" role="status">
        {intl.formatMessage({
          id: "settings.openSourceLicenses.loading",
          defaultMessage: "Loading…",
        })}
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
              ariaLabel={intl.formatMessage({
                id: "settings.openSourceLicenses.openSourceLicenseText",
                defaultMessage: "Open source license text",
              })}
              sourceIdentity="open-source-licenses"
              wrap
              className="h-full"
            />
          </div>
        ) : (
          <div className="text-sm text-token-text-secondary">
            {intl.formatMessage({
              id: "settings.openSourceLicenses.noThirdPartyNoticesWereFound",
              defaultMessage: "No third-party notices were found.",
            })}
          </div>
        )}
      </SettingsSection>
    );
  }

  return (
    <SettingsPageSurface
      title={intl.formatMessage(settingsMessages.generalOpenSourceLicenses)}
      subtitle={intl.formatMessage({
        id: "settings.openSourceLicenses.thirdPartyNoticesForDependenciesIncluded",
        defaultMessage: "Third-party notices for dependencies included in this app",
      })}
      contentClassName="max-w-3xl"
      backSlot={
        <NodexButton
          aria-label={intl.formatMessage({
            id: "settings.openSourceLicenses.backToGeneral",
            defaultMessage: "Back to General",
          })}
          className="no-drag"
          variant="ghost"
          size="xs"
          onClick={onBack}
        >
          <BackIcon className="icon-xs" />
          {intl.formatMessage({ id: "settings.openSourceLicenses.back", defaultMessage: "Back" })}
        </NodexButton>
      }
    >
      {content}
    </SettingsPageSurface>
  );
}
