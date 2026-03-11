import { nfmToBlockNote, parseNfm } from "../../../lib/nfm";
import type { Card } from "../../../lib/types";
import { formatMeta } from "../../../lib/toggle-list/meta";
import type { ToggleListCard, ToggleListPropertyKey } from "../../../lib/toggle-list/types";
import { encodeCardToggleSnapshot } from "./card-toggle-snapshot";

const DEFAULT_PROPERTY_ORDER: ToggleListPropertyKey[] = [
  "priority",
  "estimate",
  "status",
  "tags",
];

function toSnapshotPayload(
  card: Card,
  projectId: string,
  status: string,
  statusName: string,
): string {
  return encodeCardToggleSnapshot({
    card: {
      title: card.title,
      description: card.description,
      priority: card.priority ?? null,
      estimate: card.estimate ?? null,
      tags: card.tags,
      dueDate: card.dueDate?.toISOString(),
      scheduledStart: card.scheduledStart?.toISOString(),
      scheduledEnd: card.scheduledEnd?.toISOString(),
      isAllDay: card.isAllDay,
      assignee: card.assignee,
      agentBlocked: card.agentBlocked,
    },
    projectId,
    status,
    statusName,
    capturedAt: new Date().toISOString(),
  });
}

function toToggleListCard(
  card: Card,
  columnId: string,
  columnName: string,
): ToggleListCard {
  return {
    ...card,
    columnId: columnId as ToggleListCard["columnId"],
    columnName,
    boardIndex: card.order,
  };
}

export function mapCardToDroppedCardToggleBlock(
  card: Card,
  projectId: string,
  columnId: string,
  columnName: string,
) {
  const toggleCard = toToggleListCard(card, columnId, columnName);
  const meta = formatMeta(toggleCard, DEFAULT_PROPERTY_ORDER, []);
  const descriptionBlocks = nfmToBlockNote(parseNfm(card.description ?? ""));

  return {
    type: "cardToggle" as const,
    props: {
      cardId: card.id,
      meta,
      snapshot: toSnapshotPayload(card, projectId, columnId, columnName),
      sourceProjectId: projectId,
      sourceStatus: columnId,
      sourceStatusName: columnName,
    },
    content: card.title,
    children: descriptionBlocks,
  };
}
