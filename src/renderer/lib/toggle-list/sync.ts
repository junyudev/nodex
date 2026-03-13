import { nfmToBlockNote, parseNfm } from "../nfm";
import {
  blockToCardPatch,
  toTextContent,
} from "./block-mapping";
import { formatMeta, type FormatMetaOptions } from "./meta";
import type { ToggleListCard, ToggleListPropertyKey } from "./types";

export interface OutboundCardPatch {
  cardId: string;
  columnId: string;
  updates: {
    title: string;
    description: string;
  };
}

export interface InboundBlockUpdate {
  blockId: string;
  update: {
    props?: {
      cardId: string;
      meta: string;
    };
    content?: ReturnType<typeof toTextContent>;
    children?: ReturnType<typeof nfmToBlockNote>;
  };
  toggleStates?: Map<string, boolean>;
}

export function buildOutboundPatches(
  blocks: unknown[],
  cardById: Map<string, ToggleListCard>,
  editorElement?: HTMLElement,
): OutboundCardPatch[] {
  const patches: OutboundCardPatch[] = [];

  for (const block of blocks) {
    const patch = blockToCardPatch(block, editorElement);
    if (!patch) continue;

    const current = cardById.get(patch.cardId);
    if (!current) continue;

    if (
      patch.title === current.title &&
      patch.description === (current.description ?? "")
    ) {
      continue;
    }

    patches.push({
      cardId: current.id,
      columnId: current.columnId,
      updates: {
        title: patch.title,
        description: patch.description,
      },
    });
  }

  return patches;
}

export function buildInboundUpdates(
  blocks: unknown[],
  cardById: Map<string, ToggleListCard>,
  propertyOrder: ToggleListPropertyKey[],
  hiddenProperties: ToggleListPropertyKey[],
  dirtyCardIds: ReadonlySet<string>,
  inFlightCardIds: ReadonlySet<string>,
  editorElement?: HTMLElement,
  showEmptyOptions: FormatMetaOptions = {},
): InboundBlockUpdate[] {
  const updates: InboundBlockUpdate[] = [];

  for (const block of blocks) {
    if (!isRecord(block) || typeof block.id !== "string") continue;
    const patch = blockToCardPatch(block, editorElement);
    if (!patch) continue;
    if (dirtyCardIds.has(patch.cardId) || inFlightCardIds.has(patch.cardId)) continue;

    const card = cardById.get(patch.cardId);
    if (!card) continue;

    const update: InboundBlockUpdate["update"] = {};
    let toggleStates: Map<string, boolean> | undefined;
    const meta = formatMeta(card, propertyOrder, hiddenProperties, showEmptyOptions);

    if (!isRecord(block.props) || block.props.meta !== meta || block.props.cardId !== card.id) {
      update.props = { cardId: card.id, meta };
    }

    if (patch.title !== card.title) {
      update.content = toTextContent(card.title);
    }

    if (patch.description !== (card.description ?? "")) {
      toggleStates = new Map<string, boolean>();
      update.children = nfmToBlockNote(parseNfm(card.description ?? ""), toggleStates);
    }

    if (!update.props && !update.content && !update.children) continue;

    updates.push({
      blockId: block.id,
      update,
      ...(toggleStates ? { toggleStates } : {}),
    });
  }

  return updates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
