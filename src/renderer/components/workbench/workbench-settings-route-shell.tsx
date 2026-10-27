import { lazy, startTransition, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ApplicationSurface } from "@/bootstrap/application-surface";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
} from "@/components/ui/dropdown";
import type { ComposerEnterBehavior } from "../../lib/composer-enter-behavior";
import type { Project, WorktreeStartMode } from "../../lib/types";
import {
  type SettingsSectionDefinition,
  type SettingsSectionId,
} from "./workbench-settings-sections";
import type { SettingsOpenThread } from "./workbench-settings-page-registry";
import { SETTINGS_PAGE_COMPONENTS } from "./workbench-settings-section-pages";
import {
  CODEX_SETTINGS_SHELL_STYLE,
  NodexSettingsSection as SectionBlock,
  NodexSettingsPageSurface as SettingsPageSurface,
} from "../ui/settings";
import { SettingsSidebar } from "./workbench-settings-sidebar";
import {
  buildBrowserSettingsPath,
  buildSettingsAnchorPath,
  buildSettingsPath,
  resolveSettingsShellState,
} from "./workbench-settings-routes";
import { settingsSearchAnchor } from "./workbench-settings-search-catalog";
import {
  resolveWorkbenchMainSurfaceClip,
  workbenchMainSurfaceClassName,
} from "./workbench-route-host";

const OpenSourceLicensesSettingsPage = lazy(async () => ({
  default: (await import("./open-source-licenses-settings-page")).OpenSourceLicensesSettingsPage,
}));

export interface SettingsRouteShellProps {
  path: string;
  onPathChange: (path: string) => void;
  onBackToApp: () => void;
  onRequestProjectPickerOpen: () => void;
  onOpenThread?: SettingsOpenThread;
  onOpenCustomize?: (path: string) => void;
  onStartChat?: (prompt: string) => void;
  projects: Project[];
  activeProjectId: string | null;
  initialLocalEnvironmentProjectId?: string | null;
  initialLocalEnvironmentConfigPath?: string | null;
  initialSettingsSearchQuery?: string;
  initialSettingsSearchHighlightIndex?: number;
  threadQueueFollowUpsEnabled: boolean;
  onThreadQueueFollowUpsEnabledChange: (value: boolean) => void;
  composerEnterBehavior: ComposerEnterBehavior;
  onComposerEnterBehaviorChange: (value: ComposerEnterBehavior) => void;
  worktreeStartMode: WorktreeStartMode;
  onWorktreeStartModeChange: (value: WorktreeStartMode) => void;
  worktreeAutoBranchPrefix: string;
  onWorktreeAutoBranchPrefixChange: (value: string) => void;
  taskShorthandPagePromotionEnabled: boolean;
  onTaskShorthandPagePromotionEnabledChange: (value: boolean) => void;
}

function SettingsPlaceholderPage({ label, message }: { label: string; message: string }) {
  return (
    <SettingsPageSurface title={label} subtitle={message}>
      <SectionBlock title={label}>
        <div className="text-token-text-secondary p-3 text-sm">{message}</div>
      </SectionBlock>
    </SettingsPageSurface>
  );
}

/** Anchor effects commit with the selected page, after its lazy module resolves. */
function SettingsPageContent({
  anchor,
  path,
  children,
}: {
  anchor: string | null;
  path: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!anchor) return;
    document.getElementById(anchor)?.scrollIntoView({ block: "start" });
  }, [anchor, path]);

  return children;
}

function isEditableEscapeElement(element: Element | null): boolean {
  return Boolean(
    element?.closest(
      [
        "input",
        "textarea",
        "select",
        "[contenteditable='true']",
        "[contenteditable='']",
        "[role='dialog']",
        "[data-slot='dialog-content']",
        "[data-slot='dropdown-content']",
        "[data-slot='popover-content']",
        "[data-slot='tooltip-positioner']",
      ].join(","),
    ),
  );
}

function isEditableEscapeTarget(target: EventTarget | null): boolean {
  const targetElement = target instanceof Element ? target : null;
  const activeElement =
    targetElement?.ownerDocument.activeElement ??
    (typeof document === "undefined" ? null : document.activeElement);

  return isEditableEscapeElement(targetElement) || isEditableEscapeElement(activeElement);
}

function SettingsMobileHeader({
  activeSectionId,
  sections,
  onBack,
  onSelectSection,
}: {
  activeSectionId: SettingsSectionId;
  sections: SettingsSectionDefinition[];
  onBack: () => void;
  onSelectSection: (sectionId: SettingsSectionId) => void;
}) {
  const activeSection =
    sections.find((section) => section.id === activeSectionId) ?? sections[0] ?? null;

  return (
    <div className="absolute inset-x-0 top-0 z-20 flex h-toolbar items-center justify-between gap-2 border-b border-token-border bg-token-main-surface-primary px-panel md:hidden">
      <button
        type="button"
        onClick={onBack}
        className="cursor-interaction rounded-lg px-2 py-1 text-sm text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary focus-visible:ring-token-focus-border focus-visible:ring-1 focus-visible:outline-none"
      >
        Back
      </button>
      <NodexDropdownMenu
        align="end"
        triggerButton={
          <NodexDropdownButtonTrigger
            size="sm"
            chrome="transparent"
            style={{ maxWidth: "min(14rem, calc(100vw - 7rem))" }}
          >
            <span className="truncate">{activeSection?.label ?? "Settings"}</span>
          </NodexDropdownButtonTrigger>
        }
      >
        {sections.map((section) => (
          <NodexDropdownItem
            key={section.id}
            disabled={section.disabled}
            onSelect={() => onSelectSection(section.id)}
            rightSlot={section.id === activeSectionId ? <NodexDropdownSelectedIcon /> : null}
          >
            {section.label}
          </NodexDropdownItem>
        ))}
      </NodexDropdownMenu>
    </div>
  );
}

export function SettingsRouteShell({
  path,
  onPathChange,
  onBackToApp,
  onRequestProjectPickerOpen,
  onOpenThread,
  onOpenCustomize,
  onStartChat,
  projects,
  activeProjectId,
  initialLocalEnvironmentProjectId,
  initialLocalEnvironmentConfigPath,
  initialSettingsSearchQuery,
  initialSettingsSearchHighlightIndex,
  threadQueueFollowUpsEnabled,
  onThreadQueueFollowUpsEnabledChange,
  composerEnterBehavior,
  onComposerEnterBehaviorChange,
  worktreeStartMode,
  onWorktreeStartModeChange,
  worktreeAutoBranchPrefix,
  onWorktreeAutoBranchPrefixChange,
  taskShorthandPagePromotionEnabled,
  onTaskShorthandPagePromotionEnabledChange,
}: SettingsRouteShellProps) {
  const isMacPlatform =
    typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
  const shellRef = useRef<HTMLDivElement>(null);
  const {
    activeSectionId,
    browserAnchor,
    browserDetail,
    detailPageId,
    settingsAnchor,
    visibleSections,
  } = resolveSettingsShellState(path);
  const activeSection = visibleSections.find((section) => section.id === activeSectionId) ?? null;
  const settingsSearchContext = useMemo(() => {
    const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;

    return {
      activeProjectName: activeProject?.name ?? null,
      projectNames: projects.map((project) => project.name),
    };
  }, [activeProjectId, projects]);

  useEffect(() => {
    shellRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented || isEditableEscapeTarget(event.target)) return;
      onBackToApp();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBackToApp]);

  const ActiveSectionComponent = activeSection
    ? SETTINGS_PAGE_COMPONENTS[activeSection.pageKey]
    : null;
  const shouldRenderPlaceholder =
    !ActiveSectionComponent ||
    activeSection?.placeholderKind === "unavailable" ||
    activeSection?.placeholderKind === "external";

  return (
    <div
      data-testid="settings-route-shell"
      className="flex h-full min-h-0 w-full flex-1 text-(--foreground)"
      style={CODEX_SETTINGS_SHELL_STYLE}
    >
      <div
        ref={shellRef}
        aria-label="Settings"
        tabIndex={-1}
        className="flex h-full min-h-0 w-full flex-1 outline-none"
      >
        <SettingsSidebar
          activeSectionId={activeSectionId}
          sections={visibleSections}
          searchContext={settingsSearchContext}
          initialSearchQuery={initialSettingsSearchQuery}
          initialHighlightedSearchIndex={initialSettingsSearchHighlightIndex}
          onBack={onBackToApp}
          onSelectSection={(sectionId, searchQuery) => {
            const anchor = settingsSearchAnchor(sectionId, searchQuery);
            startTransition(() => {
              onPathChange(
                anchor ? buildSettingsAnchorPath(sectionId, anchor) : buildSettingsPath(sectionId),
              );
            });
          }}
        />

        <div
          data-app-shell-main-surface="default"
          className={workbenchMainSurfaceClassName(true)}
          style={{ clipPath: resolveWorkbenchMainSurfaceClip(true) }}
        >
          <SettingsMobileHeader
            activeSectionId={activeSectionId}
            sections={visibleSections}
            onBack={onBackToApp}
            onSelectSection={(sectionId) => {
              startTransition(() => {
                onPathChange(buildSettingsPath(sectionId));
              });
            }}
          />
          {/* Keep navigation available while only the selected page loads. */}
          <ApplicationSurface
            key={detailPageId ?? activeSectionId}
            fallback={
              <SettingsPageSurface
                title={
                  detailPageId === "open-source-licenses"
                    ? "Open source licenses"
                    : (activeSection?.label ?? "Settings")
                }
              >
                <div role="status" className="text-sm text-token-text-secondary">
                  Loading…
                </div>
              </SettingsPageSurface>
            }
          >
            <SettingsPageContent
              anchor={settingsAnchor === browserAnchor ? null : settingsAnchor}
              path={path}
            >
              {detailPageId === "open-source-licenses" ? (
                <OpenSourceLicensesSettingsPage
                  onBack={() => {
                    startTransition(() => {
                      onPathChange(buildSettingsPath("general-settings"));
                    });
                  }}
                />
              ) : shouldRenderPlaceholder ? (
                <SettingsPlaceholderPage
                  label={activeSection?.label ?? "Settings"}
                  message={
                    activeSection?.placeholderKind === "external"
                      ? "This settings page opens outside the app."
                      : "This settings page is not available yet."
                  }
                />
              ) : (
                <ActiveSectionComponent
                  open={true}
                  path={path}
                  settingsAnchor={settingsAnchor}
                  initialSearchQuery={initialSettingsSearchQuery}
                  onPathChange={onPathChange}
                  browserAnchor={browserAnchor}
                  browserDetail={browserDetail}
                  onOpenBrowserDetail={(destination, anchor) => {
                    startTransition(() => {
                      onPathChange(
                        destination === "browser"
                          ? buildBrowserSettingsPath(undefined, anchor)
                          : buildBrowserSettingsPath(destination),
                      );
                    });
                  }}
                  isMacPlatform={isMacPlatform}
                  projects={projects}
                  activeProjectId={activeProjectId}
                  initialLocalEnvironmentProjectId={initialLocalEnvironmentProjectId}
                  initialLocalEnvironmentConfigPath={initialLocalEnvironmentConfigPath}
                  onRequestProjectPickerOpen={onRequestProjectPickerOpen}
                  onOpenThread={onOpenThread}
                  onOpenCustomize={onOpenCustomize}
                  onStartChat={onStartChat}
                  threadQueueFollowUpsEnabled={threadQueueFollowUpsEnabled}
                  onThreadQueueFollowUpsEnabledChange={onThreadQueueFollowUpsEnabledChange}
                  composerEnterBehavior={composerEnterBehavior}
                  onComposerEnterBehaviorChange={onComposerEnterBehaviorChange}
                  worktreeStartMode={worktreeStartMode}
                  onWorktreeStartModeChange={onWorktreeStartModeChange}
                  worktreeAutoBranchPrefix={worktreeAutoBranchPrefix}
                  onWorktreeAutoBranchPrefixChange={onWorktreeAutoBranchPrefixChange}
                  taskShorthandPagePromotionEnabled={taskShorthandPagePromotionEnabled}
                  onTaskShorthandPagePromotionEnabledChange={
                    onTaskShorthandPagePromotionEnabledChange
                  }
                />
              )}
            </SettingsPageContent>
          </ApplicationSurface>
        </div>
      </div>
    </div>
  );
}
