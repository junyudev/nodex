import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  Image,
  LayoutGrid,
  PanelRightOpen,
  Search,
  SlidersHorizontal,
  Star,
  Trash2,
} from "lucide-react";
import { CheckmarkIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import {
  getCardActionMenuEntries,
  getCardMoveTargets,
  type CardActionMenuEntry,
  type CardContextMenuProjectSummary,
} from "./card-context-menu-model";
import type { Card as CardType } from "@/lib/types";

interface CardContextMenuProps {
  card: Pick<CardType, "id" | "created">;
  currentColumnId: string;
  currentProjectId: string;
  currentProjectName: string;
  projects: CardContextMenuProjectSummary[];
  onMoveToProject: (projectId: string) => Promise<void> | void;
  onDelete: (input: { cardId: string; columnId: string }) => Promise<void> | void;
  onCopyLink: (input: { cardId: string; projectId: string }) => Promise<void> | void;
  onMenuOpen?: () => void;
  children: ReactNode;
}

type CardContextMenuView = "actions" | "move";

const CONTENT_CLASS_NAME = [
  "z-50 overflow-hidden rounded-[10px] p-1 text-(--foreground) select-none no-drag",
  "bg-[color-mix(in_srgb,var(--background)_94%,transparent)]",
  "shadow-[0_22px_60px_rgba(15,23,42,0.18)] ring-[0.5px] ring-[color-mix(in_srgb,var(--foreground)_12%,transparent)] backdrop-blur-xl",
  "outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.985]",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.985]",
].join(" ");

const ITEM_CLASS_NAME = [
  "flex min-h-7 w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none",
  "data-highlighted:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] data-highlighted:text-(--foreground)",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
].join(" ");

function focusMenuInput(input: HTMLInputElement | null) {
  if (!input) {
    return;
  }

  input.focus();
  const caretPosition = input.value.length;
  input.setSelectionRange(caretPosition, caretPosition);
}

function focusFirstMenuItem(container: HTMLDivElement | null) {
  if (!container) {
    return;
  }

  const firstItem = container.querySelector<HTMLElement>("[data-card-menu-item='true']:not([data-disabled])");
  firstItem?.focus();
}

function formatCreatedLabel(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function getProjectBadgeLabel(project: { label: string; icon?: string }) {
  const icon = project.icon?.trim();
  if (icon) {
    return icon;
  }

  const initial = project.label.trim().slice(0, 1).toUpperCase();
  return initial || "?";
}

function ActionIcon({ entryId }: { entryId: CardActionMenuEntry["id"] }) {
  const className = "size-4 shrink-0";

  switch (entryId) {
    case "favorite":
      return <Star className={className} strokeWidth={1.8} />;
    case "edit-icon":
      return <Image className={className} strokeWidth={1.8} />;
    case "edit-property":
      return <SlidersHorizontal className={className} strokeWidth={1.8} />;
    case "layout":
      return <LayoutGrid className={className} strokeWidth={1.8} />;
    case "property-visibility":
      return <PanelRightOpen className={className} strokeWidth={1.8} />;
    case "open-in":
      return <PanelRightOpen className={className} strokeWidth={1.8} />;
    case "copy-link":
      return <Copy className={className} strokeWidth={1.8} />;
    case "duplicate":
      return <Copy className={className} strokeWidth={1.8} />;
    case "move-to":
      return <ChevronRight className={className} strokeWidth={1.8} />;
    case "delete":
      return <Trash2 className={className} strokeWidth={1.8} />;
  }
}

export function CardContextMenu({
  card,
  currentColumnId,
  currentProjectId,
  currentProjectName,
  projects,
  onMoveToProject,
  onDelete,
  onCopyLink,
  onMenuOpen,
  children,
}: CardContextMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<CardContextMenuView>("actions");
  const [actionQuery, setActionQuery] = useState("");
  const [moveQuery, setMoveQuery] = useState("");
  const hasInitialFocusRedirectRef = useRef(false);
  const actionInputRef = useRef<HTMLInputElement>(null);
  const moveInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const actions = getCardActionMenuEntries(actionQuery);
  const moveTargets = getCardMoveTargets(projects, currentProjectId, moveQuery);
  const canCopyLink = typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const targetInput = view === "actions" ? actionInputRef.current : moveInputRef.current;
    requestAnimationFrame(() => focusMenuInput(targetInput));
  }, [isOpen, view]);

  const handleActionInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowDown") {
      return;
    }

    event.preventDefault();
    focusFirstMenuItem(contentRef.current);
  };

  const handleMoveInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setView("actions");
      return;
    }

    if (event.key !== "ArrowDown") {
      return;
    }

    event.preventDefault();
    focusFirstMenuItem(contentRef.current);
  };

  return (
    <ContextMenuPrimitive.Root
      onOpenChange={(nextOpen) => {
        setIsOpen(nextOpen);

        if (nextOpen) {
          onMenuOpen?.();
        }

        hasInitialFocusRedirectRef.current = false;
        setView("actions");
        setActionQuery("");
        setMoveQuery("");
      }}
    >
      <ContextMenuPrimitive.Trigger asChild>
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          ref={contentRef}
          collisionPadding={8}
          onFocusCapture={(event) => {
            if (hasInitialFocusRedirectRef.current) {
              return;
            }

            if (view !== "actions") {
              return;
            }

            if (event.target === actionInputRef.current) {
              hasInitialFocusRedirectRef.current = true;
              return;
            }

            hasInitialFocusRedirectRef.current = true;
            requestAnimationFrame(() => focusMenuInput(actionInputRef.current));
          }}
          onEscapeKeyDown={(event) => {
            if (view !== "move") {
              return;
            }

            event.preventDefault();
            setView("actions");
          }}
          className={cn(CONTENT_CLASS_NAME, view === "move" ? "w-[330px]" : "w-[265px]")}
        >
          <div className="flex flex-col gap-1">
            {view === "actions" ? (
              <>
                <div className="px-1 pt-1">
                  <label className="flex h-7 items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-2 text-sm text-(--foreground-secondary)">
                    <Search className="size-3.5 shrink-0" strokeWidth={1.9} />
                    <input
                      ref={actionInputRef}
                      value={actionQuery}
                      onChange={(event) => setActionQuery(event.target.value)}
                      onKeyDown={handleActionInputKeyDown}
                      onPointerDown={(event) => event.stopPropagation()}
                      placeholder="Search actions…"
                      className="h-full min-w-0 flex-1 border-none bg-transparent p-0 text-(--foreground) outline-none placeholder:text-(--foreground-tertiary)"
                    />
                  </label>
                </div>

                <div className="px-3 pt-2 pb-1 text-xs font-medium tracking-wide text-(--foreground-tertiary)">
                  Page
                </div>

                {actions.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-(--foreground-secondary)">
                    No actions found
                  </div>
                ) : (
                  actions.map((entry) => (
                    <ContextMenuPrimitive.Item
                      key={entry.id}
                      disabled={entry.disabled || (entry.id === "copy-link" && !canCopyLink)}
                      data-card-menu-item="true"
                      onSelect={(event) => {
                        if (entry.id === "move-to") {
                          event.preventDefault();
                          setMoveQuery("");
                          setView("move");
                          return;
                        }

                        if (entry.id === "copy-link") {
                          void onCopyLink({
                            cardId: card.id,
                            projectId: currentProjectId,
                          });
                          return;
                        }

                        if (entry.id === "delete") {
                          void onDelete({
                            cardId: card.id,
                            columnId: currentColumnId,
                          });
                        }
                      }}
                      className={cn(
                        ITEM_CLASS_NAME,
                        entry.id === "delete"
                          ? "data-highlighted:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] data-highlighted:text-(--destructive)"
                          : null,
                      )}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center text-(--foreground-secondary)">
                        <ActionIcon entryId={entry.id} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      {entry.shortcut ? (
                        <span className="shrink-0 text-xs text-(--foreground-tertiary)">
                          {entry.shortcut}
                        </span>
                      ) : null}
                      {entry.id === "move-to" ? (
                        <ChevronRight className="size-3.5 shrink-0 text-(--foreground-tertiary)" strokeWidth={1.9} />
                      ) : null}
                    </ContextMenuPrimitive.Item>
                  ))
                )}
              </>
            ) : (
              <>
                <div className="px-1 pt-1">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setView("actions")}
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-(--foreground-secondary) hover:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] hover:text-(--foreground)"
                      aria-label="Back to actions"
                    >
                      <ArrowLeft className="size-3.5" strokeWidth={1.9} />
                    </button>
                    <label className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-2 text-sm text-(--foreground-secondary)">
                      <Search className="size-3.5 shrink-0" strokeWidth={1.9} />
                      <input
                        ref={moveInputRef}
                        value={moveQuery}
                        onChange={(event) => setMoveQuery(event.target.value)}
                        onKeyDown={handleMoveInputKeyDown}
                        onPointerDown={(event) => event.stopPropagation()}
                        placeholder="Move task to project…"
                        className="h-full min-w-0 flex-1 border-none bg-transparent p-0 text-(--foreground) outline-none placeholder:text-(--foreground-tertiary)"
                      />
                    </label>
                  </div>
                </div>

                <div className="flex items-center px-3 pt-2 pb-1 text-xs font-medium tracking-wide text-(--foreground-tertiary)">
                  <span className="truncate">Projects</span>
                  <span className="ml-auto shrink-0 tabular-nums">
                    {projects.length}
                  </span>
                </div>

                {moveTargets.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-(--foreground-secondary)">
                    No projects found
                  </div>
                ) : (
                  moveTargets.map((target) => (
                    <ContextMenuPrimitive.Item
                      key={target.id}
                      disabled={target.disabled}
                      data-card-menu-item="true"
                      onSelect={() => {
                        if (target.disabled) {
                          return;
                        }

                        void onMoveToProject(target.id);
                      }}
                      className={cn(
                        "flex min-h-[45px] w-full cursor-default items-start gap-2 rounded-lg px-2 py-2 text-sm outline-none",
                        "data-highlighted:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] data-highlighted:text-(--foreground)",
                        "data-[disabled]:opacity-70",
                      )}
                    >
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)] text-xs">
                        {getProjectBadgeLabel(target)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-(--foreground)">
                          {target.label}
                        </span>
                        <span className="block truncate pt-0.5 text-xs text-(--foreground-secondary)">
                          {target.description}
                        </span>
                      </span>
                      {target.isCurrent ? (
                        <CheckmarkIcon className="mt-0.5 shrink-0 text-(--foreground-tertiary)" />
                      ) : null}
                    </ContextMenuPrimitive.Item>
                  ))
                )}
              </>
            )}

            <ContextMenuPrimitive.Separator className="mx-2 my-1 h-px bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]" />

            <div className="px-3 pt-0.5 pb-2 text-xs text-(--foreground-tertiary)">
              <div className="truncate">{currentProjectName}</div>
              <div className="truncate pt-0.5">Created {formatCreatedLabel(card.created)}</div>
            </div>
          </div>
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
