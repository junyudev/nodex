import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { BrowserBackIcon, CloseIcon, SettingsSearchIcon } from "@/components/shared/icons";
import {
  buildSettingsSearchResults,
  buildSettingsSearchTargets,
  settingsQueryRendersResultsMode,
  type SettingsSearchContext,
  type SettingsSearchResult,
} from "@/lib/settings-search";
import { useSettingsListNavigation } from "@/lib/use-settings-list-navigation";
import { cn } from "@/lib/utils";
import {
  SETTINGS_SECTION_GROUP_LABELS,
  SETTINGS_SECTION_GROUP_ORDER,
  type SettingsSectionDefinition,
  type SettingsSectionGroupKey,
  type SettingsSectionId,
} from "./workbench-settings-sections";
import { buildSettingsPath } from "./workbench-settings-routes";

interface SettingsSidebarProps {
  activeSectionId: SettingsSectionId;
  sections: SettingsSectionDefinition[];
  searchContext: SettingsSearchContext;
  initialSearchQuery?: string;
  initialHighlightedSearchIndex?: number;
  onBack: () => void;
  onSelectSection: (sectionId: SettingsSectionId, searchQuery?: string) => void;
}

interface SettingsSectionGroup {
  groupKey: SettingsSectionGroupKey;
  label: string;
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
    "focus-visible:outline-token-border relative flex h-token-nav-row w-full shrink-0 cursor-interaction items-center gap-2 overflow-hidden rounded-lg px-row-x py-row-y text-left text-sm font-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
    active ? "bg-token-list-hover-background" : "hover:bg-token-list-hover-background",
    disabled ? "cursor-not-allowed opacity-50" : undefined,
  );
  const content = (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 text-base",
        active ? "text-token-list-active-selection-foreground" : "text-token-foreground",
      )}
    >
      <Icon
        className={cn(
          "icon-sm inline-block align-middle",
          active ? "text-token-list-active-selection-icon-foreground" : undefined,
        )}
      />
      <span className="truncate">{label}</span>
    </div>
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
    <div className="mb-4 flex h-token-button-composer w-full shrink-0 items-center rounded-lg border border-token-border-heavy bg-token-input-background/50 text-base leading-[18px] shadow-sm backdrop-blur-sm [.electron-dark_&]:border-token-border [.electron-dark_&]:bg-token-bg-fog [.electron-dark_&]:shadow-none [.electron-dark_&]:backdrop-blur-none">
      <SettingsSearchIcon className="icon-xs ms-2 shrink-0 text-token-input-placeholder-foreground" />
      <input
        ref={inputRef}
        role="searchbox"
        aria-label="Search settings"
        placeholder="Search settings…"
        type="text"
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        className="ms-1 w-full appearance-none border-none bg-transparent py-0 ps-px pe-1.5 text-token-foreground ring-0 outline-none placeholder:text-token-input-placeholder-foreground focus:border-none focus:ring-0 focus:outline-none"
      />
      {query.length > 0 ? (
        <button
          type="button"
          aria-label="Clear settings search"
          onClick={() => {
            onQueryChange("");
            inputRef.current?.focus();
          }}
          className="flex size-7 shrink-0 cursor-interaction items-center justify-center rounded-md text-token-input-placeholder-foreground hover:text-token-foreground"
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
  const sectionById = useMemo(() => {
    const map = new Map<SettingsSectionId, SettingsSectionDefinition>();

    for (const section of sections) {
      map.set(section.id, section);
    }

    return map;
  }, [sections]);

  if (results.length === 0) {
    return <div className="px-row-x pt-2 text-sm text-token-text-secondary">No results found</div>;
  }

  return (
    <div ref={listRef} className="flex flex-col gap-3 pt-1">
      {results.map((result, index) => {
        const section = sectionById.get(result.sectionId);
        const Icon = section?.icon;

        return (
          <div key={`${result.sectionId}:${result.label}`} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 px-row-x py-1 text-base text-token-text-secondary">
              {Icon ? <Icon className="icon-sm shrink-0" /> : null}
              <span className="truncate">{result.panelLabel}</span>
            </div>
            <button
              type="button"
              data-list-navigation-item="true"
              aria-label={`${result.label}, ${result.panelLabel}`}
              onClick={() => onSelectResult(result)}
              className={cn(
                "focus-visible:ring-token-focus-border flex cursor-interaction items-center rounded-lg py-1.5 pe-2 ps-8.5 text-left text-base text-token-foreground hover:bg-token-list-hover-background focus-visible:ring-1 focus-visible:outline-none",
                highlightedIndex === index ? "bg-token-list-hover-background" : undefined,
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
  onBack,
  onSelectSection,
  searchContext,
  sections,
}: SettingsSidebarProps) {
  const [query, setQuery] = useState(initialSearchQuery);
  const searchTargets = useMemo(
    () => buildSettingsSearchTargets(sections, searchContext),
    [searchContext, sections],
  );
  const visibleSectionIds = useMemo(
    () =>
      sections
        .filter((section) => !section.disabled && section.externalUrl == null)
        .map((section) => section.id),
    [sections],
  );
  const searchResults = useMemo(
    () =>
      buildSettingsSearchResults({
        query,
        targets: searchTargets,
        visibleSectionIds,
      }),
    [query, searchTargets, visibleSectionIds],
  );
  const isSearchActive = settingsQueryRendersResultsMode(query);
  const groupedSections = useMemo(() => groupVisibleSections(sections), [sections]);
  const listNavigation = useSettingsListNavigation({
    autoHighlightFirst: false,
    initialHighlightedIndex: initialHighlightedSearchIndex,
    isActive: isSearchActive,
    items: searchResults,
    onEscape: () => setQuery(""),
    onSelect: (result) => onSelectSection(result.sectionId, query),
  });
  return (
    <aside className="app-shell-left-panel relative hidden min-h-0 w-token-sidebar shrink-0 flex-col overflow-hidden md:flex">
      <div className="draggable h-toolbar w-full shrink-0" />
      <nav className="flex min-h-0 flex-1 flex-col select-none px-row-x" aria-label="Settings">
        <div className="flex min-h-0 flex-1 flex-col">
          <button
            type="button"
            onClick={onBack}
            className="group relative mb-2 flex w-full shrink-0 cursor-interaction items-center gap-2 rounded-lg px-row-x py-row-y text-left text-base text-token-text-secondary outline-none hover:bg-token-list-hover-background focus-visible:ring-1 focus-visible:ring-token-focus-border electron:opacity-75"
          >
            <BrowserBackIcon />
            Back to app
          </button>

          <SettingsSearchInput
            query={query}
            onQueryChange={setQuery}
            onKeyDown={listNavigation.onKeyDown}
          />

          <div className="min-h-0 flex-1 overflow-y-auto pb-2 flex flex-col gap-4">
            {isSearchActive ? (
              <SettingsSearchResults
                highlightedIndex={listNavigation.highlightedIndex}
                listRef={listNavigation.listRef}
                results={searchResults}
                sections={sections}
                onSelectResult={(result) => onSelectSection(result.sectionId, query)}
              />
            ) : (
              <>
                {groupedSections.map((group) => (
                  <div key={group.groupKey} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2 pr-0.5 pl-2">
                      <div className="min-w-0 flex-1 text-base text-token-input-placeholder-foreground opacity-75">
                        {group.label}
                      </div>
                    </div>
                    <div className="flex flex-col gap-px">
                      {group.sections.map((section) => (
                        <SettingsSidebarItem
                          key={section.id}
                          active={activeSectionId === section.id}
                          disabled={section.disabled}
                          icon={section.icon}
                          label={section.label}
                          sectionId={section.id}
                          onClick={() => onSelectSection(section.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </nav>
    </aside>
  );
}

function groupVisibleSections(
  sections: readonly SettingsSectionDefinition[],
): SettingsSectionGroup[] {
  return SETTINGS_SECTION_GROUP_ORDER.flatMap((groupKey) => {
    const groupSections = sections.filter((section) => section.groupKey === groupKey);
    if (groupSections.length === 0) return [];

    return [
      {
        groupKey,
        label: SETTINGS_SECTION_GROUP_LABELS[groupKey],
        sections: groupSections,
      },
    ];
  });
}
