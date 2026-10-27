import { Children, createElement, useState, type ReactNode } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { RefreshArrowsIcon } from "@/components/shared/icons/customize-action-icons";
import {
  ChatBubblesIcon16,
  CheckmarkMdIcon,
  ChevronDownSmIcon,
  GearIcon20,
  HookIcon,
  ProfileLockIcon,
  ServerIcon,
  SlashCircleIcon,
  WarningCircleIcon,
  XmarkMdIcon,
} from "@/components/shared/icons/plugin-detail-icons";
import { skillFallbackIcon } from "@/components/shared/icons/skill-fallback-icons";
import { NodexSwitch } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CardTile } from "@/components/ui/card-tile";
import { DetailSection } from "@/components/ui/detail-page";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CustomizeNavigation } from "../customize-navigation";
import {
  INCLUDED_ITEMS_VISIBLE_LIMIT,
  includedItemsShowMoreLabel,
  pluginDisabledReasonLabel,
  skillDisplayName,
  skillShortDescription,
} from "../model/plugin-detail-model";
import { pluginMutationSucceeded } from "../model/mutation-result";
import {
  usePluginManagement,
  type PluginContext,
  type PluginDetailView,
  type SkillContentsSelector,
} from "../plugin-management";
import { appViewFromDetail } from "../model/app-model";
import { AppLogo, AppToolsDialog, useAppEnabledToggle } from "./app-tools-dialog";
import { DetailDialog, DetailDialogTitle } from "./detail-dialog";
import { PluginLogoImage, pluginLogoSource } from "./plugin-logo";
import { PluginWorksWith } from "./plugin-works-with";
import { SkillFileMenu, SkillInstructions } from "./skill-preview-modal";
import { skillTryPrompt } from "../model/skill-model";

export type PluginApp = PluginDetailView["apps"][number];
type PluginSkill = PluginDetailView["skills"][number];

interface PreviewItem {
  readonly key: string;
  readonly icon: ReactNode;
  readonly label: string;
}

/**
 * Up to five rows, then a row that reveals the rest: "See A, B, and 3 more" behind up to three
 * stacked icons. Once everything shows, the same row folds it back.
 */
function IncludedItemsList({
  previewItems,
  children,
}: {
  readonly previewItems?: readonly PreviewItem[];
  readonly children: ReactNode;
}) {
  const items = Children.toArray(children);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, INCLUDED_ITEMS_VISIBLE_LIMIT);
  const hiddenCount = items.length - visible.length;
  const hiddenPreviews = previewItems?.slice(visible.length) ?? null;
  return (
    <>
      {visible}
      {items.length > INCLUDED_ITEMS_VISIBLE_LIMIT ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-h-(--height-token-row) w-full cursor-interaction items-center gap-3 rounded-(--radius-token-row) px-(--padding-row-x) py-(--padding-row-y) text-start text-sm leading-relaxed font-normal text-token-description-foreground outline-hidden hover:text-token-foreground focus-visible:text-token-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            "Show less"
          ) : (
            <>
              {hiddenPreviews == null ? null : (
                <span aria-hidden className="flex h-10 w-8 shrink-0 items-center">
                  {hiddenPreviews.slice(0, 3).map((item) => (
                    <span
                      key={item.key}
                      className="-ms-2 flex size-4 items-center justify-center overflow-hidden rounded-sm border border-(--color-border) bg-(--color-surface) first:ms-0"
                    >
                      {item.icon}
                    </span>
                  ))}
                </span>
              )}
              {includedItemsShowMoreLabel(
                hiddenPreviews?.map((item) => item.label) ?? null,
                hiddenCount,
              )}
            </>
          )}
        </button>
      ) : null}
    </>
  );
}

/** A 28px slot holding a status glyph at the end of a row. */
function RowStatus({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <span
      role="img"
      aria-label={label}
      className="flex size-7 items-center justify-center rounded-md text-token-description-foreground"
    >
      {children}
    </span>
  );
}

function stopPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

/**
 * The "● Connected ⌄" pill of a connected app. Its menu reconnects the app in the browser and,
 * when the account allows it, disconnects it.
 */
function AppConnectedMenu({
  app,
  context,
  onConnect,
}: {
  readonly app: PluginApp;
  readonly context: PluginContext;
  readonly onConnect: (app: PluginApp) => void;
}) {
  const management = usePluginManagement(context);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnect = async () => {
    setDisconnecting(true);
    try {
      const result = await management.disconnectApp({ appId: app.id });
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
      if (result.refreshFailures.length > 0)
        toast.warning("App disconnected, but couldn't refresh apps");
      else toast.success("App disconnected");
    } catch {
      toast.danger("Couldn't disconnect app");
    } finally {
      setDisconnecting(false);
    }
  };
  return (
    <div role="presentation" onClick={stopPropagation} onKeyDown={stopPropagation}>
      <NodexDropdownMenu
        align="end"
        contentWidth="xs"
        disabled={disconnecting}
        triggerButton={
          <ToolbarButton
            color="outline"
            aria-busy={disconnecting || undefined}
            className="gap-1.5 text-sm"
          >
            {disconnecting ? <ActivitySpinnerIcon className="icon-xxs" /> : null}
            <span className="flex items-center gap-1.5">
              {disconnecting ? (
                "Disconnecting…"
              ) : (
                <>
                  <span className="size-1.5 shrink-0 rounded-full bg-(--color-chart-green)" />
                  Connected
                </>
              )}
            </span>
            <ChevronDownSmIcon className="icon-2xs shrink-0 text-token-description-foreground" />
          </ToolbarButton>
        }
      >
        <NodexDropdownItem
          leftSlot={<RefreshArrowsIcon />}
          disabled={app.installUrl == null}
          onSelect={() => onConnect(app)}
        >
          Reconnect
        </NodexDropdownItem>
        {app.canDisconnect ? (
          <NodexDropdownItem
            leftSlot={<XmarkMdIcon />}
            className="text-danger"
            onSelect={() => void disconnect()}
          >
            Disconnect
          </NodexDropdownItem>
        ) : null}
      </NodexDropdownMenu>
    </div>
  );
}

function appCategory(app: PluginApp): string {
  const category = app.category?.trim() || "Other";
  return `${category.slice(0, 1).toUpperCase()}${category.slice(1).toLowerCase()}`;
}

/** The apps a plugin connects, grouped by category when there is more than one. */
function AppsSection({
  view,
  context,
  navigation,
  onConnect,
}: {
  readonly view: PluginDetailView;
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
  readonly onConnect: (app: PluginApp) => void;
}) {
  const toggle = useAppEnabledToggle(context);
  const [toolsAppId, setToolsAppId] = useState<string | null>(null);
  const installed = view.summary.installed;
  const pluginBlocked = view.summary.availability === "DISABLED_BY_ADMIN";
  const groups = new Map<string, PluginApp[]>();
  for (const app of view.apps) {
    const category = appCategory(app);
    groups.set(category, [...(groups.get(category) ?? []), app]);
  }
  const showCategoryHeadings = groups.size > 1;
  // A blocked app's tools can't be opened, and close if the app becomes blocked.
  const toolsApp = pluginBlocked
    ? null
    : (view.apps.find((app) => app.id === toolsAppId && app.connectionState !== "unavailable") ??
      null);

  const row = (app: PluginApp) => {
    const icon = <AppLogo app={appViewFromDetail(app)} className="icon-md" />;
    const blockedTooltip = pluginBlocked
      ? pluginDisabledReasonLabel(
          view.summary.disabledReason,
          "This app can’t be used while the plugin is disabled",
        )
      : app.connectionState === "unavailable"
        ? "This app isn’t available"
        : null;
    if (blockedTooltip != null) {
      return (
        <CardTile
          key={app.id}
          disabled
          tooltip={blockedTooltip}
          icon={icon}
          iconContainerVariant="outline"
          title={app.name}
          description={app.description ?? "No description"}
          descriptionClassName="line-clamp-1"
          contentClassName="opacity-60"
          actions={
            pluginBlocked ? (
              <NodexTooltip tooltipContent="Disabled by admin" side="top">
                <span role="img" aria-label="Disabled by admin">
                  <ProfileLockIcon className="icon-sm shrink-0" />
                </span>
              </NodexTooltip>
            ) : undefined
          }
        />
      );
    }
    const accessible = app.accessible ?? app.connectionState === "connected";
    const connect = (
      <ToolbarButton
        color="outline"
        className="shrink-0"
        disabled={app.installUrl == null}
        onClick={(event) => {
          event.stopPropagation();
          onConnect(app);
        }}
      >
        Connect
      </ToolbarButton>
    );
    let actions: ReactNode = null;
    if (accessible && installed) {
      actions =
        app.enabled === false ? (
          connect
        ) : (
          <AppConnectedMenu app={app} context={context} onConnect={onConnect} />
        );
    } else if (accessible) {
      actions =
        app.enabled === false ? (
          <RowStatus label="App disabled">
            <SlashCircleIcon className="icon-sm" />
          </RowStatus>
        ) : (
          <RowStatus label="App enabled">
            <CheckmarkMdIcon className="icon-sm" />
          </RowStatus>
        );
    } else if (installed) {
      actions = connect;
    }
    return (
      <CardTile
        key={app.id}
        className="group justify-center border-none"
        icon={icon}
        iconContainerVariant="outline"
        title={app.name}
        description={app.description ?? "No description"}
        descriptionClassName="line-clamp-1"
        actions={actions}
        onClick={() => setToolsAppId(app.id)}
      />
    );
  };

  return (
    <DetailSection title="Apps" count={view.apps.length} inset={false}>
      <div className="flex flex-col gap-3">
        {[...groups].map(([category, apps], index) => (
          <div
            key={category}
            className={cn("flex flex-col gap-2", showCategoryHeadings && index > 0 && "pt-2")}
          >
            {showCategoryHeadings ? (
              <div className="px-(--padding-row-x) text-sm text-tertiary">{category}</div>
            ) : null}
            <IncludedItemsList
              previewItems={apps.map((app) => ({
                key: `app-${app.id}`,
                label: app.name,
                icon: <AppLogo app={appViewFromDetail(app)} className="icon-xs" />,
              }))}
            >
              {apps.map(row)}
            </IncludedItemsList>
          </div>
        ))}
      </div>
      <AppToolsDialog
        context={context}
        app={toolsApp == null ? null : appViewFromDetail(toolsApp)}
        toggle={toggle}
        showEnableToggle={installed}
        onOpenChange={(open) => {
          if (!open) setToolsAppId(null);
        }}
        onStartChat={(prompt) => {
          setToolsAppId(null);
          navigation.onStartChat(prompt);
        }}
      />
    </DetailSection>
  );
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

/** One MCP server: the plugin's logo, its name, its settings, and its switch once installed. */
function McpServerRow({
  view,
  server,
  context,
  navigation,
}: {
  readonly view: PluginDetailView;
  readonly server: PluginDetailView["mcpServerStates"][number];
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
}) {
  const management = usePluginManagement(context);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [updating, setUpdating] = useState(false);
  const enabled = optimistic ?? server.enabled;
  const logo = pluginLogoSource(view.row);
  const settingsLabel = server.installed ? "Open MCP settings" : "Set up in MCP settings";
  const toggleLabel = enabled ? "Disable MCP server" : "Enable MCP server";
  const setEnabled = async (next: boolean) => {
    setOptimistic(next);
    setUpdating(true);
    try {
      const result = await management.setPluginMcpServerEnabled({
        ...view.row.selector,
        name: server.name,
        enabled: next,
      });
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
    } catch {
      setOptimistic(null);
      toast.danger("Failed to update MCP server");
    } finally {
      setUpdating(false);
    }
  };
  return (
    <CardTile
      className={cn("group", server.installed && !enabled && "opacity-60")}
      iconContainer={false}
      icon={
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md">
          <PluginLogoImage
            source={logo}
            className="icon-sm rounded-2xs"
            fallback={<ServerIcon className="icon-xs text-(--color-text-secondary)" />}
          />
        </span>
      }
      title={capitalize(server.name)}
      actions={
        <>
          <NodexTooltip tooltipContent={settingsLabel} side="top">
            <ToolbarButton
              color="ghost"
              uniform
              aria-label={settingsLabel}
              onClick={() => navigation.onOpenSettings()}
            >
              <GearIcon20 className="icon-sm" />
            </ToolbarButton>
          </NodexTooltip>
          {server.installed ? (
            <NodexTooltip tooltipContent={toggleLabel} side="top">
              <span className="flex items-center">
                <NodexSwitch
                  ariaLabel="Toggle MCP server enabled state"
                  checked={enabled}
                  disabled={updating || !server.canSetEnabled}
                  onCheckedChange={(next) => void setEnabled(next)}
                />
              </span>
            </NodexTooltip>
          ) : null}
        </>
      }
    />
  );
}

/** The MCP servers a plugin declares, framed with the plugin's logo. */
function McpServersSection({
  view,
  context,
  navigation,
}: {
  readonly view: PluginDetailView;
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
}) {
  const servers =
    view.mcpServerStates.length > 0
      ? view.mcpServerStates
      : view.mcpServers.map((name) => ({
          name,
          configKey: null,
          enabled: true,
          installed: false,
          canSetEnabled: false,
        }));
  return (
    <DetailSection title="MCP servers" count={servers.length} inset={false}>
      <IncludedItemsList>
        {servers.map((server) => (
          <McpServerRow
            key={server.name}
            view={view}
            server={server}
            context={context}
            navigation={navigation}
          />
        ))}
      </IncludedItemsList>
    </DetailSection>
  );
}

function skillContentsSelector(
  view: PluginDetailView,
  skill: PluginSkill,
): SkillContentsSelector | null {
  if (skill.path != null) return { path: skill.path };
  const remotePluginId = view.summary.remotePluginId;
  if (view.summary.source.type !== "remote" || remotePluginId == null) return null;
  return {
    remoteMarketplaceName: view.row.marketplace.name,
    remotePluginId,
    skillName: skill.name,
  };
}

/** A skill's own icon, else the glyph its name suggests. */
function SkillIcon({
  skill,
  className,
}: {
  readonly skill: PluginSkill;
  readonly className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = skill.iconUrl ?? skill.interface?.iconSmallUrl ?? null;
  if (url != null && failedUrl !== url) {
    return (
      <span className={cn("block overflow-hidden rounded-2xs", className)}>
        <img
          src={url}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => setFailedUrl(url)}
        />
      </span>
    );
  }
  return createElement(skillFallbackIcon(skill), {
    className: cn("rounded-2xs text-(--color-text-secondary)", className),
  });
}

/**
 * One included skill. Clicking it previews the skill's instructions; an installed plugin's skill
 * can be opened, revealed, copied, or tried from there.
 */
function PluginSkillRow({
  view,
  skill,
  context,
  navigation,
}: {
  readonly view: PluginDetailView;
  readonly skill: PluginSkill;
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
}) {
  const [open, setOpen] = useState(false);
  const title = skillDisplayName(skill);
  const description = skillShortDescription(skill);
  const icon = (
    <span className="flex size-8 shrink-0 items-center justify-center">
      <SkillIcon skill={skill} className="icon-md" />
    </span>
  );

  if (view.summary.availability === "DISABLED_BY_ADMIN") {
    return (
      <CardTile
        disabled
        tooltip={pluginDisabledReasonLabel(
          view.summary.disabledReason,
          "This skill can’t be viewed because the plugin is unavailable",
        )}
        icon={icon}
        iconContainer={false}
        title={title}
        description={description}
        descriptionClassName="line-clamp-1"
        contentClassName="opacity-60"
      />
    );
  }

  // An installed plugin's skill acts as the installed skill it matches; one not found locally
  // previews like a skill of a plugin that isn't installed.
  const installedSkill = view.summary.installed ? skill.installedSkill : null;
  const installed = installedSkill != null;
  const dimmed = installedSkill != null && !installedSkill.enabled;
  return (
    <>
      <CardTile
        className="justify-center border-none text-base select-none"
        contentClassName={dimmed ? "opacity-60" : undefined}
        icon={icon}
        iconContainer={false}
        title={title}
        description={description}
        descriptionClassName="line-clamp-1"
        onClick={() => setOpen(true)}
      />
      <DetailDialog
        iconShape="rounded"
        open={open}
        onOpenChange={setOpen}
        icon={<SkillIcon skill={skill} className="icon-md" />}
        title={
          installed ? (
            <DetailDialogTitle
              kind="Skill"
              title={title}
              badge={dimmed ? <Badge variant="outline">Disabled</Badge> : null}
            />
          ) : (
            title
          )
        }
        titleText={title}
        description={description}
        headerActions={
          installedSkill == null ? undefined : (
            <SkillFileMenu
              context={context}
              path={installedSkill.path}
              onOpened={() => setOpen(false)}
            />
          )
        }
        footer={
          installed ? (
            <ToolbarButton
              color="primary"
              className="rounded-full"
              disabled={dimmed}
              onClick={() => navigation.onStartChat(skillTryPrompt(skill))}
            >
              <ChatBubblesIcon16 />
              Try now
            </ToolbarButton>
          ) : (
            <ToolbarButton color="primary" className="rounded-full" onClick={() => setOpen(false)}>
              Close
            </ToolbarButton>
          )
        }
      >
        {installed ? null : (
          <h2 className="flex min-h-7 items-center gap-1.5 text-lg leading-6 font-medium select-none">
            Skill
          </h2>
        )}
        <SkillInstructions context={context} selector={skillContentsSelector(view, skill)} />
      </DetailDialog>
    </>
  );
}

function SkillsSection({
  view,
  context,
  navigation,
}: {
  readonly view: PluginDetailView;
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
}) {
  return (
    <DetailSection title="Skills" count={view.skills.length} inset={false}>
      <IncludedItemsList
        previewItems={view.skills.map((skill) => ({
          key: `skill-${skill.path ?? skill.name}`,
          label: skillDisplayName(skill),
          icon: <SkillIcon skill={skill} className="icon-xs" />,
        }))}
      >
        {view.skills.map((skill) => (
          <PluginSkillRow
            key={skill.path ?? skill.name}
            view={view}
            skill={skill}
            context={context}
            navigation={navigation}
          />
        ))}
      </IncludedItemsList>
    </DetailSection>
  );
}

/** The plugin's lifecycle hooks, as one row, flagging hooks that need review before they run. */
function HooksSection({
  view,
  context,
  navigation,
}: {
  readonly view: PluginDetailView;
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
}) {
  const management = usePluginManagement(context);
  const [trusting, setTrusting] = useState(false);
  const installed = view.summary.installed;
  const needsReview = view.hooksNeedingReviewCount;
  const trustAll = async () => {
    setTrusting(true);
    try {
      const result = await management.trustAllPluginHooks(view.row.selector);
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
    } catch {
      toast.danger("Failed to trust hooks");
    } finally {
      setTrusting(false);
    }
  };
  let actions: ReactNode = null;
  if (installed && needsReview > 0) {
    actions = (
      <span className="flex items-center gap-2">
        <ToolbarButton color="secondary" loading={trusting} onClick={() => void trustAll()}>
          Trust all
        </ToolbarButton>
        <ToolbarButton color="secondary" onClick={navigation.onOpenHooksSettings}>
          Review
        </ToolbarButton>
      </span>
    );
  } else if (installed) {
    actions = (
      <NodexTooltip tooltipContent="Manage in settings" side="top">
        <ToolbarButton
          color="ghost"
          uniform
          aria-label="Manage in settings"
          onClick={navigation.onOpenHooksSettings}
        >
          <GearIcon20 className="icon-sm" />
        </ToolbarButton>
      </NodexTooltip>
    );
  }
  return (
    <DetailSection title="Hooks" inset={false}>
      <CardTile
        iconContainerVariant="outline"
        icon={<HookIcon className="text-(--color-text-secondary)" />}
        title="Hooks"
        description={
          <div className="flex flex-col gap-1">
            Run deterministic scripts during the task lifecycle
            {installed && needsReview > 0 ? (
              <span className="flex items-center gap-1 text-token-foreground">
                <WarningCircleIcon className="icon-2xs shrink-0 text-(--color-text-warning)" />
                {needsReview === 1
                  ? "1 hook needs review before it can run"
                  : `${needsReview} hooks need review before they can run`}
              </span>
            ) : null}
          </div>
        }
        descriptionClassName="text-xs leading-4"
        actions={actions}
      />
    </DetailSection>
  );
}

/** Everything a plugin brings: apps, MCP servers, the plugins it works with, skills, and hooks. */
export function PluginIncludes({
  view,
  context,
  navigation,
  onConnectApp,
  onRetryDetail,
}: {
  readonly view: PluginDetailView;
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
  /** Opens an app's connection page; the page refreshes its connections on return. */
  readonly onConnectApp: (app: PluginApp) => void;
  readonly onRetryDetail: () => void;
}) {
  const sections = [
    view.apps.length > 0 ? (
      <AppsSection
        key="apps"
        view={view}
        context={context}
        navigation={navigation}
        onConnect={onConnectApp}
      />
    ) : null,
    view.mcpServers.length > 0 ? (
      <McpServersSection key="mcp" view={view} context={context} navigation={navigation} />
    ) : null,
    view.worksWith?.available ? (
      <PluginWorksWith key="works-with" worksWith={view.worksWith} onRetry={onRetryDetail} />
    ) : null,
    view.skills.length > 0 ? (
      <SkillsSection key="skills" view={view} context={context} navigation={navigation} />
    ) : null,
    view.hooks.length > 0 ? (
      <HooksSection key="hooks" view={view} context={context} navigation={navigation} />
    ) : null,
  ].filter((section) => section != null);
  if (sections.length === 0) return null;
  return (
    <div id="plugin-includes" className="contents [--radius-token-row:var(--radius-lg)]">
      <div className="flex flex-col gap-(--detail-page-section-gap) empty:hidden">{sections}</div>
    </div>
  );
}
