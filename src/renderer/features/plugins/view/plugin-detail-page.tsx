import { useRef, useState, type ReactNode } from "react";
import starterPromptsBackdropUrl from "@/assets/plugins/starter-prompts-backdrop.png";
import {
  ArrowRightIcon,
  PuzzlePieceIllustration,
} from "@/components/shared/icons/plugin-detail-icons";
import {
  DETAIL_SECTION_GROUP_CLASS,
  DetailHeader,
  DetailLogo,
  DetailSections,
  PromptButton,
  PromptPreview,
} from "@/components/ui/detail-page";
import { PageEmptyState } from "@/components/ui/section-header";
import { ToolbarBreadcrumb } from "@/components/ui/toolbar-breadcrumb";
import { NodexTooltip } from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/file-system-operations";
import { AppShellHeaderContentRegistrar } from "@/lib/workbench-ui-scopes";
import { cn } from "@/lib/utils";
import type { CustomizeNavigation } from "../customize-navigation";
import {
  pluginDeveloperSubtitle,
  pluginDisabledReasonLabel,
  pluginLongDescription,
  pluginStarterPrompts,
  pluginTagline,
} from "../model/plugin-detail-model";
import { pluginDisplayName } from "../model/plugin-labels";
import { pluginTitleHint } from "../model/plugin-title-hints";
import {
  routeTargetToSelector,
  selectorToRouteTarget,
  usePluginDetail,
  type PluginContext,
  type PluginDetailView,
  type PluginRouteTarget,
} from "../plugin-management";
import { buildPluginDirectoryPath, type PluginDirectoryBrowse } from "../plugins-routes";
import { PluginDescription } from "./plugin-description";
import { PluginDetailActions } from "./plugin-detail-actions";
import { PluginIncludes, type PluginApp } from "./plugin-includes";
import { PluginInformation, PluginLegalNotice } from "./plugin-information";
import { PluginLogoImage, pluginLogoSource } from "./plugin-logo";
import { PluginMentionChip } from "./plugin-mention-chip";
import { PluginOriginBadge } from "./plugin-origin-badge";
import { PluginCategoryTitle } from "./plugins-directory-page";
import { usePluginRowActions } from "./use-plugin-row-actions";

/** "Plugins › {category} › {plugin}" in the titlebar, leading back to the directory view. */
function PluginBreadcrumbs({
  context,
  navigation,
  browse,
  title,
}: {
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
  readonly browse: PluginDirectoryBrowse;
  readonly title: string;
}) {
  const category = browse.category;
  return (
    <ToolbarBreadcrumb
      ancestors={[
        {
          id: "plugins",
          label: "Plugins",
          onSelect: () =>
            navigation.onNavigate(
              buildPluginDirectoryPath({ tab: browse.tab, search: browse.search }),
            ),
        },
        ...(category == null
          ? []
          : [
              {
                id: "plugin-category",
                label: (
                  <PluginCategoryTitle context={context} category={category} tab={browse.tab} />
                ),
                onSelect: () => navigation.onNavigate(buildPluginDirectoryPath(browse)),
              },
            ]),
      ]}
      current={title}
    />
  );
}

/** One line that shows its full text in a tooltip only when it is cut off. */
function TruncatedLine({ id, children }: { readonly id?: string; readonly children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  const measure = () => {
    const element = ref.current;
    if (element != null) setTruncated(element.scrollWidth > element.clientWidth);
  };
  return (
    <NodexTooltip tooltipContent={children} disabled={!truncated} side="top">
      <span
        ref={ref}
        id={id}
        className="block truncate text-sm"
        onPointerEnter={measure}
        onFocus={measure}
      >
        {children}
      </span>
    </NodexTooltip>
  );
}

/** The logo, name, and origin beside the actions; placeholders stand in while loading. */
function PluginDetailHero({
  view,
  actions,
}: {
  readonly view: PluginDetailView | null;
  readonly actions: ReactNode;
}) {
  const subtitle =
    view == null
      ? null
      : pluginDeveloperSubtitle(view.summary.interface?.developerName, pluginTagline(view));
  return (
    <DetailHeader
      asset={
        <DetailLogo>
          {view == null ? (
            <span className="size-full bg-text/10" />
          ) : (
            <PluginLogoImage
              source={pluginLogoSource(view.row)}
              className="size-full rounded-2xs"
            />
          )}
        </DetailLogo>
      }
      title={
        <h1 className="heading-base flex min-w-0 items-center gap-2 text-token-foreground">
          {view == null ? (
            <span className="h-4 w-24 rounded bg-text/10" />
          ) : (
            <>
              <span className="min-w-0 wrap-break-word">{pluginDisplayName(view.row)}</span>
              <PluginOriginBadge row={view.row} size="large" />
            </>
          )}
        </h1>
      }
      subtitle={
        view == null ? (
          <div className="h-3 w-3/5 rounded bg-text/10" />
        ) : subtitle == null ? null : (
          <TruncatedLine id="plugin-description">{subtitle}</TruncatedLine>
        )
      }
      actions={actions}
    />
  );
}

/** A heading bar and a block, pulsing while a plugin's details load. */
function SectionSkeleton({ announce = false }: { readonly announce?: boolean }) {
  return (
    <div
      role={announce ? "status" : undefined}
      aria-hidden={!announce || undefined}
      className="flex flex-col gap-4 px-(--detail-page-inline-inset) motion-safe:animate-pulse"
    >
      {announce ? <span className="sr-only">Loading plugin details…</span> : null}
      <div aria-hidden className="h-4 w-24 rounded bg-text/10" />
      <div aria-hidden className="h-12 rounded-lg bg-text/10" />
    </div>
  );
}

function PluginDetailSkeleton() {
  return (
    <DetailSections>
      <div aria-hidden className="motion-safe:animate-pulse">
        <PluginDetailHero
          view={null}
          actions={<div className="h-token-button-composer w-14 rounded-lg bg-text/10" />}
        />
      </div>
      <div className={DETAIL_SECTION_GROUP_CLASS}>
        <SectionSkeleton announce />
        <SectionSkeleton />
      </div>
    </DetailSections>
  );
}

function PluginDetailEmptyState({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center py-8">
      <PageEmptyState
        illustration={<PuzzlePieceIllustration className="h-20 w-auto text-tertiary" />}
        title={title}
        description={description}
      />
    </div>
  );
}

function PluginDetailReady({
  view,
  context,
  navigation,
  onDescriptionTransition,
  onConnectApp,
  onRetry,
}: {
  readonly view: PluginDetailView;
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
  readonly onDescriptionTransition: (transitioning: boolean) => void;
  readonly onConnectApp: (app: PluginApp) => void;
  readonly onRetry: () => void;
}) {
  const row = view.row;
  const actions = usePluginRowActions(context, navigation);
  const [busy, setBusy] = useState(false);
  const prompts = pluginStarterPrompts(view);
  const description = pluginLongDescription(view);
  const blocked =
    row.summary.availability === "DISABLED_BY_ADMIN" ||
    (!row.summary.installed && row.actionState === "unavailable");
  const blockedTooltip =
    row.summary.availability === "DISABLED_BY_ADMIN"
      ? pluginDisabledReasonLabel(row.summary.disabledReason, "Disabled by admin")
      : "This plugin isn't available to install for your account or device";
  const logo = pluginLogoSource(row);

  const enable = async () => {
    setBusy(true);
    try {
      return await actions.setEnabled(row, true);
    } finally {
      setBusy(false);
    }
  };
  /** Starts a chat with the prompt, installing or enabling the plugin first when needed. */
  const activate = async (prompt: string | null) => {
    if (!row.summary.installed) {
      if (await actions.install(row, prompt)) actions.tryNow(row, prompt);
      return;
    }
    if (!row.summary.enabled && !(await enable())) return;
    actions.tryNow(row, prompt);
  };

  return (
    <DetailSections>
      <PluginDetailHero
        view={view}
        actions={
          <PluginDetailActions
            row={row}
            handlers={{
              onInstall: () => void actions.install(row),
              onEnable: async () => {
                await enable();
              },
              onTryNow: () => actions.tryNow(row),
              onUninstall: () => void actions.uninstall(row),
              onManage: () => navigation.onOpenSettings(selectorToRouteTarget(row)),
            }}
          />
        }
      />
      {prompts.length > 0 || description != null ? (
        <div className={DETAIL_SECTION_GROUP_CLASS}>
          {prompts.length > 0 ? (
            <div className="flex flex-col">
              <PromptPreview backgroundUrl={starterPromptsBackdropUrl}>
                {prompts.map((prompt, index) => (
                  <NodexTooltip
                    key={`${prompt}-${index}`}
                    tooltipContent={blockedTooltip}
                    disabled={!blocked}
                    side="top"
                  >
                    <PromptButton
                      disabled={blocked}
                      pending={busy}
                      arrow={<ArrowRightIcon aria-hidden className="icon-2xs" />}
                      onClick={() => void activate(prompt)}
                    >
                      <PluginMentionChip
                        name={pluginDisplayName(row)}
                        iconUrl={row.composerIconUrl ?? logo.logoUrl}
                        brandColor={row.summary.interface?.brandColor ?? null}
                      />{" "}
                      {prompt}
                    </PromptButton>
                  </NodexTooltip>
                ))}
              </PromptPreview>
            </div>
          ) : null}
          {description == null ? null : (
            <div className="min-w-0 px-(--detail-page-inline-inset)">
              <PluginDescription
                key={description}
                markdown={description}
                onTransitionChange={onDescriptionTransition}
              />
            </div>
          )}
        </div>
      ) : null}
      <PluginIncludes
        view={view}
        context={context}
        navigation={navigation}
        onConnectApp={onConnectApp}
        onRetryDetail={onRetry}
      />
      <PluginInformation view={view} />
      <PluginLegalNotice view={view} />
    </DetailSections>
  );
}

/**
 * A plugin's page: what it does and includes, its starter prompts, and the actions to install,
 * try, or remove it. Its breadcrumb sits in the titlebar.
 */
export function PluginDetailPage({
  context,
  navigation,
  target,
  browse,
}: {
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
  readonly target: PluginRouteTarget;
  readonly browse: PluginDirectoryBrowse;
}) {
  // After an app's connection page opens in the browser, returning to the window refreshes
  // the plugin's app connections.
  const [awaitingConnection, setAwaitingConnection] = useState(false);
  const detail = usePluginDetail(context, routeTargetToSelector(target), {
    refreshAppConnectionsOnFocus: awaitingConnection,
  });
  const [descriptionTransitioning, setDescriptionTransitioning] = useState(false);
  const title =
    (detail.data == null ? null : pluginDisplayName(detail.data.row)) ??
    pluginTitleHint(target.pluginId) ??
    "Plugin";

  let content: ReactNode;
  if (detail.data != null) {
    content = (
      <PluginDetailReady
        view={detail.data}
        context={context}
        navigation={navigation}
        onDescriptionTransition={setDescriptionTransitioning}
        onConnectApp={(app) => {
          if (app.installUrl == null) return;
          setAwaitingConnection(true);
          void openExternalUrl(app.installUrl);
        }}
        onRetry={() => void detail.refetch()}
      />
    );
  } else if (detail.isError) {
    content = (
      <PluginDetailEmptyState title="Failed to load plugin" description={detail.error.message} />
    );
  } else {
    content = <PluginDetailSkeleton />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-base">
      <AppShellHeaderContentRegistrar
        content={
          <PluginBreadcrumbs
            context={context}
            navigation={navigation}
            browse={browse}
            title={title}
          />
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className={cn(
            "relative min-h-0 w-full flex-1 overflow-y-auto [scrollbar-gutter:stable]",
            descriptionTransitioning && "[overflow-anchor:none]",
          )}
        >
          <div className="mx-auto flex min-h-full w-full max-w-(--thread-content-max-width) flex-col px-toolbar py-(--padding-panel)">
            {content}
          </div>
        </div>
      </div>
    </div>
  );
}
