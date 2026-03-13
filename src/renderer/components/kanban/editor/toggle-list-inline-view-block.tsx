import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  defaultProps,
} from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import {
  Layers3,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import {
  isCursorWithinOwnerTree,
  useProjectedCardEmbedSync,
} from "./use-projected-card-embed-sync";
import {
  ProjectionDragHandleButton,
  PROJECTION_ACTION_BTN,
} from "./projection-drag-handle";
import { hasRecursiveInlineProjectAncestor } from "./projection-card-toggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { ToggleListSummaryBadges, ToggleListRulesBody } from "@/components/kanban/toggle-list-rules-body";
import {
  getDefaultToggleListInlineViewProps,
  mergeToggleListInlineViewProps,
  parseToggleListInlineViewSettings,
  type ToggleListInlineViewProps,
} from "@/lib/toggle-list/inline-view-props";
import {
  getDefaultToggleListSettings,
} from "@/lib/toggle-list/settings";
import { filterCards, rankCards } from "@/lib/toggle-list/rules";
import type {
  ToggleListSettings,
  ToggleListStatusId,
} from "@/lib/toggle-list/types";
import { useKanban } from "@/lib/use-kanban";
import { normalizeProjectIcon } from "@/lib/project-icon";
import { useProjects } from "@/lib/use-projects";
import { cn } from "@/lib/utils";

const RULES_PANEL_LABEL = "Rules";
const INLINE_RULES_PANEL_STORAGE_KEY = "nodex-toggle-list-inline-rules-panel-v1";

const ACTION_BTN_ACTIVE =
  "text-[var(--foreground)] border-[color-mix(in_srgb,var(--accent-blue)_55%,var(--border))] bg-[color-mix(in_srgb,var(--accent-blue)_8%,var(--card))]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toInlineProps(value: unknown, fallbackProjectId = "default"): ToggleListInlineViewProps {
  const defaults = getDefaultToggleListInlineViewProps(fallbackProjectId);
  if (!isRecord(value)) return defaults;

  return {
    sourceProjectId: typeof value.sourceProjectId === "string"
      ? value.sourceProjectId
      : defaults.sourceProjectId,
    rulesV2B64: typeof value.rulesV2B64 === "string" ? value.rulesV2B64 : defaults.rulesV2B64,
    propertyOrderCsv: typeof value.propertyOrderCsv === "string"
      ? value.propertyOrderCsv
      : defaults.propertyOrderCsv,
    hiddenPropertiesCsv: typeof value.hiddenPropertiesCsv === "string"
      ? value.hiddenPropertiesCsv
      : defaults.hiddenPropertiesCsv,
    showEmptyEstimate: value.showEmptyEstimate === "true" || value.showEmptyEstimate === "false"
      ? value.showEmptyEstimate
      : defaults.showEmptyEstimate,
    showEmptyPriority: value.showEmptyPriority === "true" || value.showEmptyPriority === "false"
      ? value.showEmptyPriority
      : defaults.showEmptyPriority,
  };
}

function isBlockSelected(editor: { getSelection: () => { blocks: Array<{ id: string }> } | undefined }, blockId: string): boolean {
  const selection = editor.getSelection();
  if (!selection) return false;
  return selection.blocks.some((block) => block.id === blockId);
}

interface InlineProjectionEditor {
  getParentBlock: (id: string) => { id?: string } | undefined;
  getTextCursorPosition: () => { block?: { id?: string } } | undefined;
}

interface HostCardContextEditor {
  nodexSourceCardContext?: {
    projectId: string;
    cardId: string;
  } | null;
}

function supportsInlineProjectionEditor(value: unknown): value is InlineProjectionEditor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InlineProjectionEditor>;
  if (typeof candidate.getParentBlock !== "function") return false;
  return typeof candidate.getTextCursorPosition === "function";
}

function readHostCardContext(value: unknown): { projectId: string; cardId: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const runtime = value as HostCardContextEditor;
  const context = runtime.nodexSourceCardContext;
  if (!context) return null;
  if (typeof context.projectId !== "string" || context.projectId.length === 0) return null;
  if (typeof context.cardId !== "string" || context.cardId.length === 0) return null;
  return context;
}

function makeRulesPanelStorageId(
  hostCardContext: { projectId: string; cardId: string } | null,
  sourceProjectId: string,
): string {
  if (!hostCardContext) return `global:${sourceProjectId}`;
  return `${hostCardContext.projectId}:${hostCardContext.cardId}:${sourceProjectId}`;
}

function readRulesPanelExpanded(storageId: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(INLINE_RULES_PANEL_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;
    const value = parsed[storageId];
    return typeof value === "boolean" ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeRulesPanelExpanded(storageId: string, expanded: boolean): void {
  try {
    const raw = localStorage.getItem(INLINE_RULES_PANEL_STORAGE_KEY);
    const parsedRaw = raw !== null ? JSON.parse(raw) : {};
    const parsed = isRecord(parsedRaw) ? parsedRaw : {};
    localStorage.setItem(
      INLINE_RULES_PANEL_STORAGE_KEY,
      JSON.stringify({
        ...parsed,
        [storageId]: expanded,
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

function isInlineViewSelectedOrCursorWithin(
  editor: {
    getSelection: () => { blocks: Array<{ id: string }> } | undefined;
  },
  blockId: string,
): boolean {
  if (isBlockSelected(editor, blockId)) return true;
  if (!supportsInlineProjectionEditor(editor)) return false;
  return isCursorWithinOwnerTree(editor, blockId);
}

export const createToggleListInlineViewBlockSpec = createReactBlockSpec(
  {
    type: "toggleListInlineView" as const,
    propSchema: {
      ...defaultProps,
      sourceProjectId: { default: "default" },
      rulesV2B64: { default: "" },
      propertyOrderCsv: { default: "priority,estimate,status" },
      hiddenPropertiesCsv: { default: "" },
      showEmptyEstimate: { default: "false" },
      showEmptyPriority: { default: "false" },
    },
    content: "none" as const,
  },
  {
    render: ({ block, editor }) => {
      const rawProps = toInlineProps(block.props);
      const hostCardContext = readHostCardContext(editor);
      const sourceProjectId = rawProps.sourceProjectId || "default";
      const settings = useMemo(
        () => parseToggleListInlineViewSettings(rawProps),
        [rawProps],
      );
      const rulesPanelStorageId = makeRulesPanelStorageId(hostCardContext, sourceProjectId);
      const [rulesPanelExpanded, setRulesPanelExpanded] = useState(() =>
        readRulesPanelExpanded(rulesPanelStorageId, false),
      );
      const [focusWithin, setFocusWithin] = useState(false);
      const [selected, setSelected] = useState(
        () => isInlineViewSelectedOrCursorWithin(editor, block.id),
      );

      const { projects } = useProjects();
      const { board, loading, error, updateCard, patchCard, moveCard } = useKanban({
        projectId: sourceProjectId,
      });

      useEffect(() => {
        const syncSelection = () => {
          setSelected(isInlineViewSelectedOrCursorWithin(editor, block.id));
        };
        syncSelection();
        const unsubscribe = editor.onSelectionChange(syncSelection);
        return unsubscribe;
      }, [block.id, editor]);

      useEffect(() => {
        setRulesPanelExpanded(readRulesPanelExpanded(rulesPanelStorageId, false));
      }, [rulesPanelStorageId]);

      useEffect(() => {
        writeRulesPanelExpanded(rulesPanelStorageId, rulesPanelExpanded);
      }, [rulesPanelExpanded, rulesPanelStorageId]);

      const cards = useMemo(() => {
        if (!board) return [];
        return board.columns.flatMap((column, columnIndex) =>
          column.cards.map((card, cardIndex) => ({
            ...card,
            columnId: column.id as ToggleListStatusId,
            columnName: column.name,
            boardIndex: columnIndex * 100_000 + cardIndex,
          })),
        );
      }, [board]);

      const availableTags = useMemo(() => {
        if (!board) return [];
        const uniqueTags = new Set(
          board.columns.flatMap((column) =>
            column.cards.flatMap((card) => card.tags),
          ),
        );
        return Array.from(uniqueTags).sort();
      }, [board]);

      const excludedCardIds = useMemo(() => {
        if (settings.rulesV2.includeHostCard) return undefined;
        if (!hostCardContext) return undefined;
        if (hostCardContext.projectId !== sourceProjectId) return undefined;
        return new Set([hostCardContext.cardId]);
      }, [hostCardContext, settings.rulesV2.includeHostCard, sourceProjectId]);

      const visibleCards = useMemo(
        () => rankCards(filterCards(cards, settings, "", { excludedCardIds }), settings),
        [cards, excludedCardIds, settings],
      );

      const updateBlockProps = useCallback(
        (
          nextSettings: ToggleListSettings,
          nextSourceProjectId: string,
        ) => {
          const next = mergeToggleListInlineViewProps(
            rawProps,
            nextSourceProjectId,
            nextSettings,
          );
          editor.updateBlock(block, { props: next });
        },
        [block, editor, rawProps],
      );

      const updateSettings = useCallback(
        (updater: (current: ToggleListSettings) => ToggleListSettings) => {
          updateBlockProps(updater(settings), sourceProjectId);
        },
        [settings, sourceProjectId, updateBlockProps],
      );

      const toggleRulesPanel = useCallback(() => {
        setRulesPanelExpanded((prev) => !prev);
      }, []);

      const resetSettings = useCallback(() => {
        updateBlockProps(getDefaultToggleListSettings(), sourceProjectId);
      }, [sourceProjectId, updateBlockProps]);

      const active = selected || focusWithin;
      const isRecursive = useMemo(() => {
        if (!supportsInlineProjectionEditor(editor)) return false;
        return hasRecursiveInlineProjectAncestor(editor, block.id, sourceProjectId);
      }, [block.id, editor, sourceProjectId]);

      useProjectedCardEmbedSync({
        ownerBlockId: block.id,
        projectionKind: "toggleListInlineView",
        sourceProjectId,
        cards: !loading && !error && !isRecursive ? visibleCards : [],
        propertyOrder: settings.propertyOrder,
        hiddenProperties: settings.hiddenProperties,
        showEmptyEstimate: settings.showEmptyEstimate,
        showEmptyPriority: settings.showEmptyPriority,
        editor,
        enabled: !isRecursive,
        updateCard,
        patchCard,
        moveCard,
      });

      if (isRecursive) {
        return (
          <section
            className="relative box-border w-full max-w-full rounded-lg bg-transparent p-0"
            data-inline-view-shell
            data-active={active ? "true" : "false"}
            data-inline-source-project={sourceProjectId}
            onFocusCapture={() => setFocusWithin(true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setFocusWithin(false);
              }
            }}
          >
            <div className="flex min-h-8 items-center justify-center rounded-lg border border-dashed border-(--border) text-xl text-(--foreground-secondary)" title="Recursive inline view hidden" contentEditable={false}>
              ∞
            </div>
          </section>
        );
      }

      return (
        <section
          className="relative box-border w-full max-w-full rounded-lg bg-transparent p-0"
          data-inline-view-shell
          data-active={active ? "true" : "false"}
          data-inline-source-project={sourceProjectId}
          onFocusCapture={() => setFocusWithin(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setFocusWithin(false);
            }
          }}
        >
          <div className={cn("pointer-events-none absolute -top-8.5 right-0 inline-flex items-center gap-1 rounded-lg px-0.5 py-0.5 opacity-0 transition-all duration-swift ease-out", active && `pointer-events-auto opacity-100`)} contentEditable={false}>
            <ProjectionDragHandleButton editor={editor} block={block} />
            <Select
              value={sourceProjectId}
              onValueChange={(value) => {
                updateBlockProps(settings, value);
              }}
            >
              <SelectTrigger className={cn(PROJECTION_ACTION_BTN, "h-7! pr-2")}>
                <span className="inline-flex items-center gap-1.5">
                  <Layers3 className="size-3.5" />
                  {sourceProjectId}
                </span>
              </SelectTrigger>
              <SelectContent sideOffset={4}>
                {projects.map((project) => {
                  const icon = normalizeProjectIcon(project.icon);
                  return (
                    <SelectItem key={project.id} value={project.id}>
                      {icon ? `${icon} ${project.name}` : project.name}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>

            <button
              type="button"
              className={cn(
                PROJECTION_ACTION_BTN,
                rulesPanelExpanded && ACTION_BTN_ACTIVE,
              )}
              onClick={toggleRulesPanel}
            >
              <SlidersHorizontal className="size-3.5" />
              {RULES_PANEL_LABEL}
            </button>
          </div>

          {rulesPanelExpanded && (
            <div className="slide-in-from-top-0.5 mb-1 flex animate-in flex-col gap-2 rounded-lg border border-(--border) bg-(--card) p-2.5 duration-150 fade-in-0" contentEditable={false}>
              <div className="flex items-center justify-between gap-2">
                <ToggleListSummaryBadges settings={settings} visibleCount={visibleCards.length} />
                <button
                  type="button"
                  className={cn(PROJECTION_ACTION_BTN, "h-6 px-2")}
                  onClick={resetSettings}
                >
                  <RotateCcw className="size-3" />
                  Reset
                </button>
              </div>

              <ToggleListRulesBody
                settings={settings}
                availableTags={availableTags}
                updateSettings={updateSettings}
                showHostCardToggle
                compact
              />
            </div>
          )}

          <div className="min-h-0" contentEditable={false}>
            {loading && (
              <div className="rounded-lg border border-dashed border-(--border) p-2.5 text-xs text-(--foreground-secondary)">
                Loading toggle list...
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-dashed border-(--border) p-2.5 text-xs text-(--foreground-secondary)">
                Failed to load toggle list.
              </div>
            )}

            {!loading && !error && visibleCards.length === 0 && (
              <div className="rounded-lg border border-dashed border-(--border) p-2.5 text-xs text-(--foreground-secondary)">
                No matching cards.
              </div>
            )}
          </div>
        </section>
      );
    },
  },
);
