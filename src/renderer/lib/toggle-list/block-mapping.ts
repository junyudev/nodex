import {
  applyToggleStatesFromDom,
  blockNoteToNfm,
  nfmToBlockNote,
  parseNfm,
  serializeNfm,
} from "../nfm";
import { formatMeta, type FormatMetaOptions } from "./meta";
import type { ToggleListCard, ToggleListPropertyKey } from "./types";

export interface ToggleListCardPatch {
  cardId: string;
  title: string;
  description: string;
}

export function makeCardToggleBlockId(projectId: string, cardId: string): string {
  return `toggle-card-${projectId}-${cardId}`;
}

export function cardToToggleBlock(
  projectId: string,
  card: ToggleListCard,
  propertyOrder: ToggleListPropertyKey[],
  hiddenProperties: ToggleListPropertyKey[],
  toggleStates?: Map<string, boolean>,
  showEmptyOptions: FormatMetaOptions = {},
) {
  return {
    id: makeCardToggleBlockId(projectId, card.id),
    type: "cardToggle" as const,
    props: {
      cardId: card.id,
      meta: formatMeta(card, propertyOrder, hiddenProperties, showEmptyOptions),
    },
    content: toTextContent(card.title),
    children: nfmToBlockNote(parseNfm(card.description ?? ""), toggleStates),
  };
}

export function blockToCardPatch(
  block: unknown,
  editorElement?: HTMLElement,
): ToggleListCardPatch | null {
  if (!isRecord(block)) return null;
  if (block.type !== "cardToggle") return null;
  if (!isRecord(block.props)) return null;
  if (typeof block.props.cardId !== "string" || block.props.cardId.length === 0) {
    return null;
  }

  return {
    cardId: block.props.cardId,
    title: inlineContentToText(block.content),
    description: childrenToNfm(block.children, editorElement),
  };
}

export function hasCardToggleStructure(
  blocks: unknown[],
  expectedCardIds: string[],
): boolean {
  if (expectedCardIds.length === 0) {
    return !blocks.some((block) => isRecord(block) && block.type === "cardToggle");
  }

  if (blocks.length !== expectedCardIds.length) return false;

  for (let index = 0; index < blocks.length; index += 1) {
    const patch = blockToCardPatch(blocks[index]);
    if (!patch) return false;
    if (patch.cardId !== expectedCardIds[index]) return false;
  }

  return true;
}

export function toTextContent(text: string) {
  return text;
}

function childrenToNfm(
  children: unknown,
  editorElement?: HTMLElement,
): string {
  if (!Array.isArray(children)) return "";
  const nfmBlocks = blockNoteToNfm(children);
  if (editorElement) {
    applyToggleStatesFromDom(children, nfmBlocks, editorElement);
  }
  return serializeNfm(nfmBlocks);
}

function inlineContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (!isRecord(item)) return "";
      if (item.type === "text") {
        return typeof item.text === "string" ? item.text : "";
      }
      if (item.type === "link") {
        if (!Array.isArray(item.content)) return "";
        return item.content
          .map((linkPart) => {
            if (!isRecord(linkPart)) return "";
            return typeof linkPart.text === "string" ? linkPart.text : "";
          })
          .join("");
      }
      return "";
    })
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
