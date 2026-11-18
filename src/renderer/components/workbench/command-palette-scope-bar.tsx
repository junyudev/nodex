import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref, RefObject } from "react";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CommandMenuMode } from "@/lib/command-palette";
import type { Project } from "@/lib/types";
import { NodexTabsList, NodexTabsTab } from "@/components/ui/tabs";
import { DropdownChevronIcon } from "@/components/shared/icons";
import { WorkbenchSpaceIcon } from "@/components/shared/icons/workbench-navigation-icons";
import {
  NodexDropdownContent,
  NodexDropdownPortal,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
  NodexDropdownRoot,
  NodexDropdownTrigger,
} from "@/components/ui/dropdown";
import { COMMAND_PALETTE_SEARCH_OPTION_CLASS_NAME } from "./command-palette-workspace-toolbar";
import { ProjectMarker } from "./project-marker";

/** Plain F6 moves focus between the search input and the current scope's search options. */
export function isSearchOptionsFocusKey(event: ReactKeyboardEvent): boolean {
  return (
    event.key === "F6" &&
    !event.defaultPrevented &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229
  );
}

/**
 * The palette's footer: scope tabs on the left, the selected scope's search options on the
 * right, wrapping under the tabs when the palette is narrow. The tabs tighten in a narrow
 * palette and scroll rather than widen it. F6 anywhere inside returns focus to the search input.
 */
export function CommandPaletteScopeBar({
  ref,
  mode,
  scopes,
  scopeLabel,
  options,
  focusSearch,
}: {
  ref?: Ref<HTMLDivElement>;
  mode: CommandMenuMode;
  scopes: readonly { readonly mode: CommandMenuMode; readonly label: string }[];
  scopeLabel: (label: string) => string;
  options: ReactNode;
  focusSearch: () => void;
}) {
  const intl = useIntl();
  return (
    <div
      ref={ref}
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 border-t-[0.5px] border-token-border py-1 pe-2 select-none @min-[700px]:flex-nowrap"
      onKeyDown={(event) => {
        if (!isSearchOptionsFocusKey(event)) return;
        event.preventDefault();
        focusSearch();
      }}
    >
      <NodexTabsList
        activateOnFocus
        aria-label={intl.formatMessage({
          id: "workbench.commandPaletteSurface.searchScope",
          defaultMessage: "Search scope",
        })}
        className="flex max-w-full min-w-0 items-center gap-px overflow-x-auto overflow-y-hidden [scrollbar-width:none] @min-[700px]:shrink-0 [&::-webkit-scrollbar]:hidden"
      >
        {scopes.map((scope) => (
          <NodexTabsTab
            key={scope.mode}
            value={scope.mode}
            onMouseDown={(event) => event.preventDefault()}
            className={cn(
              "flex h-8 shrink-0 items-center rounded-[calc(var(--radius-2xl)-var(--spacing)-1px)] px-2.5 text-base font-medium outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-token-focus-border @min-[480px]:px-3",
              mode === scope.mode
                ? "bg-background-primary-ghost-hover text-token-foreground"
                : "text-tertiary hover:bg-background-primary-ghost-hover",
            )}
          >
            {scopeLabel(scope.label)}
          </NodexTabsTab>
        ))}
      </NodexTabsList>
      {options ? (
        <div
          role="toolbar"
          aria-label={intl.formatMessage({
            id: "workbench.commandPaletteSurface.searchOptions",
            defaultMessage: "Search options",
          })}
          tabIndex={-1}
          data-search-options
          className="ms-auto flex min-w-0 items-center justify-end gap-2"
        >
          {options}
        </div>
      ) : null}
    </div>
  );
}

/** Narrows Pages and chats to one Project; "Everywhere" searches the whole Library. */
export function CommandPalettePlaceMenu({
  triggerRef,
  projects,
  selectedProject,
  onSelectProject,
  inputRef,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  projects: readonly Project[];
  selectedProject: Project | undefined;
  onSelectProject: (projectId: string | null) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const intl = useIntl();
  return (
    <NodexDropdownRoot>
      <NodexDropdownTrigger ref={triggerRef}>
        <button type="button" className={cn(COMMAND_PALETTE_SEARCH_OPTION_CLASS_NAME, "max-w-48")}>
          {selectedProject ? (
            <ProjectMarker appearance={selectedProject.appearance} />
          ) : (
            <WorkbenchSpaceIcon className="icon-xs shrink-0" />
          )}
          <span className="truncate">
            {selectedProject?.name ??
              intl.formatMessage({
                id: "workbench.commandPaletteSurface.everywhere",
                defaultMessage: "Everywhere",
              })}
          </span>
          <DropdownChevronIcon className="icon-xs shrink-0" />
        </button>
      </NodexDropdownTrigger>
      <NodexDropdownPortal>
        <NodexDropdownContent align="end" side="top" finalFocus={inputRef}>
          <NodexDropdownRadioGroup
            value={selectedProject?.id ?? ""}
            onValueChange={(value) => onSelectProject(value || null)}
          >
            <NodexDropdownRadioItem value="" leftSlot={<WorkbenchSpaceIcon className="icon-xs" />}>
              <FormattedMessage
                id="workbench.commandPaletteSurface.everywhere"
                defaultMessage="Everywhere"
              />
            </NodexDropdownRadioItem>
            {projects.map((project) => (
              <NodexDropdownRadioItem
                key={project.id}
                value={project.id}
                leftSlot={<ProjectMarker appearance={project.appearance} />}
              >
                {project.name}
              </NodexDropdownRadioItem>
            ))}
          </NodexDropdownRadioGroup>
        </NodexDropdownContent>
      </NodexDropdownPortal>
    </NodexDropdownRoot>
  );
}
