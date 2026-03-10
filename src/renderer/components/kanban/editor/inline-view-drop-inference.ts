import type { Card, CardInput, Board, Estimate, Priority } from "../../../lib/types";
import type { ToggleListSettings, ToggleListStatusId } from "../../../lib/toggle-list/types";
import {
  deriveToggleListFilterRule,
  toggleListSortIncludesField,
} from "../../../lib/toggle-list/settings";
import { TOGGLE_LIST_STATUS_ORDER } from "../../../lib/toggle-list/types";

export interface InlineViewProjectedRow {
  blockId: string;
  cardId: string;
  sourceColumnId?: ToggleListStatusId;
}

export interface InferInlineViewDropImportInput {
  settings: ToggleListSettings;
  projectedRows: InlineViewProjectedRow[];
  insertRowIndex: number;
  board: Board;
  cards: CardInput[];
}

export interface InferInlineViewDropImportResult {
  targetColumnId: ToggleListStatusId;
  insertIndex?: number;
  cards: CardInput[];
}

interface CardWithColumn extends Card {
  columnId: ToggleListStatusId;
}

function clampInsertRowIndex(
  index: number,
  total: number,
): number {
  if (!Number.isFinite(index)) return total;
  if (index <= 0) return 0;
  if (index >= total) return total;
  return Math.trunc(index);
}

function buildCardById(board: Board): Map<string, CardWithColumn> {
  const byId = new Map<string, CardWithColumn>();

  for (const column of board.columns) {
    if (!TOGGLE_LIST_STATUS_ORDER.includes(column.id as ToggleListStatusId)) continue;

    const columnId = column.id as ToggleListStatusId;
    for (const card of column.cards) {
      byId.set(card.id, {
        ...card,
        columnId,
      });
    }
  }

  return byId;
}

function resolveFallbackStatus(settings: ToggleListSettings): ToggleListStatusId {
  const firstAllowed = deriveToggleListFilterRule(settings.rulesV2).statuses[0];
  if (firstAllowed && TOGGLE_LIST_STATUS_ORDER.includes(firstAllowed)) {
    return firstAllowed;
  }
  return TOGGLE_LIST_STATUS_ORDER[0];
}

function resolveInsertIndexForColumn(
  board: Board,
  targetColumnId: ToggleListStatusId,
  afterCardId?: string,
  beforeCardId?: string,
): number | undefined {
  const targetColumn = board.columns.find((column) => column.id === targetColumnId);
  if (!targetColumn) return undefined;

  if (afterCardId) {
    const beforeIndex = targetColumn.cards.findIndex((card) => card.id === afterCardId);
    if (beforeIndex >= 0) return beforeIndex;
  }

  if (beforeCardId) {
    const afterIndex = targetColumn.cards.findIndex((card) => card.id === beforeCardId);
    if (afterIndex >= 0) return afterIndex + 1;
  }

  return undefined;
}

function inferPriorityDefault(
  input: CardInput,
  referenceCard: CardWithColumn | undefined,
  settings: ToggleListSettings,
): Priority | undefined {
  if (input.priority) return input.priority;

  const rankIncludesPriority = toggleListSortIncludesField(settings.rulesV2, "priority");
  if (rankIncludesPriority && referenceCard?.priority) {
    return referenceCard.priority;
  }

  const priorities = deriveToggleListFilterRule(settings.rulesV2).priorities;
  if (priorities.length === 1) {
    return priorities[0];
  }

  return undefined;
}

function inferEstimateDefault(
  input: CardInput,
  referenceCard: CardWithColumn | undefined,
  settings: ToggleListSettings,
): Estimate | null | undefined {
  if (Object.prototype.hasOwnProperty.call(input, "estimate")) return input.estimate;

  const rankIncludesEstimate = toggleListSortIncludesField(settings.rulesV2, "estimate");
  if (!rankIncludesEstimate) return undefined;
  if (!referenceCard) return undefined;

  return referenceCard.estimate ?? null;
}

export function inferInlineViewDropImport(
  input: InferInlineViewDropImportInput,
): InferInlineViewDropImportResult {
  const cardById = buildCardById(input.board);
  const insertRowIndex = clampInsertRowIndex(input.insertRowIndex, input.projectedRows.length);
  const beforeRow = insertRowIndex > 0
    ? input.projectedRows[insertRowIndex - 1]
    : undefined;
  const afterRow = insertRowIndex < input.projectedRows.length
    ? input.projectedRows[insertRowIndex]
    : undefined;

  const beforeCard = beforeRow ? cardById.get(beforeRow.cardId) : undefined;
  const afterCard = afterRow ? cardById.get(afterRow.cardId) : undefined;
  const targetColumnId = afterCard?.columnId
    ?? beforeCard?.columnId
    ?? afterRow?.sourceColumnId
    ?? beforeRow?.sourceColumnId
    ?? resolveFallbackStatus(input.settings);
  const insertIndex = resolveInsertIndexForColumn(
    input.board,
    targetColumnId,
    afterCard?.id,
    beforeCard?.id,
  );
  const referenceCard = afterCard ?? beforeCard;

  const cards = input.cards.map((card) => {
    const priority = inferPriorityDefault(card, referenceCard, input.settings);
    const estimate = inferEstimateDefault(card, referenceCard, input.settings);

    return {
      ...card,
      ...(priority ? { priority } : {}),
      ...(estimate !== undefined ? { estimate } : {}),
    };
  });

  return {
    targetColumnId,
    ...(insertIndex !== undefined ? { insertIndex } : {}),
    cards,
  };
}
