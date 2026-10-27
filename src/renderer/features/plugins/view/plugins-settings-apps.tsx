import { useState } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { NodexSettingsSection } from "@/components/ui/settings";
import { PageEmptyState } from "@/components/ui/section-header";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { appViewFromRow, connectedApps } from "../model/app-model";
import { usePluginApps, type PluginContext } from "../plugin-management";
import { AppEnabledSwitch, AppLogo, AppToolsDialog, useAppEnabledToggle } from "./app-tools-dialog";
import { SettingsNavigationRow, SettingsRowLogo } from "./settings-navigation-row";

/** Loading or a failed first load, centered where the list would be. */
function AppsPlaceholder({
  error,
  retrying,
  onRetry,
}: {
  readonly error: string | null;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center py-8">
      {error == null ? (
        <div
          role="status"
          className="flex items-center gap-2 py-2 text-sm text-(--color-text-secondary)"
        >
          <ActivitySpinnerIcon className="icon-xs shrink-0" />
          Loading apps…
        </div>
      ) : (
        <PageEmptyState
          title="Unable to load apps"
          description={error}
          actions={
            <ToolbarButton color="outline" disabled={retrying} onClick={onRetry}>
              Retry
            </ToolbarButton>
          }
        />
      )}
    </div>
  );
}

/**
 * The Apps tab: the apps you have connected, each with its switch. A row opens the app's
 * tools, where it can also be tried in a new chat.
 */
export function AppsTab({
  context,
  search,
  onStartChat,
}: {
  readonly context: PluginContext;
  readonly search: string;
  readonly onStartChat: (prompt: string) => void;
}) {
  const query = usePluginApps(context);
  const toggle = useAppEnabledToggle(context);
  const [toolsAppId, setToolsAppId] = useState<string | null>(null);
  const apps = (query.data?.apps ?? []).map(appViewFromRow);
  const toolsApp = apps.find((app) => app.id === toolsAppId) ?? null;
  const error = query.error?.message ?? null;
  const retry = () => void query.refetch();

  if (query.data == null) {
    return (
      <AppsPlaceholder
        error={query.isPending ? null : error}
        retrying={query.isFetching}
        onRetry={retry}
      />
    );
  }
  const visible = connectedApps(apps, search);
  return (
    <div className="flex flex-col gap-6">
      {error == null ? null : (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-(--color-border) p-3 text-sm"
        >
          <div className="font-medium text-token-foreground">Unable to load apps</div>
          <div className="text-(--color-text-secondary)">{error}</div>
          <ToolbarButton
            color="outline"
            className="self-start"
            disabled={query.isFetching}
            onClick={retry}
          >
            Retry
          </ToolbarButton>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center py-8">
          <div className="text-sm text-(--color-text-secondary)">No installed apps</div>
        </div>
      ) : (
        <NodexSettingsSection>
          {visible.map((app) => (
            <SettingsNavigationRow
              key={app.id}
              icon={
                <SettingsRowLogo>
                  <AppLogo app={app} className="h-full w-full object-contain" />
                </SettingsRowLogo>
              }
              label={app.name}
              description={
                <div className="line-clamp-1">{app.description ?? "No description"}</div>
              }
              actions={<AppEnabledSwitch app={app} toggle={toggle} />}
              onOpen={() => setToolsAppId(app.id)}
            />
          ))}
        </NodexSettingsSection>
      )}
      <AppToolsDialog
        context={context}
        app={toolsApp}
        toggle={toggle}
        onOpenChange={(open) => {
          if (!open) setToolsAppId(null);
        }}
        onStartChat={(prompt) => {
          setToolsAppId(null);
          onStartChat(prompt);
        }}
      />
    </div>
  );
}
