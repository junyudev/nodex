import { useIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { CloseIcon, SettingsSearchIcon } from "@/components/shared/icons";
import {
  settingsQueryRendersResultsMode,
  type SettingsSearchContext,
  type SettingsSearchResult,
} from "@/lib/settings-search";
import { useSettingsListNavigation } from "@/lib/use-settings-list-navigation";
import { cn } from "@/lib/utils";
import {
  SETTINGS_SECTION_GROUP_LABELS,
  SETTINGS_SECTION_GROUP_ORDER,
  searchWorkbenchSettings,
  type SettingsSectionDefinition,
  type SettingsSectionGroupKey,
  type SettingsSectionId,
} from "./workbench-settings-sections";
import { buildSettingsPath } from "./workbench-settings-routes";
import { WorkbenchRailEdge } from "./workbench-app-rail";
import { WORKBENCH_SIDEBAR_ROW_METRICS_CLASS } from "./workbench-sidebar-frame";
import { WorkbenchSidebarTitleRow } from "./sidebar-new-chat-controls";

interface SettingsSidebarProps {
  activeSectionId: SettingsSectionId;
  sections: SettingsSectionDefinition[];
  searchContext: SettingsSearchContext;
  initialSearchQuery?: string;
  initialHighlightedSearchIndex?: number;
  onSelectSection: (sectionId: SettingsSectionId, searchQuery?: string) => void;
}

interface SettingsSectionGroup {
  groupKey: SettingsSectionGroupKey;
  /** Absent for the account group, which leads the rail without a heading. */
  label: string | null;
  sections: SettingsSectionDefinition[];
}

function SettingsSidebarItem({
  active,
  disabled = false,
  icon: Icon,
  label,
  onClick,
  sectionId,
}: {
  active: boolean;
  disabled?: boolean;
  icon: SettingsSectionDefinition["icon"];
  label: string;
  onClick: () => void;
  sectionId: SettingsSectionId;
}) {
  const className = cn(
    "relative flex h-(--height-token-nav-row) w-full shrink-0 cursor-interaction items-center gap-2 overflow-hidden rounded-(--radius-token-row) px-row-x py-row-y text-left text-base text-token-text-primary outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-solid focus-visible:outline-token-focus-border",
    active
      ? "bg-(--color-background-secondary-ghost-hover)"
      : "hover:bg-(--color-background-secondary-ghost-hover)",
    disabled ? "cursor-not-allowed opacity-50" : undefined,
  );
  const content = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Icon className="icon-xs shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );

  if (disabled) {
    return (
      <button type="button" disabled aria-label={label} className={className}>
        {content}
      </button>
    );
  }

  return (
    <a
      href={buildSettingsPath(sectionId)}
      onClick={(event) => {
        event.preventDefault();
        onClick();
      }}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      data-nodex-internal-route="settings"
      data-settings-panel-slug={sectionId}
      className={className}
    >
      {content}
    </a>
  );
}

function SettingsSearchInput({
  onKeyDown,
  onQueryChange,
  query,
}: {
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onQueryChange: (query: string) => void;
  query: string;
}) {
  const intl = useIntl();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const wantsSearch =
        (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f";

      if (!wantsSearch) return;

      event.preventDefault();
      event.stopPropagation();
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex h-8 w-full shrink-0 items-center gap-2 rounded-full border border-(--color-border-strong) bg-transparent ps-3 pe-1.5 text-sm leading-5">
      <SettingsSearchIcon className="icon-xs shrink-0 text-token-text-secondary" />
      <input
        ref={inputRef}
        role="searchbox"
        aria-label={intl.formatMessage({
          id: "settings.navigation.searchSettings",
          defaultMessage: "Search settings",
        })}
        placeholder={intl.formatMessage({
          id: "settings.navigation.searchPlaceholder",
          defaultMessage: "Search",
        })}
        type="text"
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 appearance-none border-none bg-transparent p-0 text-token-text-primary ring-0 outline-none select-text placeholder:text-tertiary focus:border-none focus:ring-0 focus:outline-none"
      />
      {query.length > 0 ? (
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: "settings.navigation.clearSettingsSearch",
            defaultMessage: "Clear settings search",
          })}
          onClick={() => {
            onQueryChange("");
            inputRef.current?.focus();
          }}
          className="flex size-6 shrink-0 cursor-interaction items-center justify-center rounded-full text-token-text-secondary hover:text-token-text-primary"
        >
          <CloseIcon className="icon-2xs" />
        </button>
      ) : null}
    </div>
  );
}

function SettingsSearchResults({
  highlightedIndex,
  listRef,
  results,
  sections,
  onSelectResult,
}: {
  highlightedIndex: number;
  listRef: React.RefObject<HTMLDivElement | null>;
  results: readonly SettingsSearchResult<SettingsSectionId>[];
  sections: readonly SettingsSectionDefinition[];
  onSelectResult: (result: SettingsSearchResult<SettingsSectionId>) => void;
}) {
  const intl = useIntl();
  const sectionById = useMemo(() => {
    const map = new Map<SettingsSectionId, SettingsSectionDefinition>();

    for (const section of sections) {
      map.set(section.id, section);
    }

    return map;
  }, [sections]);

  if (results.length === 0) {
    return (
      <div className="px-row-x pt-2 text-sm text-token-text-secondary">
        {intl.formatMessage({
          id: "settings.navigation.noResultsFound",
          defaultMessage: "No results found",
        })}
      </div>
    );
  }

  return (
    <div ref={listRef} className="flex flex-col gap-3 pt-1">
      {results.map((result, index) => {
        const section = sectionById.get(result.sectionId);
        const Icon = section?.icon;

        return (
          <div key={`${result.sectionId}:${result.label}`} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 px-row-x py-1 text-base text-tertiary">
              {Icon ? <Icon className="icon-xs shrink-0" /> : null}
              <span className="truncate">{result.panelLabel}</span>
            </div>
            <button
              type="button"
              data-list-navigation-item="true"
              aria-label={intl.formatMessage(
                { id: "settings.navigation.text", defaultMessage: "{label}, {panelLabel}" },
                { label: result.label, panelLabel: result.panelLabel },
              )}
              onClick={() => onSelectResult(result)}
              className={cn(
                "flex h-(--height-token-nav-row) cursor-interaction items-center rounded-(--radius-token-row) pe-2 ps-8 text-left text-base text-token-text-primary outline-none hover:bg-(--color-background-secondary-ghost-hover) focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-solid focus-visible:outline-token-focus-border",
                highlightedIndex === index
                  ? "bg-(--color-background-secondary-ghost-hover)"
                  : undefined,
              )}
            >
              <span className="truncate">{result.label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function SettingsSidebar({
  activeSectionId,
  initialHighlightedSearchIndex,
  initialSearchQuery = "",
  onSelectSection,
  searchContext,
  sections,
}: SettingsSidebarProps) {
  const intl = useIntl();
  const [query, setQuery] = useState(initialSearchQuery);
  const searchResults = useMemo(
    () => searchWorkbenchSettings(sections, searchContext, query, intl),
    [sections, searchContext, query, intl],
  );
  const isSearchActive = settingsQueryRendersResultsMode(query);
  const groupedSections = useMemo(() => groupVisibleSections(sections, intl), [sections, intl]);
  const listNavigation = useSettingsListNavigation({
    autoHighlightFirst: false,
    initialHighlightedIndex: initialHighlightedSearchIndex,
    isActive: isSearchActive,
    items: searchResults,
    onEscape: () => setQuery(""),
    onSelect: (result) => onSelectSection(result.sectionId, query),
  });
  return (
    <aside className="app-shell-left-panel relative mt-[var(--app-shell-content-top-inset,0px)] hidden min-h-0 w-(--app-shell-sidebar-width,var(--spacing-token-sidebar)) shrink-0 flex-col overflow-hidden md:flex">
      <WorkbenchRailEdge />
      <nav
        className={cn(
          "flex min-h-0 flex-1 flex-col select-none",
          WORKBENCH_SIDEBAR_ROW_METRICS_CLASS,
        )}
        aria-label={intl.formatMessage({
          id: "settings.navigation.settings",
          defaultMessage: "Settings",
        })}
      >
        <div className="flex shrink-0 flex-col px-row-x pb-2">
          <WorkbenchSidebarTitleRow
            title={intl.formatMessage({
              id: "settings.navigation.settings",
              defaultMessage: "Settings",
            })}
          />
          <SettingsSearchInput
            query={query}
            onQueryChange={setQuery}
            onKeyDown={listNavigation.onKeyDown}
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-row-x pt-1 pb-2">
          {isSearchActive ? (
            <SettingsSearchResults
              highlightedIndex={listNavigation.highlightedIndex}
              listRef={listNavigation.listRef}
              results={searchResults}
              sections={sections}
              onSelectResult={(result) => onSelectSection(result.sectionId, query)}
            />
          ) : (
            groupedSections.map((group) => (
              <div key={group.groupKey} className="flex flex-col gap-1">
                {group.label ? (
                  <div className="flex min-h-(--height-token-nav-row) items-center px-row-x text-base font-medium text-tertiary">
                    <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  </div>
                ) : null}
                <div className="flex flex-col gap-px">
                  {group.sections.map((section) => (
                    <SettingsSidebarItem
                      key={section.id}
                      active={activeSectionId === section.id}
                      disabled={section.disabled}
                      icon={section.icon}
                      label={intl.formatMessage(section.labelMessage)}
                      sectionId={section.id}
                      onClick={() => onSelectSection(section.id)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </nav>
    </aside>
  );
}

function labelOf(message: MessageDescriptor | null, intl: IntlShape): string | null {
  return message ? intl.formatMessage(message) : null;
}

function groupVisibleSections(
  sections: readonly SettingsSectionDefinition[],
  intl: IntlShape,
): SettingsSectionGroup[] {
  return SETTINGS_SECTION_GROUP_ORDER.flatMap((groupKey) => {
    const groupSections = sections.filter((section) => section.groupKey === groupKey);
    if (groupSections.length === 0) return [];

    return [
      {
        groupKey,
        label: labelOf(SETTINGS_SECTION_GROUP_LABELS[groupKey], intl),
        sections: groupSections,
      },
    ];
  });
}
