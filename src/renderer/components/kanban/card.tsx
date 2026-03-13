import { Fragment, forwardRef, memo, useCallback, useMemo, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CardPropertyPosition } from "@/lib/card-property-position";
import type { DbViewDisplayPrefs, DbViewDisplayPropertyKey } from "../../lib/db-view-prefs";
import { resolveKanbanPriorityOption } from "../../lib/kanban-options";
import { EMPTY_DISPLAY_VALUE_TOKEN, getMetaChipClassName } from "../../lib/toggle-list/meta-chips";
import { estimateStyles } from "@/lib/types";
import type { Card as CardType, Priority } from "@/lib/types";
import { useCardPropertyPosition } from "@/lib/use-card-property-position";
import { useActiveTerminals } from "@/lib/terminal-sessions";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import { extractPlainText } from "@/lib/nfm/extract-text";
import { ChipPropertyEditor } from "./editor/chip-property-editor";
import { CardContextMenu } from "./card-context-menu";
import type { CardContextMenuProjectSummary } from "./card-context-menu-model";
import { shouldFreezeSameColumnPreview } from "./sortable-preview-mode";

type CardEditableProperty = "priority" | "estimate";
type CardPropertyBadgeLayout = "stacked" | "inline";
type KanbanCardDisplayProperty = Extract<DbViewDisplayPropertyKey, "priority" | "estimate" | "tags" | "assignee">;

const DEFAULT_KANBAN_CARD_DISPLAY_ORDER: KanbanCardDisplayProperty[] = [
  "priority",
  "estimate",
  "tags",
  "assignee",
];
const TAG_CHIP_CLASS_NAME =
  "inline-flex h-4.5 items-center rounded-sm bg-(--gray-bg) px-1.5 text-xs/snug-plus text-(--foreground-secondary)";
const EMPTY_VALUE_CHIP_CLASS_NAME = getMetaChipClassName(EMPTY_DISPLAY_VALUE_TOKEN);

export interface CardPropertyUpdateInput {
  cardId: string;
  columnId: string;
  property: CardEditableProperty;
  value: string;
}

interface CardProps {
  card: CardType;
  columnId: string;
  displayPrefs?: DbViewDisplayPrefs;
  dragDisabled?: boolean;
  isFocused?: boolean;
  isSelected?: boolean;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onUpdateProperty?: (input: CardPropertyUpdateInput) => Promise<void> | void;
  contextMenu?: {
    currentColumnId: string;
    currentProjectId: string;
    currentProjectName: string;
    projects: CardContextMenuProjectSummary[];
    onMoveToProject: (projectId: string) => Promise<void> | void;
    onDelete: (input: { cardId: string; columnId: string }) => Promise<void> | void;
    onCopyLink: (input: { cardId: string; projectId: string }) => Promise<void> | void;
    onMenuOpen?: () => void;
  };
}

interface CardBodyProps {
  card: CardType;
  columnId: string;
  displayPrefs?: DbViewDisplayPrefs;
  hasTerminal: boolean;
  position: CardPropertyPosition;
  activeProperty: CardEditableProperty | null;
  onOpenPropertyEditor?: (
    property: CardEditableProperty,
    currentToken: string,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  onChipPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
}

const PRIORITY_TOKEN_BY_VALUE: Record<Priority, string> = {
  "p0-critical": "P0",
  "p1-high": "P1",
  "p2-medium": "P2",
  "p3-low": "P3",
  "p4-later": "P4",
};

function CardPropertyBadges({
  card,
  columnId,
  displayPrefs,
  hasTerminal,
  layout = "stacked",
  className,
  activeProperty,
  onOpenPropertyEditor,
  onChipPointerDown,
}: {
  card: CardType;
  columnId: string;
  displayPrefs?: DbViewDisplayPrefs;
  hasTerminal: boolean;
  layout?: CardPropertyBadgeLayout;
  className?: string;
  activeProperty: CardEditableProperty | null;
  onOpenPropertyEditor?: (
    property: CardEditableProperty,
    currentToken: string,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  onChipPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  const priorityOption = resolveKanbanPriorityOption(card.priority);
  const priorityLabel = priorityOption?.label.split(" - ")[0] ?? priorityOption?.label;
  const estimateToken = card.estimate ? card.estimate.toUpperCase() : "-";
  const chipsAreEditable = typeof onOpenPropertyEditor === "function";
  const assigneeClassName = layout === "inline"
    ? "text-xs text-(--foreground-tertiary)"
    : "ml-auto text-xs text-(--foreground-tertiary)";
  const Container = layout === "inline" ? "span" : "div";
  const propertyOrder = (displayPrefs?.propertyOrder ?? DEFAULT_KANBAN_CARD_DISPLAY_ORDER)
    .filter(
      (property): property is KanbanCardDisplayProperty =>
        DEFAULT_KANBAN_CARD_DISPLAY_ORDER.includes(property as KanbanCardDisplayProperty),
    );
  const hiddenProperties = new Set(
    (displayPrefs?.hiddenProperties ?? [])
      .filter(
        (property): property is KanbanCardDisplayProperty =>
          DEFAULT_KANBAN_CARD_DISPLAY_ORDER.includes(property as KanbanCardDisplayProperty),
      ),
  );
  const showEmptyEstimate = displayPrefs?.showEmptyEstimate ?? false;
  const showEmptyPriority = displayPrefs?.showEmptyPriority ?? false;

  const renderEditableChip = (
    property: CardEditableProperty,
    currentToken: string,
    label: string,
    className: string,
  ) => {
    if (!chipsAreEditable) {
      return (
        <span className={className}>
          {label}
        </span>
      );
    }

    return (
      <button
        type="button"
        data-card-property-trigger={property}
        data-card-property-card-id={card.id}
        data-card-property-column-id={columnId}
        className={cn(
          className,
          "cursor-pointer border-none outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent-blue)_55%,transparent)] focus-visible:ring-offset-2 focus-visible:ring-offset-(--card)",
        )}
        aria-label={`Edit ${property}`}
        aria-haspopup="listbox"
        aria-expanded={activeProperty === property}
        onPointerDown={onChipPointerDown}
        onClick={(event) => {
          if (!onOpenPropertyEditor) {
            return;
          }
          onOpenPropertyEditor(property, currentToken, event);
        }}
      >
        {label}
      </button>
    );
  };

  const renderTagChip = (label: string) => (
    <span className={TAG_CHIP_CLASS_NAME}>
      {label}
    </span>
  );

  const renderEmptyValueChip = (property: CardEditableProperty) =>
    renderEditableChip(
      property,
      EMPTY_DISPLAY_VALUE_TOKEN,
      EMPTY_DISPLAY_VALUE_TOKEN,
      EMPTY_VALUE_CHIP_CLASS_NAME,
    );

  const renderProperty = (property: KanbanCardDisplayProperty) => {
    if (hiddenProperties.has(property)) return null;

    if (property === "priority") {
      if (!priorityOption || !card.priority || !priorityLabel) {
        if (!showEmptyPriority) return null;
        return renderEmptyValueChip("priority");
      }
      return renderEditableChip(
        "priority",
        PRIORITY_TOKEN_BY_VALUE[card.priority],
        priorityLabel,
        cn(
          "inline-flex h-4.5 items-center rounded-sm px-1.5 text-xs/snug-plus",
          priorityOption.className,
        ),
      );
    }

    if (property === "estimate") {
      if (!card.estimate) {
        if (!showEmptyEstimate) return null;
        return renderEmptyValueChip("estimate");
      }
      return renderEditableChip(
        "estimate",
        estimateToken,
        estimateStyles[card.estimate].label,
        cn(
          "inline-flex h-4.5 items-center rounded-sm px-1.5 text-xs/snug-plus",
          estimateStyles[card.estimate].className,
        ),
      );
    }

    if (property === "tags") {
      if (card.tags.length === 0) return null;
      return card.tags.map((tag) => (
        <Fragment key={tag}>
          {renderTagChip(tag)}
        </Fragment>
      ));
    }

    if (property === "assignee") {
      if (!card.assignee) return null;
      return (
        <span className={assigneeClassName}>
          @{card.assignee}
        </span>
      );
    }

    return null;
  };

  return (
    <Container
      className={cn(
        layout === "inline"
          ? "mr-1 inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 align-middle"
          : "flex flex-wrap items-center gap-x-1.5 gap-y-1",
        className,
      )}
    >
      {propertyOrder.map((property) => (
        <Fragment key={property}>
          {renderProperty(property)}
        </Fragment>
      ))}

      {hasTerminal && (
        <span className="inline-flex h-4.5 items-center rounded-sm bg-(--foreground)/6 px-1.25 font-mono text-xs/4.5 tracking-tight text-(--foreground-secondary)">
          $<span className="ml-px h-2.75 w-1.25 animate-[terminal-blink_1s_step-end_infinite] bg-current" />
        </span>
      )}
    </Container>
  );
}

const CardBody = memo(function CardBody({
  card,
  columnId,
  displayPrefs,
  hasTerminal,
  position,
  activeProperty,
  onOpenPropertyEditor,
  onChipPointerDown,
}: CardBodyProps) {
  const propertiesAtTop = position === "top";
  const propertiesInline = position === "inline";
  const plainDescription = useMemo(
    () => (card.description ? extractPlainText(card.description, 120) : null),
    [card.description],
  );

  return (
    <>
      {propertiesAtTop ? (
        <CardPropertyBadges
          card={card}
          columnId={columnId}
          displayPrefs={displayPrefs}
          hasTerminal={hasTerminal}
          layout="stacked"
          className="mx-1.5 pt-2 pb-1"
          activeProperty={activeProperty}
          onOpenPropertyEditor={onOpenPropertyEditor}
          onChipPointerDown={onChipPointerDown}
        />
      ) : null}

      <div className={cn("px-2 pb-1", propertiesAtTop ? "pt-0" : "pt-2")}>
        {propertiesInline ? (
          <h3 className="text-base/normal font-medium wrap-break-word text-(--foreground)">
            <CardPropertyBadges
              card={card}
              columnId={columnId}
              displayPrefs={displayPrefs}
              hasTerminal={hasTerminal}
              layout="inline"
              activeProperty={activeProperty}
              onOpenPropertyEditor={onOpenPropertyEditor}
              onChipPointerDown={onChipPointerDown}
            />
            <span className="align-middle">{card.title}</span>
          </h3>
        ) : (
          <h3 className="text-base/normal font-medium wrap-break-word text-(--foreground)">
            {card.title}
          </h3>
        )}
      </div>

      {card.agentStatus ? (
        <p className="truncate px-2.5 pb-1 font-mono text-sm/normal text-(--blue-text)">
          {card.agentStatus}
        </p>
      ) : null}

      {plainDescription ? (
        <p className="line-clamp-2 px-2 pb-1 text-xs/normal wrap-break-word text-(--foreground-secondary)">
          {plainDescription}
        </p>
      ) : null}

      {position === "bottom" ? (
        <CardPropertyBadges
          card={card}
          columnId={columnId}
          displayPrefs={displayPrefs}
          hasTerminal={hasTerminal}
          layout="stacked"
          className="mx-1.5 pb-2"
          activeProperty={activeProperty}
          onOpenPropertyEditor={onOpenPropertyEditor}
          onChipPointerDown={onChipPointerDown}
        />
      ) : null}
    </>
  );
});

interface CardSurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  card: CardType;
  columnId: string;
  displayPrefs?: DbViewDisplayPrefs;
  dragDisabled?: boolean;
  showStaticDragGhost?: boolean;
  fixedWidth?: number;
  fixedHeight?: number;
  isDragging?: boolean;
  isFocused?: boolean;
  isSelected?: boolean;
  hasTerminal: boolean;
  position: CardPropertyPosition;
  activeProperty: CardEditableProperty | null;
  onOpenPropertyEditor?: (
    property: CardEditableProperty,
    currentToken: string,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  onChipPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
}

const CardSurface = forwardRef<HTMLDivElement, CardSurfaceProps>(function CardSurface({
  card,
  columnId,
  displayPrefs,
  dragDisabled = false,
  showStaticDragGhost = false,
  fixedWidth,
  fixedHeight,
  isDragging = false,
  isFocused,
  isSelected = false,
  hasTerminal,
  position,
  activeProperty,
  onOpenPropertyEditor,
  onChipPointerDown,
  className,
  style,
  ...domProps
}: CardSurfaceProps, ref) {
  const { resolved } = useTheme();
  const isDark = resolved === "dark";
  const ringShadow = card.agentBlocked
    ? "0 0 0 1.5px var(--destructive)"
    : isSelected
      ? "0 0 0 1.5px color-mix(in srgb, var(--accent-blue) 72%, transparent)"
      : isFocused
        ? "0 0 0 1.5px color-mix(in srgb, var(--accent-blue) 50%, transparent)"
        : null;

  const baseShadow = isDragging
    ? isDark
      ? "0 8px 16px rgba(0,0,0,0.3)"
      : "0 8px 16px rgba(25,25,25,0.08)"
    : isDark
      ? "0 4px 12px rgba(0,0,0,0.15), 0 1px 2px rgba(0,0,0,0.1), 0 0 0 1px color-mix(in srgb, var(--column-accent, rgba(255,255,255,0.07)) 20%, transparent)"
      : "0 4px 12px rgba(25,25,25,0.027), 0 1px 2px rgba(25,25,25,0.02), 0 0 0 1px color-mix(in srgb, var(--column-accent, rgba(42,28,0,0.07)) 15%, transparent)";

  const mergedStyle: React.CSSProperties = {
    ...style,
    width: fixedWidth,
    minHeight: fixedHeight,
    boxShadow: ringShadow
      ? `${baseShadow}, ${ringShadow}`
      : baseShadow,
  };

  return (
    <div
      ref={ref}
      style={mergedStyle}
      {...domProps}
      className={cn(
        "min-h-10 overflow-hidden rounded-lg bg-(--card) select-none",
        dragDisabled ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        "hover:bg-[color-mix(in_srgb,var(--column-accent,#888)_8%,var(--card))]",
        showStaticDragGhost && "opacity-35",
        isDragging && !showStaticDragGhost && "opacity-50",
        isSelected && "bg-[color-mix(in_srgb,var(--accent-blue)_6%,var(--card))]",
        className,
      )}
    >
      <CardBody
        card={card}
        columnId={columnId}
        displayPrefs={displayPrefs}
        hasTerminal={hasTerminal}
        position={position}
        activeProperty={activeProperty}
        onOpenPropertyEditor={onOpenPropertyEditor}
        onChipPointerDown={onChipPointerDown}
      />
    </div>
  );
});

export function CardPreview({
  card,
  columnId,
  displayPrefs,
  isSelected = false,
  fixedWidth,
  fixedHeight,
}: Pick<CardProps, "card" | "columnId" | "displayPrefs" | "isSelected"> & {
  fixedWidth?: number;
  fixedHeight?: number;
}) {
  const { position } = useCardPropertyPosition();
  const activeTerminals = useActiveTerminals();
  const hasTerminal = activeTerminals.has(card.id);

  return (
    <CardSurface
      card={card}
      columnId={columnId}
      displayPrefs={displayPrefs}
      dragDisabled
      isSelected={isSelected}
      fixedWidth={fixedWidth}
      fixedHeight={fixedHeight}
      hasTerminal={hasTerminal}
      position={position}
      activeProperty={null}
    />
  );
}

export function Card({
  card,
  columnId,
  displayPrefs,
  dragDisabled = false,
  isFocused,
  isSelected = false,
  onClick,
  onUpdateProperty,
  contextMenu,
}: CardProps) {
  const { position } = useCardPropertyPosition();
  const activeTerminals = useActiveTerminals();
  const hasTerminal = activeTerminals.has(card.id);
  const [activeChipEdit, setActiveChipEdit] = useState<{
    property: CardEditableProperty;
    currentToken: string;
    anchorRect: DOMRect;
  } | null>(null);
  const {
    active,
    attributes,
    isSorting,
    listeners,
    over,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: card.id,
    data: { card, columnId },
    disabled: dragDisabled,
  });
  const freezeSameColumnPreview = shouldFreezeSameColumnPreview({
    columnId,
    active,
    over,
    isSorting,
  });
  const showStaticDragGhost = isDragging;

  const style: React.CSSProperties = {
    transform: showStaticDragGhost || freezeSameColumnPreview
      ? undefined
      : CSS.Transform.toString(transform),
    transition: showStaticDragGhost || freezeSameColumnPreview
      ? undefined
      : transition,
  };
  const handleChipPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );

  const handleOpenPropertyEditor = useCallback(
    (
      property: CardEditableProperty,
      currentToken: string,
      event: React.MouseEvent<HTMLButtonElement>,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      setActiveChipEdit({
        property,
        currentToken,
        anchorRect: event.currentTarget.getBoundingClientRect(),
      });
    },
    [],
  );

  const handleChipEditorClose = useCallback(() => {
    setActiveChipEdit(null);
  }, []);

  const handleChipSelect = useCallback(
    (propertyType: string, _cardId: string, value: string) => {
      if (!onUpdateProperty) {
        return;
      }

      if (propertyType !== "priority" && propertyType !== "estimate") {
        return;
      }

      void onUpdateProperty({
        cardId: card.id,
        columnId,
        property: propertyType,
        value,
      });
    },
    [card.id, columnId, onUpdateProperty],
  );

  const surface = (
    <CardSurface
      card={card}
      columnId={columnId}
      displayPrefs={displayPrefs}
      dragDisabled={dragDisabled}
      showStaticDragGhost={showStaticDragGhost}
      isDragging={isDragging}
      isFocused={isFocused}
      isSelected={isSelected}
      hasTerminal={hasTerminal}
      position={position}
      activeProperty={activeChipEdit?.property ?? null}
      onClick={onClick}
      onOpenPropertyEditor={onUpdateProperty ? handleOpenPropertyEditor : undefined}
      onChipPointerDown={onUpdateProperty ? handleChipPointerDown : undefined}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      {...(contextMenu ? { "data-card-context-menu-trigger": "true" } : {})}
    />
  );

  return (
    <>
      {contextMenu ? (
        <CardContextMenu
          card={card}
          currentColumnId={contextMenu.currentColumnId}
          currentProjectId={contextMenu.currentProjectId}
          currentProjectName={contextMenu.currentProjectName}
          projects={contextMenu.projects}
          onMoveToProject={contextMenu.onMoveToProject}
          onDelete={contextMenu.onDelete}
          onCopyLink={contextMenu.onCopyLink}
          onMenuOpen={contextMenu.onMenuOpen}
        >
          {surface}
        </CardContextMenu>
      ) : surface}
      {activeChipEdit && onUpdateProperty && (
        <ChipPropertyEditor
          propertyType={activeChipEdit.property}
          currentToken={activeChipEdit.currentToken}
          cardId={card.id}
          anchorRect={activeChipEdit.anchorRect}
          onSelect={handleChipSelect}
          onClose={handleChipEditorClose}
        />
      )}
    </>
  );
}
