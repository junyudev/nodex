import { createElement, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { ActivitySpinnerIcon, PluginsIcon } from "@/components/shared/icons";
import { SlashMcpIcon } from "@/components/shared/icons/app-icons";
import {
  MagnifyingGlassIcon,
  PlusIcon20,
  RecordIcon,
  SkillCubeIcon,
} from "@/components/shared/icons/customize-action-icons";
import { ChatBubblesIcon16 } from "@/components/shared/icons/plugin-detail-icons";
import { skillFallbackIcon } from "@/components/shared/icons/skill-fallback-icons";
import { NodexSwitch } from "@/components/ui/button";
import { CardTile } from "@/components/ui/card-tile";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { PageEmptyState } from "@/components/ui/section-header";
import { NodexSettingsPageSurface, NodexSettingsSection } from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { MoreActionsButton, ToolbarButton } from "@/components/ui/toolbar-button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { cn } from "@/lib/utils";
import type { SettingsSectionPageProps } from "@/components/workbench/workbench-settings-page-registry";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import type { MarketplaceAddParams } from "@nodex/codex-app-server-protocol/v2/MarketplaceAddParams";
import { appViewFromRow, connectedApps } from "../model/app-model";
import { manageableMarketplaces } from "../model/marketplace-model";
import { pluginMutationSucceeded } from "../model/mutation-result";
import {
  pluginDisabledReasonLabel,
  skillDisplayName,
  skillShortDescription,
} from "../model/plugin-detail-model";
import { pluginDisplayName, pluginShortDescription } from "../model/plugin-labels";
import { usePendingPluginActions } from "../model/install-sessions";
import { filterSkills, skillScopeLabel, skillTryPrompt } from "../model/skill-model";
import { normalizePluginSearch, pluginMatchesSearch } from "../model/selectors";
import {
  selectorToRouteTarget,
  useInstalledPlugins,
  useMarketplaces,
  usePluginApps,
  usePluginManagement,
  usePluginMcpServers,
  useSkillsPageData,
  type PluginContext,
  type PluginRouteTarget,
  type PluginRow,
} from "../plugin-management";
import {
  buildPluginDirectoryPath,
  buildPluginSettingsPath,
  buildSkillsPath,
  PLUGINS_SETTINGS_PATH,
  resolvePluginSettingsTarget,
} from "../plugins-routes";
import { AddMarketplaceDialog } from "./add-marketplace-dialog";
import { AddActionsMenu } from "./customize-header-actions";
import { SettingsNavigationRow, SettingsRowLogo } from "./settings-navigation-row";
import { AppsTab } from "./plugins-settings-apps";
import { McpServersTab } from "./plugins-settings-mcps";
import { MarketplacesTab } from "./plugins-settings-marketplaces";
import { PluginSettingsPage } from "./plugin-settings-page";
import { PluginLogoImage, pluginLogoSource } from "./plugin-logo";
import { DetailDialog } from "./detail-dialog";
import { SkillFileMenu, SkillInstructions } from "./skill-preview-modal";
import { usePluginHelperActions } from "./use-plugin-helper-actions";
import { usePluginRowActions } from "./use-plugin-row-actions";

type ManageTab = "plugins" | "apps" | "mcps" | "skills" | "marketplace";

const SEARCH_COPY: Record<ManageTab, string> = {
  plugins: "Search plugins",
  apps: "Search apps",
  mcps: "Search MCP servers",
  skills: "Search skills",
  marketplace: "Search marketplaces",
};
const TAB_ORDER: readonly ManageTab[] = ["plugins", "apps", "mcps", "skills", "marketplace"];

export interface PluginsSettingsNavigation {
  readonly projectId: string | null;
  /** Opens an installed plugin's settings, or the plugin list when null. */
  readonly onOpenPluginSettings: (target: PluginRouteTarget | null) => void;
  /** Opens a Customize page, such as a plugin's details. */
  readonly onOpenCustomize: (path: string) => void;
  readonly onStartChat: (prompt: string) => void;
}

/** Tabs that show their item counts; a tab with nothing in it is hidden. */
function ManageTabs({
  tabs,
  selected,
  onSelect,
}: {
  readonly tabs: readonly {
    readonly id: ManageTab;
    readonly label: string;
    readonly count: number;
  }[];
  readonly selected: ManageTab;
  readonly onSelect: (tab: ManageTab) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Manage extensions"
      className="hide-scrollbar relative inline-flex max-w-full min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden"
      onWheel={(event) => {
        const delta = event.deltaX || event.deltaY;
        if (delta !== 0) event.currentTarget.scrollLeft += delta;
      }}
    >
      {tabs.map((tab) => {
        const isSelected = tab.id === selected;
        return (
          <ToolbarButton
            key={tab.id}
            aria-pressed={isSelected}
            color="ghost"
            className={cn(
              "shrink-0 focus-visible:ring-inset",
              isSelected &&
                "bg-[color-mix(in_oklab,var(--color-text)_5%,transparent)] text-token-foreground",
            )}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
            <span className="ms-0.5 text-tertiary">{tab.count}</span>
          </ToolbarButton>
        );
      })}
    </div>
  );
}

/** The settings-page search: a 32px outlined field. */
function SettingsSearchInput({
  label,
  value,
  inputRef,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="no-drag flex h-8 items-center gap-2 rounded-(--radius-button-toolbar) border border-(--color-border-primary-outline) bg-(--color-surface-elevated-secondary) px-2.5 py-0 text-base leading-[18px]">
      <MagnifyingGlassIcon className="icon-sm text-(--color-text-secondary)" />
      <label className="sr-only" htmlFor="plugins-page-manage-search">
        {label}
      </label>
      <input
        ref={inputRef}
        id="plugins-page-manage-search"
        type="text"
        autoComplete="off"
        value={value}
        placeholder={label}
        className="min-w-0 flex-1 bg-transparent text-base leading-[18px] text-token-foreground outline-none select-text placeholder:text-tertiary"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** An installed plugin with its switch; the row opens the plugin's page. */
function PluginSettingsRow({
  row,
  context,
  navigation,
}: {
  readonly row: PluginRow;
  readonly context: PluginContext;
  readonly navigation: PluginsSettingsNavigation;
}) {
  const actions = usePluginRowActions(context, navigation);
  const pending = usePendingPluginActions().get(row.stableIdentity);
  const [updating, setUpdating] = useState(false);
  const name = pluginDisplayName(row);
  const adminDisabled = row.summary.availability === "DISABLED_BY_ADMIN";
  const adminLabel = pluginDisabledReasonLabel(row.summary.disabledReason, "Disabled by admin");
  const marketplaceLabel = row.isOfficial ? null : row.marketplace.name;

  const action =
    pending === "uninstalling" ? (
      <ToolbarButton color="ghost" disabled className="disabled:opacity-100">
        Uninstalling
      </ToolbarButton>
    ) : (
      <NodexTooltip
        side="top"
        tooltipContent={
          adminDisabled ? adminLabel : row.summary.enabled ? "Disable plugin" : "Enable plugin"
        }
      >
        <span className="flex items-center">
          <NodexSwitch
            ariaLabel={adminDisabled ? adminLabel : "Toggle plugin enabled state"}
            checked={row.summary.enabled}
            disabled={adminDisabled || updating || !row.canSetEnabled}
            onCheckedChange={(enabled) => {
              setUpdating(true);
              void actions.setEnabled(row, enabled).finally(() => setUpdating(false));
            }}
          />
        </span>
      </NodexTooltip>
    );

  return (
    <SettingsNavigationRow
      icon={
        <SettingsRowLogo>
          <PluginLogoImage source={pluginLogoSource(row)} className="h-full w-full" />
        </SettingsRowLogo>
      }
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span className="inline-flex max-w-full flex-wrap items-center gap-2">
            <span className="truncate">{name}</span>
          </span>
          {marketplaceLabel == null ? null : (
            <span className="text-token-description-foreground">{marketplaceLabel}</span>
          )}
        </span>
      }
      description={
        pluginShortDescription(row) == null ? undefined : (
          <div className="line-clamp-1">{pluginShortDescription(row)}</div>
        )
      }
      actions={action}
      onOpen={() => navigation.onOpenPluginSettings(selectorToRouteTarget(row))}
    />
  );
}

function PluginsTab({
  rows,
  isLoading,
  error,
  context,
  navigation,
}: {
  readonly rows: readonly PluginRow[];
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly context: PluginContext;
  readonly navigation: PluginsSettingsNavigation;
}) {
  if (isLoading) return <LoadingState label="Loading plugins…" />;
  if (error != null) {
    return (
      <div className="flex h-full min-h-full flex-1 items-center justify-center py-8">
        <PageEmptyState title="Failed to load plugins" description={error.message} />
      </div>
    );
  }
  if (rows.length === 0) return <CompactEmptyState>No plugins found</CompactEmptyState>;
  return (
    <NodexSettingsSection>
      {rows.map((row) => (
        <PluginSettingsRow
          key={row.stableIdentity}
          row={row}
          context={context}
          navigation={navigation}
        />
      ))}
    </NodexSettingsSection>
  );
}

function LoadingState({ label }: { readonly label: string }) {
  return (
    <div className="flex h-full min-h-full flex-1 items-center justify-center px-6 py-8 text-center">
      <div
        role="status"
        className="flex items-center gap-2 py-2 text-sm text-(--color-text-secondary)"
      >
        <ActivitySpinnerIcon className="icon-xs shrink-0" />
        <span className="text-balance">{label}</span>
      </div>
    </div>
  );
}

function CompactEmptyState({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center py-8">
      <div className="text-sm text-(--color-text-secondary)">{children}</div>
    </div>
  );
}

/**
 * A personal skill in settings: a round skill avatar, its name and description, where it is
 * installed, and its switch. The row opens the skill's contents.
 */
function SkillSettingsRow({
  skill,
  context,
  navigation,
}: {
  readonly skill: SkillMetadata;
  readonly context: PluginContext;
  readonly navigation: PluginsSettingsNavigation;
}) {
  const management = usePluginManagement(context);
  const router = useFileReferenceRouter();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [updating, setUpdating] = useState(false);
  const name = skillDisplayName(skill);
  const enabled = optimistic ?? skill.enabled;
  const toggleLabel = enabled ? "Disable skill" : "Enable skill";
  const description = skillShortDescription({
    description: skill.description,
    shortDescription: skill.shortDescription ?? null,
    interface: skill.interface,
  });

  const setEnabled = async (next: boolean) => {
    setOptimistic(next);
    setUpdating(true);
    try {
      const result = await management.setSkillEnabled(
        skill.name.includes(":")
          ? { name: skill.name, enabled: next }
          : { path: skill.path, enabled: next },
      );
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
      toast.success(next ? `${name} skill enabled` : `${name} skill disabled`);
    } catch {
      setOptimistic(null);
      toast.danger("Failed to update skill");
    } finally {
      setUpdating(false);
    }
  };
  const skillSwitch = (
    <NodexTooltip tooltipContent={toggleLabel} side="top">
      <span className="flex items-center">
        <NodexSwitch
          ariaLabel={toggleLabel}
          checked={enabled}
          disabled={updating}
          onCheckedChange={(next) => void setEnabled(next)}
        />
      </span>
    </NodexTooltip>
  );

  return (
    <>
      <CardTile
        presentation="card"
        className="group justify-center"
        contentClassName={enabled ? undefined : "opacity-60"}
        iconContainer={false}
        icon={
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-(--color-border) text-(--color-text-secondary)">
            <SkillCubeIcon className="icon-sm" />
          </span>
        }
        title={name}
        description={description}
        descriptionClassName="line-clamp-1"
        actions={
          <div className="flex items-center gap-2">
            <div className="text-sm text-(--color-text-secondary)">{skillScopeLabel(skill)}</div>
            <div
              className={cn(
                "flex",
                menuOpen
                  ? "visible opacity-100"
                  : "invisible opacity-0 transition-opacity group-hover:visible group-hover:opacity-100",
              )}
              onClick={(event) => event.stopPropagation()}
            >
              <NodexDropdownMenu
                align="end"
                contentWidth="icon"
                open={menuOpen}
                onOpenChange={setMenuOpen}
                triggerButton={<MoreActionsButton variant="toolbar" />}
              >
                <NodexDropdownItem
                  disabled={context.hostId !== "local"}
                  onSelect={() =>
                    void router.open(
                      { path: skill.path },
                      { hostId: context.hostId, title: "SKILL.md" },
                    )
                  }
                >
                  Open
                </NodexDropdownItem>
                <NodexDropdownItem onSelect={() => setOpen(true)}>Details</NodexDropdownItem>
              </NodexDropdownMenu>
            </div>
            <span onClick={(event) => event.stopPropagation()}>{skillSwitch}</span>
          </div>
        }
        onClick={() => setOpen(true)}
      />
      <DetailDialog
        iconShape="rounded"
        open={open}
        onOpenChange={setOpen}
        icon={createElement(skillFallbackIcon(skill), { className: "icon-md" })}
        title={name}
        titleText={name}
        description={description}
        headerActions={
          <div className="flex items-center gap-2">
            {skillSwitch}
            <SkillFileMenu context={context} path={skill.path} onOpened={() => setOpen(false)} />
          </div>
        }
        footer={
          <ToolbarButton
            color="primary"
            className="rounded-full"
            disabled={!enabled || updating}
            onClick={() => navigation.onStartChat(skillTryPrompt(skill))}
          >
            <ChatBubblesIcon16 />
            Try now
          </ToolbarButton>
        }
      >
        <SkillInstructions context={context} selector={{ path: skill.path }} />
      </DetailDialog>
    </>
  );
}

/**
 * Settings › Plugins: installed plugins, MCP servers, personal skills, and added marketplaces,
 * under counted tabs with one search. MCPs is always offered; another tab shows once it has
 * something in it.
 */
export function PluginsSettingsPage({
  navigation,
}: {
  readonly navigation: PluginsSettingsNavigation;
}) {
  const context = { hostId: "local", projectId: navigation.projectId };
  const management = usePluginManagement(context);
  const helpers = usePluginHelperActions(context, navigation);
  const installed = useInstalledPlugins(context);
  const skills = useSkillsPageData(context);
  const mcpServers = usePluginMcpServers(context);
  const marketplaces = useMarketplaces(context);
  const apps = usePluginApps(context);
  const [selectedTab, setSelectedTab] = useState<ManageTab>("plugins");
  const [addingMcpServer, setAddingMcpServer] = useState(false);
  const [search, setSearch] = useState("");
  const [addMarketplaceOpen, setAddMarketplaceOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const pluginRows = installed.data ?? [];
  const query = normalizePluginSearch(search);
  const counts: Record<ManageTab, number> = {
    plugins: pluginRows.length,
    apps: connectedApps((apps.data?.apps ?? []).map(appViewFromRow), "").length,
    mcps: (mcpServers.data?.servers ?? []).filter(
      (server) => server.declaration != null && server.pluginId == null,
    ).length,
    skills: skills.settingsSkills.length,
    marketplace: manageableMarketplaces(marketplaces.data?.marketplaces ?? [], "").length,
  };
  const loading: Record<ManageTab, boolean> = {
    plugins: installed.isPending,
    apps: apps.isPending,
    mcps: mcpServers.isPending,
    skills: skills.skillsQuery.isPending || skills.recommendedQuery.isPending,
    marketplace: marketplaces.isPending,
  };
  const labels: Record<ManageTab, string> = {
    plugins: "Plugins",
    apps: "Apps",
    mcps: "MCPs",
    skills: "Skills",
    marketplace: "Marketplace",
  };
  const tabs = TAB_ORDER.filter((id) => id === "mcps" || counts[id] > 0).map((id) => ({
    id,
    label: labels[id],
    count: counts[id],
  }));
  // Adding a server shows MCPs; an emptied tab falls through to the next one with something in it.
  const tab: ManageTab = addingMcpServer
    ? "mcps"
    : selectedTab === "mcps" || loading[selectedTab] || counts[selectedTab] > 0
      ? selectedTab
      : (TAB_ORDER.find((id) => counts[id] > 0) ?? "mcps");

  const focusSearch = useEffectEvent(() => searchRef.current?.focus());
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["input", "textarea", "select"].includes(target.tagName.toLowerCase()))
      ) {
        return;
      }
      event.preventDefault();
      focusSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const addMarketplace = async (params: MarketplaceAddParams) => {
    const result = await management.addMarketplace(params);
    if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
    const { marketplaceName, alreadyAdded } = result.value;
    if (alreadyAdded) toast.info(`${marketplaceName} is already added`);
    else toast.success(`${marketplaceName} marketplace added`);
  };

  let content: ReactNode;
  if (tab === "plugins") {
    content = (
      <PluginsTab
        rows={pluginRows.filter((row) => pluginMatchesSearch(row, query))}
        isLoading={installed.isPending}
        error={installed.error}
        context={context}
        navigation={navigation}
      />
    );
  } else if (tab === "apps") {
    content = <AppsTab context={context} search={search} onStartChat={navigation.onStartChat} />;
  } else if (tab === "mcps") {
    content = (
      <McpServersTab
        context={context}
        search={search}
        adding={addingMcpServer}
        onAddingChange={setAddingMcpServer}
      />
    );
  } else if (tab === "skills") {
    content = loading.skills ? (
      <LoadingState label="Loading skills…" />
    ) : (
      <SkillsList
        skills={filterSkills(skills.settingsSkills, search)}
        context={context}
        navigation={navigation}
      />
    );
  } else {
    content = <MarketplacesTab context={context} search={search} />;
  }

  return (
    <NodexSettingsPageSurface
      title="Plugins"
      subtitle="Manage plugins, skills, and MCPs"
      action={
        <div className="flex items-center gap-2">
          <ToolbarButton
            color="outline"
            onClick={() =>
              navigation.onOpenCustomize(
                tab === "skills" ? buildSkillsPath() : buildPluginDirectoryPath(),
              )
            }
          >
            Browse directory
          </ToolbarButton>
          <AddActionsMenu
            addActions={[
              ...(helpers.createPlugin.visible
                ? [
                    {
                      id: "plugin",
                      label: "Create plugin",
                      icon: <PluginsIcon />,
                      disabled: helpers.createPlugin.disabled,
                      onSelect: helpers.createPlugin.run,
                    },
                  ]
                : []),
              {
                id: "marketplace",
                label: "Add a marketplace",
                icon: <PlusIcon20 />,
                onSelect: () => setAddMarketplaceOpen(true),
              },
              {
                id: "mcp",
                label: "Add MCP server",
                icon: <SlashMcpIcon className="icon-sm" />,
                onSelect: () => setAddingMcpServer(true),
              },
            ]}
            trailingAction={
              helpers.recordSkill.visible
                ? {
                    id: "record-skill",
                    label: "Record a skill",
                    icon: <RecordIcon />,
                    disabled: helpers.recordSkill.disabled,
                    onSelect: helpers.recordSkill.run,
                  }
                : undefined
            }
          />
        </div>
      }
    >
      <div className="@container/skills-grid flex min-h-0 flex-1 flex-col gap-10 text-base select-none">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ManageTabs
            tabs={tabs}
            selected={tab}
            onSelect={(next) => {
              setAddingMcpServer(false);
              setSelectedTab(next);
            }}
          />
          <div className="w-56 min-w-0 max-[1023px]:hidden">
            <SettingsSearchInput
              label={SEARCH_COPY[tab]}
              value={search}
              inputRef={searchRef}
              onChange={setSearch}
            />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{content}</div>
      </div>
      <AddMarketplaceDialog
        open={addMarketplaceOpen}
        onOpenChange={setAddMarketplaceOpen}
        onAddMarketplace={addMarketplace}
      />
    </NodexSettingsPageSurface>
  );
}

function SkillsList({
  skills,
  context,
  navigation,
}: {
  readonly skills: readonly SkillMetadata[];
  readonly context: PluginContext;
  readonly navigation: PluginsSettingsNavigation;
}) {
  if (skills.length === 0) return <CompactEmptyState>No skills found</CompactEmptyState>;
  return (
    <div className="grid grid-cols-1 gap-2">
      {skills.map((skill) => (
        <SkillSettingsRow
          key={skill.path}
          skill={skill}
          context={context}
          navigation={navigation}
        />
      ))}
    </div>
  );
}

/**
 * The Settings page entry: the plugin list, or one plugin's settings when the path names it.
 * Customize and new chats come from the Workbench.
 */
export function PluginsSettingsSectionPage({
  activeProjectId,
  path,
  onPathChange,
  onOpenCustomize,
  onStartChat,
}: SettingsSectionPageProps) {
  const navigation: PluginsSettingsNavigation = {
    projectId: activeProjectId,
    onOpenPluginSettings: (target) =>
      onPathChange(target == null ? PLUGINS_SETTINGS_PATH : buildPluginSettingsPath(target)),
    onOpenCustomize: onOpenCustomize ?? (() => undefined),
    onStartChat: onStartChat ?? (() => undefined),
  };
  const target = resolvePluginSettingsTarget(path);
  if (target != null) {
    return (
      <PluginSettingsPage
        key={target.pluginId}
        target={target}
        context={{ hostId: "local", projectId: activeProjectId }}
        navigation={navigation}
        onBack={() => navigation.onOpenPluginSettings(null)}
      />
    );
  }
  return <PluginsSettingsPage navigation={navigation} />;
}
