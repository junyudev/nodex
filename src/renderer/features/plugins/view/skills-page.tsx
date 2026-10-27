import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { RecordIcon, SkillCubeIcon } from "@/components/shared/icons/customize-action-icons";
import { BrowseTabs } from "@/components/ui/browse-tabs";
import { PageSearchInput } from "@/components/ui/page-search-input";
import { SearchablePageLayout } from "@/components/ui/searchable-page-layout";
import { PageEmptyState, PageSection } from "@/components/ui/section-header";
import { toast } from "@/components/ui/toast";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import type { RecommendedSkill } from "../../../../shared/codex-plugin-settings";
import type { CustomizeNavigation } from "../customize-navigation";
import { pluginMutationSucceeded } from "../model/mutation-result";
import { skillDisplayName } from "../model/plugin-detail-model";
import { groupSkillsByScope, markdownLink, skillsVisibleLimit } from "../model/skill-model";
import {
  usePluginManagement,
  useRecommendedSkillInstallIds,
  useSkillsPageData,
  type PluginContext,
} from "../plugin-management";
import { CustomizeHeaderActions } from "./customize-header-actions";
import { usePluginHelperActions } from "./use-plugin-helper-actions";
import { RecommendedSkillCard, SkillCard } from "./skill-card";

const SKILL_CREATOR_OPENED_KEY = "nodex.customize.skill-creator-opened";
const RECOMMENDED_TAB_ID = "skills-recommended";

type RecommendedEntry = RecommendedSkill & { readonly installedSkill: SkillMetadata | null };

/** The "See A, B, and N more" row that unfolds a long skill list, then folds it back. */
function SeeMoreSkillsRow({
  expanded,
  hiddenNames,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly hiddenNames: readonly string[];
  readonly onToggle: () => void;
}) {
  const remaining = Math.max(hiddenNames.length - 2, 0);
  return (
    <button
      type="button"
      aria-expanded={expanded}
      className="flex min-h-(--height-token-row) w-full cursor-interaction items-center rounded-(--radius-token-row) px-(--padding-row-x) py-(--padding-row-y) text-start text-sm leading-relaxed font-normal text-token-description-foreground outline-hidden hover:text-token-foreground focus-visible:text-token-foreground"
      onClick={onToggle}
    >
      {expanded
        ? "Show less"
        : `See ${hiddenNames.slice(0, 2).join(", ")}${remaining === 0 ? "" : `, and ${remaining} more`}`}
    </button>
  );
}

/** A one- or two-column grid of skills, folded to six when long enough. */
function SkillsGrid({
  skills,
  context,
  navigation,
  fold,
  highlightedPath = null,
}: {
  readonly skills: readonly SkillMetadata[];
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
  readonly fold: boolean;
  readonly highlightedPath?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const limit = fold ? skillsVisibleLimit(skills.length) : null;
  const visible = limit == null || expanded ? skills : skills.slice(0, limit);
  return (
    <>
      <div
        className={
          limit == null
            ? "grid grid-cols-1 gap-4 @min-[581px]/skills-grid:grid-cols-2"
            : "grid grid-cols-1 gap-2 @min-[581px]/skills-grid:grid-cols-2"
        }
      >
        {visible.map((skill) => (
          <SkillCard
            key={skill.path}
            skill={skill}
            context={context}
            onStartChat={navigation.onStartChat}
            isHighlighted={highlightedPath === skill.path}
          />
        ))}
      </div>
      {limit == null ? null : (
        <SeeMoreSkillsRow
          expanded={expanded}
          hiddenNames={skills.slice(limit).map(skillDisplayName)}
          onToggle={() => setExpanded(!expanded)}
        />
      )}
    </>
  );
}

function SkillsLoading() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center py-8">
      <div role="status" className="flex items-center gap-2 text-sm text-(--color-text-secondary)">
        <ActivitySpinnerIcon className="icon-xs" />
        Loading skills…
      </div>
    </div>
  );
}

/** The first chat with the skill creator also says what it is for. */
function skillCreatorDraft(path: string): string {
  const firstTime = window.localStorage.getItem(SKILL_CREATOR_OPENED_KEY) == null;
  window.localStorage.setItem(SKILL_CREATOR_OPENED_KEY, "1");
  const mention = markdownLink("$skill-creator", path);
  return firstTime ? `${mention} help me create a skill` : `${mention} `;
}

/**
 * The recommended catalog: rows to install, or the installed skill a recommendation matches
 * (highlighted on the Recommended tab). Folds to six like installed lists.
 */
function RecommendedSkillsList({
  entries,
  context,
  navigation,
  isLoading,
  errorMessage,
  installingSkillId,
  installedIds,
  highlightInstalled,
  highlightedId = null,
  showAll = false,
  onInstall,
}: {
  readonly entries: readonly RecommendedEntry[];
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
  readonly isLoading: boolean;
  readonly errorMessage: string | null;
  readonly installingSkillId: string | null;
  readonly installedIds: ReadonlySet<string>;
  readonly highlightInstalled: boolean;
  readonly highlightedId?: string | null;
  readonly showAll?: boolean;
  readonly onInstall: (skill: RecommendedSkill) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (isLoading) return <SkillsLoading />;
  if (errorMessage != null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center py-8">
        <PageEmptyState title="Unable to load recommended skills" description={errorMessage} />
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center py-8">
        <PageEmptyState title="No skills found" />
      </div>
    );
  }
  const limit = showAll ? null : skillsVisibleLimit(entries.length);
  const visible = limit == null || expanded ? entries : entries.slice(0, limit);
  return (
    <>
      <div className="grid grid-cols-1 gap-2 @min-[581px]/skills-grid:grid-cols-2">
        {visible.map((entry) =>
          entry.installedSkill == null ? (
            <RecommendedSkillCard
              key={entry.id}
              skill={entry}
              context={context}
              canInstall={context.hostId === "local"}
              isInstalled={installedIds.has(entry.id)}
              isInstalling={installingSkillId === entry.id}
              isHighlighted={highlightedId === entry.id}
              onInstall={onInstall}
            />
          ) : (
            <SkillCard
              key={entry.id}
              skill={entry.installedSkill}
              context={context}
              onStartChat={navigation.onStartChat}
              mode="menu"
              isHighlighted={highlightInstalled || highlightedId === entry.id}
            />
          ),
        )}
      </div>
      {limit == null ? null : (
        <SeeMoreSkillsRow
          expanded={expanded}
          hiddenNames={entries.slice(limit).map((entry) => entry.name)}
          onToggle={() => setExpanded(!expanded)}
        />
      )}
    </>
  );
}

/**
 * Skills: everything installed outside plugins, then the same skills by where they are
 * installed, and a recommended catalog to install from. Search narrows everything into one list
 * navigable with the arrow keys.
 */
export function SkillsPage({
  context,
  navigation,
}: {
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
}) {
  const [search, setSearch] = useState("");
  const data = useSkillsPageData(context, search);
  const installIds = useRecommendedSkillInstallIds(context);
  const management = usePluginManagement(context);
  const helpers = usePluginHelperActions(context, navigation);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const skillsQuery = data.skillsQuery;
  const recommendedQuery = data.recommendedQuery;
  const installedIds = new Set(installIds.data);
  const searching = search.trim().length > 0;
  const installed = data.installed;
  const recommended = data.recommended;
  const recommendedError =
    recommendedQuery.error?.message ?? recommendedQuery.data?.error?.message ?? null;
  const showRecommended =
    recommendedQuery.isPending || recommendedError != null || recommended.length > 0;
  const groups = groupSkillsByScope(installed);
  const tabs = [
    ...groups.map((group) => ({ key: group.id, name: group.title })),
    ...(showRecommended ? [{ key: RECOMMENDED_TAB_ID, name: "Recommended" }] : []),
  ];
  const selectedTabId = tabs.some((tab) => tab.key === selectedGroupId)
    ? selectedGroupId
    : (tabs[0]?.key ?? null);
  const selectedGroup = groups.find((group) => group.id === selectedTabId);
  const resultKeys = searching
    ? [
        ...installed.map((skill) => `installed:${skill.path}`),
        ...recommended.map((skill) => `recommended:${skill.id}`),
      ]
    : [];
  const activeKey =
    resultKeys.length === 0 ? null : resultKeys[Math.min(activeIndex, resultKeys.length - 1)];
  // The skill that writes skills; a personal or project copy takes the place of the built-in one.
  const skillCreator = skillsQuery.data?.installed.find((skill) => skill.name === "skill-creator");

  const installRecommended = async (skill: RecommendedSkill) => {
    setInstallingSkillId(skill.id);
    try {
      const result = await management.installRecommendedSkill({ id: skill.id, scope: "user" });
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
      toast.success(`${skillDisplayName({ name: skill.name })} skill installed`);
    } catch {
      toast.danger("Failed to install skill");
    } finally {
      setInstallingSkillId(null);
    }
  };

  const focusSearch = useEffectEvent(() => searchRef.current?.focus());
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
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

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!searching || resultKeys.length === 0) return;
    const scrollActiveIntoView = () =>
      window.requestAnimationFrame(() =>
        contentRef.current
          ?.querySelector("[data-search-result-active='true']")
          ?.scrollIntoView({ block: "nearest" }),
      );
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => Math.min(Math.max(index + step, 0), resultKeys.length - 1));
      scrollActiveIntoView();
    } else if (event.key === "Enter") {
      const active = contentRef.current?.querySelector("[data-search-result-active='true']");
      if (active instanceof HTMLElement) {
        event.preventDefault();
        active.click();
      }
    }
  };

  const recommendedList = (props: { highlightInstalled: boolean; showAll?: boolean }) => (
    <RecommendedSkillsList
      entries={recommended}
      context={context}
      navigation={navigation}
      isLoading={recommendedQuery.isPending}
      errorMessage={recommendedError}
      installingSkillId={installingSkillId}
      installedIds={installedIds}
      highlightedId={activeKey?.startsWith("recommended:") ? activeKey.slice(12) : null}
      onInstall={(skill) => void installRecommended(skill)}
      {...props}
    />
  );

  let content: ReactNode;
  if (skillsQuery.isPending) {
    content = <SkillsLoading />;
  } else if (skillsQuery.isError) {
    content = (
      <PageEmptyState title="Failed to load skills" description={skillsQuery.error.message} />
    );
  } else if (searching) {
    content =
      resultKeys.length === 0 ? (
        <div className="text-base text-(--color-text-secondary)">No skills found</div>
      ) : (
        <PageSection id="skills-search-results" title="Skills" count={resultKeys.length}>
          <div className="flex flex-col gap-3">
            {installed.length > 0 ? (
              <SkillsGrid
                skills={installed}
                context={context}
                navigation={navigation}
                fold={false}
                highlightedPath={activeKey?.startsWith("installed:") ? activeKey.slice(10) : null}
              />
            ) : null}
            {recommended.length > 0
              ? recommendedList({ highlightInstalled: false, showAll: true })
              : null}
          </div>
        </PageSection>
      );
  } else if (installed.length === 0 && !showRecommended) {
    content = (
      <div className="flex min-h-0 flex-1 items-center justify-center py-8">
        <PageEmptyState title="No skills found" />
      </div>
    );
  } else {
    content = (
      <>
        {installed.length > 0 ? (
          <PageSection id="skills-installed" title="Installed">
            <SkillsGrid skills={installed} context={context} navigation={navigation} fold />
          </PageSection>
        ) : null}
        {selectedTabId == null ? null : (
          <div className="mb-2">
            <BrowseTabs
              ariaLabel="Skill directory"
              tabs={tabs}
              selectedKey={selectedTabId}
              onSelect={setSelectedGroupId}
            />
          </div>
        )}
        {selectedGroup == null ? null : (
          <SkillsGrid
            key={selectedGroup.id}
            skills={selectedGroup.skills}
            context={context}
            navigation={navigation}
            fold
          />
        )}
        {selectedTabId === RECOMMENDED_TAB_ID
          ? recommendedList({ highlightInstalled: true })
          : null}
      </>
    );
  }

  return (
    <SearchablePageLayout
      contentClassName="pt-2"
      title="Skills"
      subtitle="Extend Codex with task-specific skills"
      search={
        <PageSearchInput
          inputRef={searchRef}
          id="plugins-page-search"
          label="Search skills"
          placeholder="Search skills"
          className="min-w-0 flex-1"
          searchQuery={search}
          onSearchQueryChange={(value) => {
            setSearch(value);
            setActiveIndex(0);
          }}
          onKeyDown={onSearchKeyDown}
        />
      }
      headerAction={
        <CustomizeHeaderActions
          context={context}
          onManage={navigation.onOpenSettings}
          addActions={[
            {
              id: "skill",
              label: "Create skill",
              icon: <SkillCubeIcon />,
              disabled: skillCreator == null,
              onSelect: () => {
                if (skillCreator != null)
                  navigation.onStartChat(skillCreatorDraft(skillCreator.path));
              },
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
      }
    >
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col gap-8 pb-(--padding-panel)">
        {content}
      </div>
    </SearchablePageLayout>
  );
}
