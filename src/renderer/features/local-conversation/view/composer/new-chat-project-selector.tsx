import { CloseIcon, FolderIcon, FolderOpenIcon, PlusIcon } from "@/components/shared/icons";
import { useMemo, useState } from "react";
import { toastFailure } from "@/lib/failure-toast";
import { chooseSessionFolder, pickSessionFolder, resetSessionFolder } from "@/lib/session-folders";
import type { SessionFolder } from "@/lib/types";

import { ProjectMarker } from "@/components/workbench/project-marker";
import {
  filterNewChatProjectSelectorOptions,
  resolveSelectedNewChatProjectSelectorOption,
} from "@/lib/new-chat-project-selector";
import type { NewChatProjectSelectorModel, ThreadStageActions } from "../../thread-stage-types";
import { COMPOSER_PICKER_ITEM_CLASS_NAME } from "../shared/inline-composer-picker";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownMessage,
  NodexDropdownScrollList,
  NodexDropdownSearchInput,
  NodexDropdownSection,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
  NodexDropdownTitle,
  NodexTooltip,
} from "./local-conversation-thread-composer-deps";

interface NewChatProjectSelectorProps {
  model: NewChatProjectSelectorModel;
  actions: ThreadStageActions;
  disabled?: boolean;
  variant?: "footer" | "heading";
}

const PROJECT_SELECTOR_MENU_CLASS_NAME = "w-[260px] max-w-[calc(100vw-1rem)]";

const folderName = (path: string) => path.split(/[\\/]/).findLast(Boolean) ?? path;

/**
 * The Chat folder of a draft in no Project. The menu's own choice shows at once; the Session's
 * record takes over when the draft is reopened.
 */
function useDraftChatFolder(model: NewChatProjectSelectorModel) {
  const [local, setLocal] = useState<{
    sessionId: string | undefined;
    folder: SessionFolder | null;
  } | null>(null);
  const folder =
    model.selectedProjectId !== null
      ? null
      : local && local.sessionId === model.sessionId
        ? local.folder
        : (model.folder ?? null);
  const sessionId = model.sessionId;
  const chooseFolder = async () => {
    if (!sessionId) return;
    try {
      const path = await pickSessionFolder();
      if (!path) return;
      setLocal({ sessionId, folder: await chooseSessionFolder(sessionId, path) });
    } catch (error) {
      toastFailure("Couldn’t use that folder", error);
    }
  };
  const resetToNewFolder = async () => {
    if (!sessionId || folder?.origin !== "chosen") return;
    try {
      await resetSessionFolder(sessionId);
      setLocal({ sessionId, folder: null });
    } catch (error) {
      toastFailure("Couldn’t change this chat’s folder", error);
    }
  };
  return { folder, chooseFolder, resetToNewFolder, canChoose: Boolean(sessionId) };
}

export function NewChatProjectSelector({
  model,
  actions,
  disabled = false,
  variant = "footer",
}: NewChatProjectSelectorProps) {
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const selectedOption = resolveSelectedNewChatProjectSelectorOption(
    model.projects,
    model.selectedProjectId,
  );
  const filteredOptions = useMemo(
    () => filterNewChatProjectSelectorOptions(model.projects, search),
    [model.projects, search],
  );
  const selectorDisabled = disabled || model.disabled || !actions.onNewThreadProjectChange;
  const chatFolder = useDraftChatFolder(model);
  const chosenFolder = chatFolder.folder?.origin === "chosen" ? chatFolder.folder : null;
  // With no Project the chip names where the chat works: the folder picked for it, or a new one.
  const triggerLabel =
    selectedOption?.label ?? (chosenFolder ? folderName(chosenFolder.path) : "New folder");
  const headingTriggerLabel = `${selectedOption?.label ?? "Choose project"}?`;
  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (!open) setSearch("");
  };
  const menuContent = (
    <ProjectSelectorMenuContent
      model={model}
      actions={actions}
      search={search}
      setSearch={setSearch}
      filteredOptions={filteredOptions}
      chatFolder={chatFolder}
    />
  );

  if (variant === "heading") {
    return (
      <NodexDropdownMenu
        disabled={selectorDisabled}
        open={menuOpen}
        onOpenChange={handleMenuOpenChange}
        side="top"
        align="center"
        contentWidth="workspace"
        contentMaxHeight="tall"
        contentClassName={PROJECT_SELECTOR_MENU_CLASS_NAME}
        triggerButton={
          <button
            type="button"
            aria-label="Select project"
            data-new-chat-project-selector-trigger="true"
            className="outline-hidden cursor-interaction inline-block max-w-full break-words whitespace-normal underline decoration-token-text-tertiary decoration-dotted decoration-[1px] underline-offset-4 hover:text-token-text-secondary focus-visible:text-token-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
            disabled={selectorDisabled}
          >
            {headingTriggerLabel}
          </button>
        }
      >
        {menuContent}
      </NodexDropdownMenu>
    );
  }

  return (
    <div className="group/project-selector relative inline-flex w-fit max-w-56">
      <NodexDropdownMenu
        disabled={selectorDisabled}
        open={menuOpen}
        onOpenChange={handleMenuOpenChange}
        side="top"
        align="start"
        sideOffset={1}
        triggerTooltipContent={
          selectedOption
            ? "Change the project for this chat"
            : chosenFolder
              ? chosenFolder.path
              : "This chat works in a new folder of its own"
        }
        contentWidth="workspace"
        contentMaxHeight="tall"
        contentClassName={PROJECT_SELECTOR_MENU_CLASS_NAME}
        triggerButton={
          <button
            type="button"
            disabled={selectorDisabled}
            aria-label="Select project"
            data-new-chat-project-selector-trigger="true"
            className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-transparent px-2 text-sm text-token-foreground outline-hidden hover:bg-token-foreground/5 focus-visible:ring-2 focus-visible:ring-token-focus-border data-popup-open:bg-token-foreground/5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {selectedOption ? (
              <ProjectMarker
                appearance={selectedOption.appearance}
                className={
                  selectorDisabled || menuOpen
                    ? "size-4"
                    : "size-4 group-hover/project-selector:invisible"
                }
              />
            ) : chosenFolder ? (
              <FolderOpenIcon className="icon-xs shrink-0" />
            ) : (
              <FolderIcon className="icon-xs shrink-0" />
            )}
            <span className="min-w-0 truncate whitespace-nowrap text-left">{triggerLabel}</span>
          </button>
        }
      >
        {menuContent}
      </NodexDropdownMenu>
      {selectedOption && !selectorDisabled && !menuOpen ? (
        <NodexTooltip tooltipContent="Don't work in a project" side="top">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Don't work in a project"
            className="invisible absolute top-0 left-[3px] inline-flex size-7 items-center justify-center rounded-lg text-token-text-secondary outline-hidden group-hover/project-selector:visible hover:text-token-foreground"
            onClick={() => actions.onNewThreadProjectChange?.(null)}
          >
            <CloseIcon className="icon-xs shrink-0" />
          </button>
        </NodexTooltip>
      ) : null}
    </div>
  );
}

function ProjectSelectorMenuContent({
  model,
  actions,
  search,
  setSearch,
  filteredOptions,
  chatFolder,
}: {
  model: NewChatProjectSelectorModel;
  actions: ThreadStageActions;
  search: string;
  setSearch: (value: string) => void;
  filteredOptions: ReturnType<typeof filterNewChatProjectSelectorOptions>;
  chatFolder: ReturnType<typeof useDraftChatFolder>;
}) {
  const inNoProject = model.selectedProjectId === null;
  const chosenFolder = chatFolder.folder?.origin === "chosen" ? chatFolder.folder : null;
  const showFooter = Boolean(
    (model.canAddProject && actions.onRequestNewChatProjectCreate) ||
    (model.selectedProjectId && actions.onNewThreadProjectChange),
  );

  return (
    <>
      <NodexDropdownSection className="flex min-w-0 flex-col overflow-hidden">
        <NodexDropdownSearchInput
          className="mb-1"
          value={search}
          placeholder="Search projects"
          onChange={(event) => setSearch(event.currentTarget.value)}
          data-new-chat-project-search="true"
        />
        <NodexDropdownScrollList className="vertical-scroll-fade-mask max-h-[calc((1lh+var(--padding-row-y)*2)*5)]">
          {filteredOptions.length === 0 ? (
            <NodexDropdownMessage compact>No projects found</NodexDropdownMessage>
          ) : (
            filteredOptions.map((option) => {
              const selected = option.id === model.selectedProjectId;
              return (
                <NodexDropdownItem
                  className={COMPOSER_PICKER_ITEM_CLASS_NAME}
                  key={option.id}
                  leftSlot={
                    <ProjectMarker
                      appearance={option.appearance}
                      className="size-4 text-token-description-foreground"
                    />
                  }
                  rightSlot={selected ? <NodexDropdownSelectedIcon /> : null}
                  tooltipText={option.primaryWorkspaceRoot ?? undefined}
                  onSelect={() => {
                    actions.onNewThreadProjectChange?.(option.id);
                  }}
                  data-new-chat-project-option={option.id}
                  data-selected={selected ? "true" : undefined}
                >
                  {option.label}
                </NodexDropdownItem>
              );
            })
          )}
        </NodexDropdownScrollList>
      </NodexDropdownSection>

      {showFooter ? (
        <>
          <NodexDropdownSeparator />
          <NodexDropdownSection className="flex flex-col">
            {model.canAddProject && actions.onRequestNewChatProjectCreate ? (
              <NodexDropdownItem
                className={COMPOSER_PICKER_ITEM_CLASS_NAME}
                leftSlot={<PlusIcon className="icon-xs text-token-description-foreground" />}
                onSelect={() => {
                  actions.onRequestNewChatProjectCreate?.();
                }}
                data-new-chat-project-add="true"
              >
                New project
              </NodexDropdownItem>
            ) : null}
            {model.selectedProjectId && actions.onNewThreadProjectChange ? (
              <NodexDropdownItem
                className={COMPOSER_PICKER_ITEM_CLASS_NAME}
                leftSlot={<CloseIcon className="icon-xs text-token-description-foreground" />}
                onSelect={() => {
                  actions.onNewThreadProjectChange?.(null);
                }}
                data-new-chat-project-clear="true"
              >
                Don&apos;t work in a project
              </NodexDropdownItem>
            ) : null}
          </NodexDropdownSection>
        </>
      ) : null}

      {inNoProject && chatFolder.canChoose ? (
        <>
          <NodexDropdownSeparator />
          <NodexDropdownSection className="flex flex-col">
            <NodexDropdownTitle>No project</NodexDropdownTitle>
            <NodexDropdownItem
              className={COMPOSER_PICKER_ITEM_CLASS_NAME}
              leftSlot={<FolderIcon className="icon-xs text-token-description-foreground" />}
              rightSlot={chosenFolder ? null : <NodexDropdownSelectedIcon />}
              tooltipText="Nodex makes a folder for this chat when it first needs one"
              onSelect={() => void chatFolder.resetToNewFolder()}
              data-new-chat-folder-new="true"
              data-selected={chosenFolder ? undefined : "true"}
            >
              New folder
            </NodexDropdownItem>
            {chosenFolder ? (
              <NodexDropdownItem
                className={COMPOSER_PICKER_ITEM_CLASS_NAME}
                leftSlot={<FolderOpenIcon className="icon-xs text-token-description-foreground" />}
                rightSlot={<NodexDropdownSelectedIcon />}
                tooltipText={chosenFolder.path}
                data-new-chat-folder-chosen="true"
                data-selected="true"
              >
                {folderName(chosenFolder.path)}
              </NodexDropdownItem>
            ) : null}
            <NodexDropdownItem
              className={COMPOSER_PICKER_ITEM_CLASS_NAME}
              leftSlot={<FolderOpenIcon className="icon-xs text-token-description-foreground" />}
              onSelect={() => void chatFolder.chooseFolder()}
              data-new-chat-folder-choose="true"
            >
              {chosenFolder ? "Choose another folder…" : "Choose folder…"}
            </NodexDropdownItem>
          </NodexDropdownSection>
        </>
      ) : null}
    </>
  );
}
