import { runWithCleanup } from "@/lib/run-with-cleanup";
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
import { PlusMdIcon } from "@/components/shared/icons/plugin-detail-icons";
import { PageSearchInput } from "@/components/ui/page-search-input";
import { SearchablePageLayout } from "@/components/ui/searchable-page-layout";
import { PageEmptyState, PageSection } from "@/components/ui/section-header";
import { toast } from "@/components/ui/toast";
import { useSkillInventory } from "@/features/skills/skill-inventory";
import {
  describeSkillReaders,
  displaySkillLocation,
  groupSkillLocations,
} from "@/features/skills/skill-presentation";
import { SkillLocationsList, useCreateSkill } from "@/features/skills/view/skill-locations-list";
import type { RecommendedSkill } from "../../../../shared/codex-plugin-settings";
import type { CustomizeNavigation } from "../customize-navigation";
import { pluginMutationSucceeded } from "../model/mutation-result";
import { skillDisplayName } from "../model/plugin-detail-model";
import { markdownLink, skillsVisibleLimit } from "../model/skill-model";
import {
  usePluginManagement,
  useRecommendedSkillInstallIds,
  useSkillsPageData,
  type PluginContext,
} from "../plugin-management";
import { buildSkillPath } from "../plugins-routes";
import { CustomizeHeaderActions } from "./customize-header-actions";
import { usePluginHelperActions } from "./use-plugin-helper-actions";
import { RecommendedSkillCard } from "./skill-card";
import { skillEntryTryPrompt } from "./skill-route-page";

const SKILL_CREATOR_OPENED_KEY = "nodex.customize.skill-creator-opened";

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

/** Skills to install from the recommended catalog, folded to six unless a search lists them. */
function RecommendedSkills({
  skills,
  context,
  installingSkillId,
  installedIds,
  highlightedId,
  showAll,
  onInstall,
}: {
  readonly skills: readonly RecommendedSkill[];
  readonly context: PluginContext;
  readonly installingSkillId: string | null;
  readonly installedIds: ReadonlySet<string>;
  readonly highlightedId: string | null;
  readonly showAll: boolean;
  readonly onInstall: (skill: RecommendedSkill) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const limit = showAll ? null : skillsVisibleLimit(skills.length);
  const visible = limit == null || expanded ? skills : skills.slice(0, limit);
  return (
    <PageSection id="skills-recommended" title="Recommended">
      <div className="grid grid-cols-1 gap-2 @min-[581px]/skills-grid:grid-cols-2">
        {visible.map((skill) => (
          <RecommendedSkillCard
            key={skill.id}
            skill={skill}
            context={context}
            canInstall={context.hostId === "local"}
            isInstalled={installedIds.has(skill.id)}
            isInstalling={installingSkillId === skill.id}
            isHighlighted={highlightedId === skill.id}
            onInstall={onInstall}
          />
        ))}
      </div>
      {limit == null ? null : (
        <SeeMoreSkillsRow
          expanded={expanded}
          hiddenNames={skills.slice(limit).map((skill) => skill.name)}
          onToggle={() => setExpanded(!expanded)}
        />
      )}
    </PageSection>
  );
}

/**
 * Skills: every skill under the folder it lives in, with the Agents that read that folder, then
 * a recommended catalog to install from. A skill opens as its own page. Search narrows both
 * lists and the arrow keys walk the results.
 */
export function SkillsPage({
  context,
  navigation,
}: {
  readonly context: PluginContext;
  readonly navigation: CustomizeNavigation;
}) {
  const [search, setSearch] = useState("");
  const inventory = useSkillInventory(context);
  const data = useSkillsPageData(context, search);
  const installIds = useRecommendedSkillInstallIds(context);
  const management = usePluginManagement(context);
  const helpers = usePluginHelperActions(context, navigation);
  const createSkill = useCreateSkill(context);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const snapshot = inventory.data?.status === "ok" ? inventory.data.value : null;
  const failure =
    inventory.error?.message ??
    (inventory.data?.status === "failed" ? inventory.data.message : null);
  const installedIds = new Set(installIds.data);
  const searching = search.trim().length > 0;
  // A recommendation that matches an installed skill is already in the list above.
  const recommended = data.recommended.filter((entry) => entry.installedSkill == null);
  const listed = snapshot ? groupSkillLocations(snapshot, search) : { groups: [], empty: [] };
  const resultKeys = searching
    ? [
        ...listed.groups.flatMap((group) => group.skills.map((skill) => `skill:${skill.id}`)),
        ...recommended.map((skill) => `recommended:${skill.id}`),
      ]
    : [];
  const activeKey =
    resultKeys.length === 0 ? null : resultKeys[Math.min(activeIndex, resultKeys.length - 1)];
  // The skill that writes skills; a personal or project copy takes the place of the built-in one.
  const skillCreator = data.skillsQuery.data?.installed.find(
    (skill) => skill.name === "skill-creator",
  );
  const personalLocations = (snapshot?.locations ?? []).filter(
    (location) => location.writable && location.scope === "user",
  );

  const openSkill = (skillId: string, options?: { readonly created?: boolean }) =>
    navigation.onNavigate(buildSkillPath(skillId, options));

  const installRecommended = async (skill: RecommendedSkill) => {
    setInstallingSkillId(skill.id);
    return runWithCleanup(
      async () => {
        const result = await management.installRecommendedSkill({ id: skill.id, scope: "user" });
        if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
        toast.success(`${skillDisplayName({ name: skill.name })} skill installed`);
      },
      {
        onError: () => {
          toast.danger("Failed to install skill");
        },
        cleanup: () => {
          setInstallingSkillId(null);
        },
      },
    );
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
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => Math.min(Math.max(index + step, 0), resultKeys.length - 1));
      window.requestAnimationFrame(() =>
        contentRef.current
          ?.querySelector("[data-search-result-active='true']")
          ?.scrollIntoView({ block: "nearest" }),
      );
    } else if (event.key === "Enter") {
      const active = contentRef.current?.querySelector("[data-search-result-active='true']");
      const target = active?.querySelector("button") ?? active;
      if (target instanceof HTMLElement) {
        event.preventDefault();
        target.click();
      }
    }
  };

  let content: ReactNode;
  if (inventory.isPending) {
    content = <SkillsLoading />;
  } else if (snapshot == null) {
    content = <PageEmptyState title="Failed to load skills" description={failure} />;
  } else if (searching && resultKeys.length === 0) {
    content = <div className="text-base text-(--color-text-secondary)">No skills found</div>;
  } else {
    content = (
      <>
        <SkillLocationsList
          context={context}
          snapshot={snapshot}
          search={search}
          highlightedSkillId={activeKey?.startsWith("skill:") ? activeKey.slice(6) : null}
          onOpenSkill={openSkill}
          onTry={(skill) => navigation.onStartChat(skillEntryTryPrompt(skill))}
        />
        {recommended.length === 0 ? null : (
          <RecommendedSkills
            skills={recommended}
            context={context}
            installingSkillId={installingSkillId}
            installedIds={installedIds}
            highlightedId={activeKey?.startsWith("recommended:") ? activeKey.slice(12) : null}
            showAll={searching}
            onInstall={(skill) => void installRecommended(skill)}
          />
        )}
      </>
    );
  }

  return (
    <SearchablePageLayout
      contentClassName="pt-2"
      title="Skills"
      subtitle="What your Agents know how to do, kept in the folders each of them reads"
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
            ...personalLocations.map((location) => ({
              id: `new:${location.id}`,
              label:
                personalLocations.length === 1
                  ? "New skill"
                  : `New skill in ${displaySkillLocation(location)} · ${describeSkillReaders(location.readers).replace(/ reads? this folder$/u, "")}`,
              icon: <PlusMdIcon />,
              onSelect: () => {
                void createSkill(location).then((skillId) => {
                  if (skillId) openSkill(skillId, { created: true });
                });
              },
            })),
            {
              id: "skill",
              label: "Create with skill-creator",
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
