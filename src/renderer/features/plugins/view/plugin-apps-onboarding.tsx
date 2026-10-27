import { useEffect, useState } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { NodexLogoMarkIcon } from "@/components/shared/icons/app-icons";
import { AppsGlyphIcon, ChatBubblesIcon16 } from "@/components/shared/icons/plugin-detail-icons";
import { CardTile } from "@/components/ui/card-tile";
import { NodexDialog, NodexDialogContent, NodexDialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/file-system-operations";
import type { CustomizeNavigation } from "../customize-navigation";
import { requiredAppStatus, type RequiredAppStatus } from "../model/app-model";
import {
  closePluginAppsOnboarding,
  usePluginAppsOnboarding,
  type PluginAppsOnboarding as Onboarding,
} from "../model/install-sessions";
import { pluginDisplayName } from "../model/plugin-labels";
import { usePluginApps, type PluginContext } from "../plugin-management";
import { useOpenPluginDetail } from "./plugin-browse-context";
import { PluginLogoImage, pluginLogoSource } from "./plugin-logo";
import { usePluginRowActions } from "./use-plugin-row-actions";

const ACTION_LABEL: Record<RequiredAppStatus, string> = {
  pending: "Connect",
  waitingForCallback: "Continue connecting app",
  connected: "Connected",
};

function OnboardingContent({
  session,
  context,
  navigation,
}: {
  readonly session: Onboarding;
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
}) {
  const { row, apps } = session;
  const name = pluginDisplayName(row);
  const actions = usePluginRowActions(context, navigation);
  const openDetail = useOpenPluginDetail(navigation);
  // Connections are rechecked when the window regains focus after a connection page.
  const linked = usePluginApps(context, {
    appIds: apps.map((app) => app.id),
    refreshOnFocus: true,
  });
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const rows = apps.flatMap((app) => {
    const linkedApp = linked.data?.apps.find((item) => item.id === app.id);
    if (linkedApp?.connectionState === "admin_disabled") return [];
    return [
      {
        app,
        logo: linkedApp ?? null,
        status: requiredAppStatus(linkedApp, opened.has(app.id)),
      },
    ];
  });

  // Once every app is connected there is nothing left to do here.
  const allConnected = rows.length > 0 && rows.every((item) => item.status === "connected");
  useEffect(() => {
    if (!allConnected) return;
    closePluginAppsOnboarding();
    toast.success(`${name} plugin installed`);
  }, [allConnected, name]);

  const connect = (app: Onboarding["apps"][number]) => {
    if (app.installUrl == null) return;
    setOpened(new Set([...opened, app.id]));
    void openExternalUrl(app.installUrl);
  };

  return (
    <div className="flex max-h-full flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col items-center gap-4 px-6 pt-9 pb-4">
        <div className="flex items-center gap-4">
          <span className="flex size-[60px] shrink-0 items-center justify-center rounded-2xl bg-black text-white shadow-sm">
            <NodexLogoMarkIcon className="size-12" />
          </span>
          <span aria-hidden className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-(--color-border)" />
            <span className="size-1.5 rounded-full bg-(--color-border)" />
            <span className="size-1.5 rounded-full bg-(--color-border)" />
          </span>
          <span className="flex size-[60px] shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-(--color-surface-secondary) shadow-sm">
            <PluginLogoImage source={pluginLogoSource(row)} className="size-full object-contain" />
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <NodexDialogTitle className="text-lg leading-6 font-semibold text-token-foreground">
            Connect your apps to {name}
          </NodexDialogTitle>
          <div className="max-w-[432px] text-sm leading-5 text-(--color-text-secondary)">
            Get more relevant help from the apps you already use. You can always do this later.
          </div>
        </div>
      </div>
      <div className="vertical-scroll-fade-mask min-h-0 flex-1 overflow-y-auto px-6">
        <div className="flex flex-col">
          {rows.map(({ app, logo, status }) => {
            const connecting = status === "waitingForCallback";
            const disabled = status !== "pending" || app.installUrl == null;
            return (
              <CardTile
                key={app.id}
                className="min-h-[72px] justify-center border-none px-0 py-3 hover:bg-transparent"
                iconContainerVariant="outline"
                icon={
                  <PluginLogoImage
                    source={{
                      logoUrl: logo?.logoUrl ?? null,
                      logoDarkUrl: logo?.logoDarkUrl ?? null,
                      name: app.name,
                    }}
                    className="icon-md rounded-2xs"
                    fallback={<AppsGlyphIcon className="icon-sm text-(--color-text-secondary)" />}
                  />
                }
                title={app.name}
                description={app.description ?? "No description"}
                descriptionClassName="line-clamp-1"
                actions={
                  <NodexTooltip
                    tooltipContent={connecting ? ACTION_LABEL.waitingForCallback : null}
                    side="top"
                  >
                    <span className="flex">
                      <ToolbarButton
                        color="outline"
                        className="shrink-0"
                        disabled={disabled}
                        aria-label={ACTION_LABEL[status]}
                        onClick={() => connect(app)}
                      >
                        {connecting ? (
                          <ActivitySpinnerIcon className="icon-xxs" />
                        ) : (
                          ACTION_LABEL[status]
                        )}
                      </ToolbarButton>
                    </span>
                  </NodexTooltip>
                }
              />
            );
          })}
        </div>
      </div>
      <div className="flex h-[84px] shrink-0 items-center justify-end gap-2 bg-(--color-surface-elevated-secondary) p-6">
        <ToolbarButton
          color="outline"
          className="h-9 rounded-xl px-3 py-2 text-sm leading-5"
          onClick={() => {
            closePluginAppsOnboarding();
            openDetail(row);
          }}
        >
          View details
        </ToolbarButton>
        <ToolbarButton
          color="primary"
          className="h-9 rounded-xl px-3 py-2 text-sm leading-5"
          onClick={() => {
            closePluginAppsOnboarding();
            actions.tryNow(row, session.prompt ?? undefined);
          }}
        >
          <ChatBubblesIcon16 className="icon-sm" />
          Try {name} now
        </ToolbarButton>
      </div>
    </div>
  );
}

/**
 * After installing a plugin whose apps need an account, offers to connect each one: Connect
 * opens the app's connection page, and the row turns Connected once the account link appears.
 * Connecting is optional; closing leaves the plugin installed.
 */
export function PluginAppsOnboarding({
  context,
  navigation,
}: {
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
}) {
  const session = usePluginAppsOnboarding();
  return (
    <NodexDialog
      open={session != null}
      onOpenChange={(open) => {
        if (!open) closePluginAppsOnboarding();
      }}
    >
      <NodexDialogContent
        closeButtonAriaLabel="Close dialog"
        className="h-fit max-h-[min(720px,calc(100vh-2rem))] w-[480px] max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        {session == null ? null : (
          <OnboardingContent
            key={session.row.stableIdentity}
            session={session}
            context={context}
            navigation={navigation}
          />
        )}
      </NodexDialogContent>
    </NodexDialog>
  );
}
