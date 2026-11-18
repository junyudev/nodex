import type { EditorView } from "@tiptap/pm/view";

import { resolvePageMentionEmbedTarget } from "@/lib/nfm-turn-into-targets";

const PAGE_MENTION_NODE_SELECTOR = '[data-inline-content-type="pageMention"]';
const INLINE_REFERENCE_CHIP_SELECTOR = '[data-inline-reference-chip="true"]';

type EmbeddableBlock = Parameters<typeof resolvePageMentionEmbedTarget>[0];

export interface NfmPageMentionMenuEditor {
  readonly prosemirrorView?: EditorView;
  getBlock?(blockId: string): EmbeddableBlock | undefined;
  updateBlock?(
    blockId: string,
    update: { type: "pageRef"; props: { targetBlockId: string } },
  ): unknown;
}

/** The Page Mention a context menu opened on, read from the document rather than its DOM. */
export interface PageMentionContextTarget {
  readonly pageId: string;
  readonly blockId: string;
  /** The mention is alone on its line, so its Block can become the embed. */
  readonly embeddable: boolean;
  readonly chip: HTMLElement | null;
}

/** React node views render the mention inside an outer renderer element owned by the view. */
function findNodePosition(view: EditorView, element: HTMLElement): number | null {
  let guess: number;
  try {
    guess = view.posAtDOM(element, 0);
  } catch {
    return null;
  }
  for (const pos of [guess, guess - 1]) {
    if (pos < 0 || view.state.doc.nodeAt(pos)?.type.name !== "pageMention") continue;
    if (view.nodeDOM(pos)?.contains(element)) return pos;
  }
  return null;
}

export function resolvePageMentionContextTarget(
  editor: NfmPageMentionMenuEditor,
  eventTarget: EventTarget | null,
): PageMentionContextTarget | null {
  const view = editor.prosemirrorView;
  if (!view || !(eventTarget instanceof Element)) return null;
  const element = eventTarget.closest<HTMLElement>(PAGE_MENTION_NODE_SELECTOR);
  // A disclosed Page body is its own editor and owns its own menu.
  if (!element || element.closest(".ProseMirror") !== view.dom) return null;

  const pos = findNodePosition(view, element);
  if (pos === null) return null;
  const pageId = String(view.state.doc.nodeAt(pos)?.attrs.targetPageId ?? "").trim();
  if (!pageId) return null;

  const $pos = view.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const container = $pos.node(depth);
    if (container.type.name !== "blockContainer") continue;
    const blockId = String(container.attrs.id ?? "");
    if (!blockId) return null;
    const block = editor.getBlock?.(blockId);
    return {
      pageId,
      blockId,
      embeddable: block !== undefined && resolvePageMentionEmbedTarget(block) === pageId,
      chip: element.querySelector<HTMLElement>(INLINE_REFERENCE_CHIP_SELECTOR),
    };
  }
  return null;
}

/** Re-reads the Block so an edit that landed while the menu was open is never overwritten. */
export function turnPageMentionIntoEmbed(
  editor: NfmPageMentionMenuEditor,
  target: PageMentionContextTarget,
): boolean {
  const block = editor.getBlock?.(target.blockId);
  if (!block || !editor.updateBlock) return false;
  if (resolvePageMentionEmbedTarget(block) !== target.pageId) return false;
  editor.updateBlock(target.blockId, { type: "pageRef", props: { targetBlockId: target.pageId } });
  return true;
}

/** Keeps the chip highlighted while its menu is open, without the keyboard `Open page` hint. */
export function setPageMentionContextHighlight(chip: HTMLElement | null, highlighted: boolean) {
  if (highlighted) chip?.setAttribute("data-inline-reference-selected", "true");
  else chip?.removeAttribute("data-inline-reference-selected");
}
