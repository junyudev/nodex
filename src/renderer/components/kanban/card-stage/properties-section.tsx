import { BranchSelectorPopover } from "@/components/workbench/stage-threads/branch-selector-popover";
import { EnvironmentSelectorPopover } from "@/components/workbench/stage-threads/environment-selector-popover";
import { ThreadsIcon } from "@/components/workbench/threads-icon";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { SchedulePopover } from "@/components/kanban/schedule-popover";
import {
  CheckboxSquareIcon,
  DescriptionIcon,
  PeopleIcon,
  TagIcon,
} from "@/components/shared/property-icons";
import { cn } from "@/lib/utils";
import type { CardRunInTarget } from "@/lib/types";
import {
  cardStagePropertyEmptyValueInteractive,
  cardStagePropertyInputChrome,
  cardStagePropertyInputPlaceholder,
  cardStagePropertyTextSize,
  cardStagePropertyTriggerChrome,
  cardStagePropertyValueHoverSurface,
} from "./property-value-styles";
import type { CardStageController } from "./use-card-stage-controller";

interface CardStagePropertiesSectionProps {
  controller: CardStageController;
}

export function CardStagePropertiesSection({ controller }: CardStagePropertiesSectionProps) {
  if (!controller.card) return null;

  const {
    card,
    tags,
    tagInput,
    tagInputRef,
    tagDropdownRef,
    tagOptions,
    tagHighlight,
    tagDropdownOpen,
    showTagCreate,
    tagCreateValue,
    tagItemCount,
    hasTagDropdownItems,
    tagInputActive,
    assignee,
    agentStatus,
    agentBlocked,
    runInTarget,
    runInLocalPathDisplay,
    runInWorktreePathDisplay,
    runInEnvironmentPath,
    runInBranchState,
    runInBranchBusy,
    runInEnvironmentOptions,
    runInEnvironmentBusy,
    selectedRunInBaseBranch,
    linkedCodexThreads,
    onOpenCodexThread,
    onOpenNewCodexThread,
    saving,
    hasThreadsRow,
    schedule,
    showCollapsedProperties,
    collapseTagsByDefault,
    collapseAssigneeByDefault,
    collapseThreadsByDefault,
    collapseScheduleByDefault,
    collapseAgentBlockedByDefault,
    collapseAgentStatusByDefault,
    collapsedPropertyCount,
    collapsedPropertyLabel,
    propertiesExpanded,
    setPropertiesExpanded,
    setTagInput,
    setTagHighlight,
    setTagDropdownOpen,
    setTagInputActive,
    handleAddTag,
    handleRemoveTag,
    handleTagInputBlur,
    handleAssigneeChange,
    handleAssigneeBlur,
    handleRunInTargetChange,
    handlePickRunInLocalPath,
    handleClearRunInLocalPath,
    handleResetRunInWorktreePath,
    refreshRunInBranchState,
    handleSelectRunInBaseBranch,
    refreshRunInEnvironmentOptions,
    handleSelectRunInEnvironmentPath,
    handleOpenEnvironmentSettings,
    handleOpenCodexThread,
    handleToggleAgentBlocked,
    handleAgentStatusChange,
    handleAgentStatusBlur,
  } = controller;

  return (
    <div className="border-b border-(--table-border) pb-3">
      <div className="flex items-center gap-2 py-0.75 pl-1.5">
        <span className="text-base/4.5 font-medium text-(--foreground-secondary)">Properties</span>
      </div>

      <div className="flex flex-col pb-1">
        {(showCollapsedProperties || !collapseTagsByDefault) && (
          <div className="flex min-h-7.5 items-center">
            <div className="flex w-40 shrink-0 items-center gap-1.5 pl-1.5">
              <div className="flex w-5 items-center justify-center text-(--foreground-secondary)">
                <TagIcon />
              </div>
              <span className="text-sm/5 font-normal text-(--foreground-secondary)">Tags</span>
            </div>
            <div className="flex flex-1 flex-wrap items-center gap-1.5 px-2">
              {tags.length === 0 && !tagInput && !tagInputActive ? (
                <button
                  type="button"
                  onClick={() => {
                    setTagInputActive(true);
                    requestAnimationFrame(() => tagInputRef.current?.focus());
                  }}
                  className={cardStagePropertyEmptyValueInteractive}
                >
                  Empty
                </button>
              ) : (
                <>
                  {tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      className={cn(
                        "inline-flex h-5 items-center rounded-sm px-1.5 text-sm",
                        "bg-(--gray-bg) text-(--foreground-secondary)",
                        "hover:bg-(--red-bg) hover:text-(--red-text)",
                        "transition-colors duration-100",
                      )}
                    >
                      {tag} &times;
                    </button>
                  ))}

                  <div className="relative">
                    <Input
                      ref={tagInputRef}
                      value={tagInput}
                      onChange={(event) => {
                        setTagInput(event.target.value);
                        setTagHighlight(0);
                        setTagDropdownOpen(true);
                      }}
                      onKeyDown={(event) => {
                        const showingDropdown = tagDropdownOpen && hasTagDropdownItems;
                        if (event.key === "ArrowDown" && showingDropdown) {
                          event.preventDefault();
                          setTagHighlight((index) => (index + 1) % tagItemCount);
                          return;
                        }

                        if (event.key === "ArrowUp" && showingDropdown) {
                          event.preventDefault();
                          setTagHighlight((index) => (index <= 0 ? tagItemCount - 1 : index - 1));
                          return;
                        }

                        if (event.key === "Tab" && showingDropdown && tagHighlight >= 0) {
                          event.preventDefault();
                          const value = tagHighlight < tagOptions.length
                            ? tagOptions[tagHighlight]
                            : tagCreateValue;
                          handleAddTag(value);
                          return;
                        }

                        if (event.key === "Enter") {
                          event.preventDefault();
                          if (showingDropdown && tagHighlight >= 0) {
                            const value = tagHighlight < tagOptions.length
                              ? tagOptions[tagHighlight]
                              : tagCreateValue;
                            handleAddTag(value);
                            return;
                          }
                          handleAddTag();
                          return;
                        }

                        if (event.key === "Escape" && showingDropdown) {
                          event.preventDefault();
                          setTagDropdownOpen(false);
                          setTagHighlight(-1);
                        }
                      }}
                      onFocus={() => {
                        setTagDropdownOpen(true);
                        setTagHighlight(0);
                      }}
                      onBlur={handleTagInputBlur}
                      className={cn(
                        cardStagePropertyInputChrome,
                        cardStagePropertyInputPlaceholder,
                        cardStagePropertyTextSize,
                        cardStagePropertyValueHoverSurface,
                        "h-6 w-15 px-1",
                      )}
                      placeholder="+ Add"
                    />

                    {tagDropdownOpen && hasTagDropdownItems && (
                      <div
                        ref={tagDropdownRef}
                        className={cn(
                          "absolute top-full left-0 z-50 mt-1",
                          "max-w-70 min-w-50",
                          "overflow-hidden rounded-lg",
                          "border border-(--border)",
                          "bg-(--popover) text-(--popover-foreground)",
                          "shadow-[0_4px_16px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)]",
                        )}
                      >
                        <div className="px-2.5 py-2">
                          <span className="text-sm text-(--foreground-tertiary)">
                            Select an option or create one
                          </span>
                        </div>

                        {tagOptions.map((tag, index) => (
                          <button
                            key={tag}
                            type="button"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              handleAddTag(tag);
                              tagInputRef.current?.focus();
                            }}
                            onMouseEnter={() => setTagHighlight(index)}
                            onMouseLeave={() => setTagHighlight(-1)}
                            className={cn(
                              "flex w-full items-center gap-2 px-2.5 py-1.25 text-base",
                              "cursor-pointer transition-colors duration-75",
                              index === tagHighlight
                                ? "bg-black/4 dark:bg-white/6"
                                : "hover:bg-black/4 dark:hover:bg-white/6",
                            )}
                          >
                            <svg width="10" height="14" viewBox="0 0 10 14" className="shrink-0 opacity-40">
                              <circle cx="2.5" cy="3" r="1.2" fill="currentColor" />
                              <circle cx="7.5" cy="3" r="1.2" fill="currentColor" />
                              <circle cx="2.5" cy="7" r="1.2" fill="currentColor" />
                              <circle cx="7.5" cy="7" r="1.2" fill="currentColor" />
                              <circle cx="2.5" cy="11" r="1.2" fill="currentColor" />
                              <circle cx="7.5" cy="11" r="1.2" fill="currentColor" />
                            </svg>
                            <span
                              className={cn(
                                "inline-flex h-5 items-center rounded-sm px-1.5 text-base",
                                "bg-(--gray-bg) text-(--foreground-secondary)",
                              )}
                            >
                              {tag}
                            </span>
                          </button>
                        ))}

                        {showTagCreate && (
                          <button
                            type="button"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              handleAddTag(tagCreateValue);
                              tagInputRef.current?.focus();
                            }}
                            onMouseEnter={() => setTagHighlight(tagOptions.length)}
                            onMouseLeave={() => setTagHighlight(-1)}
                            className={cn(
                              "flex w-full items-center gap-2 px-2.5 py-1.25 text-base",
                              "cursor-pointer transition-colors duration-75",
                              "border-t border-(--border)",
                              tagOptions.length === tagHighlight
                                ? "bg-black/4 dark:bg-white/6"
                                : "hover:bg-black/4 dark:hover:bg-white/6",
                            )}
                          >
                            <span className="text-(--foreground-secondary)">Create</span>
                            <span
                              className={cn(
                                "inline-flex h-5 items-center rounded-sm px-1.5 text-base",
                                "bg-(--gray-bg) text-(--foreground-secondary)",
                              )}
                            >
                              {tagCreateValue}
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {(showCollapsedProperties || !collapseAssigneeByDefault) && (
          <div className="flex min-h-7.5 items-center">
            <div className="flex w-40 shrink-0 items-center gap-1.5 pl-1.5">
              <div className="flex w-5 items-center justify-center text-(--foreground-secondary)">
                <PeopleIcon />
              </div>
              <span className="text-sm/5 font-normal text-(--foreground-secondary)">Assignee</span>
            </div>
            <div className="flex-1 px-2">
              <Input
                value={assignee}
                onChange={(event) => handleAssigneeChange(event.target.value)}
                onBlur={handleAssigneeBlur}
                className={cn(
                  cardStagePropertyInputChrome,
                  cardStagePropertyInputPlaceholder,
                  cardStagePropertyTextSize,
                  cardStagePropertyValueHoverSurface,
                  "h-auto w-full px-0 text-(--foreground)",
                  !assignee && "text-(--foreground-tertiary)",
                )}
                placeholder="Empty"
              />
            </div>
          </div>
        )}

        {hasThreadsRow && (showCollapsedProperties || !collapseThreadsByDefault) && (
          <div className="space-y-1.5">
            <div className="flex min-h-7.5 items-center">
              <div className="flex w-40 shrink-0 items-center gap-1.5 pl-1.5">
                <div className="flex w-5 items-center justify-center text-(--foreground-secondary)">
                  <ThreadsIcon />
                </div>
                <span className="text-sm/5 font-normal text-(--foreground-secondary)">Threads</span>
              </div>

              <div className="flex flex-1 items-center justify-between gap-2 px-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Select value={runInTarget} onValueChange={(value) => {
                    void handleRunInTargetChange(value as CardRunInTarget);
                  }}>
                    <SelectTrigger
                      className={cn(
                        cardStagePropertyTriggerChrome,
                        cardStagePropertyValueHoverSurface,
                        "gap-1 px-0",
                      )}
                    >
                      <span className="inline-flex h-5 items-center rounded-sm bg-(--gray-bg) px-1.5 text-xs text-(--foreground-secondary)">
                        {runInTarget === "localProject"
                          ? "Local project"
                          : runInTarget === "newWorktree"
                            ? runInWorktreePathDisplay
                              ? "Worktree"
                              : "New worktree"
                            : "Cloud (mock)"}
                      </span>
                    </SelectTrigger>
                    <SelectContent sideOffset={4}>
                      <SelectItem value="localProject">Local project</SelectItem>
                      <SelectItem value="newWorktree">{runInWorktreePathDisplay ? "Worktree" : "New worktree"}</SelectItem>
                      <SelectItem value="cloud">Cloud (mock)</SelectItem>
                    </SelectContent>
                  </Select>

                  {runInTarget === "localProject" && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          void handlePickRunInLocalPath();
                        }}
                        className={cn(
                          "inline-flex h-5 max-w-full items-center rounded-xs border border-(--border) px-1.5 text-xs transition-colors",
                          "text-(--foreground-secondary) hover:bg-(--background-tertiary) hover:text-(--foreground)",
                        )}
                        title={runInLocalPathDisplay || "Use project workspace path"}
                      >
                        <span className="truncate">{runInLocalPathDisplay || "Project cwd"}</span>
                      </button>

                      {runInLocalPathDisplay && (
                        <button
                          type="button"
                          onClick={handleClearRunInLocalPath}
                          className="text-(--foreground-disabled) transition-colors hover:text-(--foreground-secondary)"
                          aria-label="Clear run folder override"
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M9 3L3 9M3 3l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                    </>
                  )}

                  {runInTarget === "newWorktree" && !runInWorktreePathDisplay && (
                    <>
                      <BranchSelectorPopover
                        cwd={controller.projectWorkspacePath?.trim() || null}
                        state={runInBranchState}
                        busy={runInBranchBusy}
                        selectedBranch={selectedRunInBaseBranch}
                        onRefresh={async () => {
                          await refreshRunInBranchState();
                        }}
                        onCheckout={handleSelectRunInBaseBranch}
                        triggerClassName="h-6"
                      />

                      <EnvironmentSelectorPopover
                        options={runInEnvironmentOptions}
                        selectedPath={runInEnvironmentPath}
                        busy={runInEnvironmentBusy}
                        onRefresh={refreshRunInEnvironmentOptions}
                        onSelect={handleSelectRunInEnvironmentPath}
                        onOpenSettings={handleOpenEnvironmentSettings}
                        triggerClassName="h-6"
                      />

                      {selectedRunInBaseBranch && controller.runInBaseBranch.trim().length === 0 && (
                        <span className="text-xs text-(--foreground-tertiary)">Default</span>
                      )}
                    </>
                  )}

                  {runInTarget === "newWorktree" && runInWorktreePathDisplay && (
                    <button
                      type="button"
                      onClick={handleResetRunInWorktreePath}
                      className={cn(
                        "inline-flex h-5 items-center rounded-xs border border-(--border) px-1.5 text-xs transition-colors",
                        "text-(--foreground-secondary) hover:bg-(--background-tertiary) hover:text-(--foreground)",
                      )}
                      title={runInWorktreePathDisplay}
                    >
                      Reset worktree
                    </button>
                  )}

                  {linkedCodexThreads.length > 0 && (
                    <span className="inline-flex h-5 items-center rounded-xs bg-(--blue-bg) px-1.5 text-xs/5 text-(--blue-text)">
                      {`${linkedCodexThreads.length} linked`}
                    </span>
                  )}

                  {onOpenNewCodexThread && (
                    <button
                      type="button"
                      onClick={onOpenNewCodexThread}
                      className={cn(
                        "inline-flex h-5 items-center rounded-xs border border-(--border) px-1.5 text-xs transition-colors",
                        "text-(--foreground-secondary) hover:bg-(--background-tertiary) hover:text-(--foreground)",
                      )}
                      disabled={saving}
                    >
                      New
                    </button>
                  )}
                </div>
              </div>
            </div>

            {runInTarget === "cloud" && (
              <div className="ml-40 px-2 text-xs text-(--foreground-tertiary)">
                Mock UI only. Starting new threads is blocked for Cloud.
              </div>
            )}

            {linkedCodexThreads.length > 0 && (
              <div className="ml-40 max-h-33 space-y-1 overflow-y-auto px-2 pr-0.5">
                {linkedCodexThreads.map((thread) => (
                  <button
                    key={thread.threadId}
                    type="button"
                    disabled={!onOpenCodexThread}
                    onClick={() => {
                      void handleOpenCodexThread(thread.threadId);
                    }}
                    className={cn(
                      "w-full rounded-sm border border-(--border) px-2 py-1.5 text-left transition-colors",
                      "bg-(--background) hover:bg-(--background-tertiary)",
                      "disabled:opacity-60 disabled:hover:bg-(--background)",
                    )}
                  >
                    <div className="truncate text-xs/4 text-(--foreground)">{thread.title}</div>
                    {thread.preview && (
                      <div className="truncate text-xs/4 text-(--foreground-tertiary)">{thread.preview}</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {(showCollapsedProperties || !collapseScheduleByDefault) && (
          <SchedulePopover schedule={schedule} card={card} />
        )}

        {(showCollapsedProperties || !collapseAgentBlockedByDefault) && (
          <div className="flex min-h-7.5 items-center">
            <div className="flex w-40 shrink-0 items-center gap-1.5 pl-1.5">
              <div className="flex w-5 items-center justify-center text-(--foreground-secondary)">
                <CheckboxSquareIcon />
              </div>
              <span className="text-sm/5 font-normal text-(--foreground-secondary)">Agent blocked</span>
            </div>
            <div className="flex-1 px-2">
              <button
                type="button"
                onClick={handleToggleAgentBlocked}
                className={cn(
                  cardStagePropertyValueHoverSurface,
                  "flex items-center gap-2 px-1 py-0.5",
                )}
              >
                {agentBlocked ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <rect x="0.5" y="0.5" width="15" height="15" rx="2.5" fill="var(--accent-blue)" stroke="var(--accent-blue)" />
                    <path d="M4.5 8L7 10.5L11.5 5.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <rect x="0.5" y="0.5" width="15" height="15" rx="2.5" stroke="var(--foreground-disabled)" />
                  </svg>
                )}
                <span className={cn("text-sm/5", agentBlocked ? "text-(--destructive)" : `text-(--foreground-tertiary)`)}>
                  {agentBlocked ? "Yes" : "No"}
                </span>
              </button>
            </div>
          </div>
        )}

        {(showCollapsedProperties || !collapseAgentStatusByDefault) && (
          <div className="flex min-h-7.5 items-center">
            <div className="flex w-40 shrink-0 items-center gap-1.5 pl-1.5">
              <div className="flex w-5 items-center justify-center text-(--foreground-secondary)">
                <DescriptionIcon />
              </div>
              <span className="text-sm/5 font-normal text-(--foreground-secondary)">Agent status</span>
            </div>
            <div className="flex-1 px-2">
              <Input
                value={agentStatus}
                onChange={(event) => handleAgentStatusChange(event.target.value)}
                onBlur={handleAgentStatusBlur}
                className={cn(
                  cardStagePropertyInputChrome,
                  cardStagePropertyInputPlaceholder,
                  cardStagePropertyTextSize,
                  cardStagePropertyValueHoverSurface,
                  "h-auto w-full px-0 font-mono text-(--blue-text)",
                  "placeholder:font-sans",
                  !agentStatus && "font-sans text-(--foreground-tertiary)",
                )}
                placeholder="Empty"
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col">
        {propertiesExpanded && (
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-sm pr-2 pl-1.5 transition-colors hover:bg-(--background-tertiary)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0">
              <path d="M8 2.65a.75.75 0 0 1 .75.75v3.85h3.85a.75.75 0 1 1 0 1.5H8.75v3.85a.75.75 0 1 1-1.5 0V8.75H3.4a.75.75 0 1 1 0-1.5h3.85V3.4A.75.75 0 0 1 8 2.65Z" fill="var(--foreground-tertiary)" />
            </svg>
            <span className="text-sm/4 font-normal text-(--foreground-tertiary)">Add a property</span>
          </button>
        )}

        {collapsedPropertyCount > 0 && (
          <button
            type="button"
            onClick={() => setPropertiesExpanded((current) => !current)}
            className="flex h-8 items-center gap-1.5 rounded-sm pr-2 pl-1.5 transition-colors hover:bg-(--background-tertiary)"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              className={cn("shrink-0 transition-transform", !propertiesExpanded && "rotate-180")}
            >
              <path d="M8.53 5.07a.75.75 0 0 0-1.06 0l-4.32 4.32a.75.75 0 1 0 1.06 1.06L8 6.66l3.79 3.79a.75.75 0 1 0 1.06-1.06L8.53 5.07Z" fill="var(--foreground-tertiary)" />
            </svg>
            <span className="text-sm/4 font-normal text-(--foreground-tertiary)">
              {collapsedPropertyLabel}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
