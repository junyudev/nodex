import { useIntl } from "@/lib/i18n";
import { useMemo, useState } from "react";
import { z } from "zod";
import { ChevronDownIcon, FolderIcon } from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownMessage,
  NodexDropdownScrollList,
  NodexDropdownSearchInput,
  NodexDropdownSection,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { persistedAtom, usePersistedAtomValue, useSetPersistedAtom } from "@/lib/maitai";
import { COMPOSER_PICKER_ITEM_CLASS_NAME } from "../local-conversation/view/shared/inline-composer-picker";

export interface MiniProject {
  readonly id: string;
  readonly name: string;
}

const locationAtom = persistedAtom({
  debugLabel: "mini-location",
  storageKey: "mini-location-v1",
  defaultValue: { projectId: null as string | null },
  hydration: "eager",
  synchronization: "same-window",
  writeFailure: "retain-and-error",
  decode: (value: unknown) => z.object({ projectId: z.string().min(1).nullable() }).parse(value),
});

/**
 * Where a chat Mini starts works: the Project chosen last, kept until changed, or no Project. A
 * Project that is gone falls back to none, but only once the Projects are read: until then the
 * place is unresolved and nothing is sent.
 */
export function useMiniLocation(projects: readonly MiniProject[] | null) {
  const stored = usePersistedAtomValue(locationAtom);
  const write = useSetPersistedAtom(locationAtom);
  const { projectId } = stored.value;
  const project =
    projectId === null || projects === null
      ? null
      : (projects.find((candidate) => candidate.id === projectId) ?? null);
  return {
    project,
    resolved: stored.status !== "loading" && (projectId === null || projects !== null),
    choose: (next: string | null) => void write(() => ({ projectId: next })).catch(() => undefined),
  };
}

/** Chooses where the next chat Mini starts works, as the chip would. */
export function useChooseMiniLocation() {
  const write = useSetPersistedAtom(locationAtom);
  return (projectId: string | null) => write(() => ({ projectId })).catch(() => undefined);
}

const focusComposerText = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-inbox-composer] textarea");

/** The composer's chip naming where a new chat works, opening the Projects it can work in. */
export function MiniLocationMenu({
  project,
  resolved,
  projects,
  onChange,
}: {
  readonly project: MiniProject | null;
  /** False until the chosen Project is known; the chip names nothing meanwhile. */
  readonly resolved: boolean;
  readonly projects: readonly MiniProject[];
  readonly onChange: (projectId: string | null) => void;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? projects.filter((candidate) => candidate.name.toLowerCase().includes(query))
      : projects;
  }, [projects, search]);
  const noProject = intl.formatMessage({
    id: "mini.location.noProject",
    defaultMessage: "No project",
  });
  const choose = (projectId: string | null) => {
    onChange(projectId);
    setOpen(false);
  };
  return (
    <NodexDropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
      side="top"
      align="start"
      sideOffset={6}
      finalFocus={focusComposerText}
      contentClassName="w-[240px]"
      triggerTooltipContent={intl.formatMessage({
        id: "mini.location.hint",
        defaultMessage: "Where a new chat works",
      })}
      triggerButton={
        <button
          type="button"
          data-mini-location-trigger
          className="cursor-interaction inline-flex h-7 min-w-0 max-w-40 items-center gap-1.5 rounded-full px-2 text-xs text-token-text-secondary hover:bg-token-foreground/[0.07] hover:text-token-foreground data-popup-open:bg-token-foreground/[0.07]"
        >
          <FolderIcon className="icon-xs shrink-0" />
          {resolved ? <span className="min-w-0 truncate">{project?.name ?? noProject}</span> : null}
          <ChevronDownIcon className="icon-2xs shrink-0 opacity-60" />
        </button>
      }
    >
      <NodexDropdownSection className="flex flex-col">
        <NodexDropdownItem
          className={COMPOSER_PICKER_ITEM_CLASS_NAME}
          leftSlot={<FolderIcon className="icon-xs text-token-description-foreground" />}
          rightSlot={project === null ? <NodexDropdownSelectedIcon /> : null}
          onSelect={() => choose(null)}
        >
          {noProject}
        </NodexDropdownItem>
      </NodexDropdownSection>
      {projects.length > 0 ? (
        <>
          <NodexDropdownSeparator />
          <NodexDropdownSection className="flex min-w-0 flex-col overflow-hidden">
            {projects.length > 5 ? (
              <NodexDropdownSearchInput
                className="mb-1"
                value={search}
                placeholder={intl.formatMessage({
                  id: "mini.location.searchProjects",
                  defaultMessage: "Search projects",
                })}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            ) : null}
            <NodexDropdownScrollList className="vertical-scroll-fade-mask max-h-[calc((1lh+var(--padding-row-y)*2)*6)]">
              {filtered.length === 0 ? (
                <NodexDropdownMessage compact>
                  {intl.formatMessage({
                    id: "mini.location.noMatches",
                    defaultMessage: "No projects found",
                  })}
                </NodexDropdownMessage>
              ) : (
                filtered.map((candidate) => (
                  <NodexDropdownItem
                    key={candidate.id}
                    className={COMPOSER_PICKER_ITEM_CLASS_NAME}
                    leftSlot={<FolderIcon className="icon-xs text-token-description-foreground" />}
                    rightSlot={candidate.id === project?.id ? <NodexDropdownSelectedIcon /> : null}
                    onSelect={() => choose(candidate.id)}
                  >
                    {candidate.name}
                  </NodexDropdownItem>
                ))
              )}
            </NodexDropdownScrollList>
          </NodexDropdownSection>
        </>
      ) : null}
    </NodexDropdownMenu>
  );
}
