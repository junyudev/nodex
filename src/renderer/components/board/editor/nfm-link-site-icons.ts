import type { MarkType, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { resolveLinkSite } from "../../../../shared/link-site";

interface LinkSiteIconSlot {
  readonly id: number;
  readonly element: HTMLElement;
  readonly href: string;
}

/**
 * The places an editor draws link icons into. The editor plugin creates them as its widgets come
 * and go; the editor's React tree renders an icon into each, so icons read the app's data and
 * settings like every other surface.
 */
export class LinkSiteIconSlots {
  private nextId = 0;
  private readonly slots = new Map<HTMLElement, LinkSiteIconSlot>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly LinkSiteIconSlot[] = [];

  register(href: string): HTMLElement {
    const element = document.createElement("span");
    element.contentEditable = "false";
    element.setAttribute("aria-hidden", "true");
    element.dataset.linkSiteIcon = "";
    element.className =
      "pointer-events-none relative top-[0.14em] me-[0.25em] inline-flex size-[1em] select-none";
    this.slots.set(element, { id: this.nextId++, element, href });
    this.publish();
    return element;
  }

  unregister(element: HTMLElement): void {
    if (this.slots.delete(element)) this.publish();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;

  private publish(): void {
    this.snapshot = [...this.slots.values()];
    for (const listener of this.listeners) listener();
  }
}

const linkSiteIconsKey = new PluginKey<DecorationSet>("nfmLinkSiteIcons");

/** Where each run of one web link starts inside a text block. */
function linkStarts(
  block: ProseMirrorNode,
  blockPos: number,
  linkType: MarkType,
): Array<{ readonly pos: number; readonly href: string }> {
  const starts: Array<{ readonly pos: number; readonly href: string }> = [];
  let previous: string | null = null;
  block.forEach((child, offset) => {
    const mark = linkType.isInSet(child.marks);
    const href = typeof mark?.attrs.href === "string" ? mark.attrs.href : null;
    if (href && href !== previous && resolveLinkSite(href))
      starts.push({ pos: blockPos + 1 + offset, href });
    previous = href;
  });
  return starts;
}

function decorate(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  linkType: MarkType,
  slots: LinkSiteIconSlots,
): Decoration[] {
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    for (const { pos: start, href } of linkStarts(node, pos, linkType))
      decorations.push(
        Decoration.widget(start, () => slots.register(href), {
          side: -1,
          key: `link-site-icon:${href}`,
          ignoreSelection: true,
          marks: [],
          destroy: (element) => slots.unregister(element as HTMLElement),
        }),
      );
    return false;
  });
  return decorations;
}

/** The text blocks a change touched, widened so a run of links is always rescanned whole. */
function touchedBlocks(doc: ProseMirrorNode, from: number, to: number): [number, number] {
  let start = Math.max(0, Math.min(from, doc.content.size));
  let end = Math.max(start, Math.min(to, doc.content.size));
  const widen = (pos: number) => {
    const resolved = doc.resolve(pos);
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      if (!resolved.node(depth).isTextblock) continue;
      start = Math.min(start, resolved.before(depth));
      end = Math.max(end, resolved.after(depth));
      return;
    }
  };
  widen(start);
  widen(end);
  return [start, end];
}

/**
 * Where a transaction changed its document, in the final document's positions. Mark steps move
 * nothing, so their own range counts, not only what their position maps report.
 */
function changedRanges(tr: Transaction): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  tr.steps.forEach((step, index) => {
    const after = tr.mapping.slice(index);
    const own = step as { readonly from?: unknown; readonly to?: unknown; readonly pos?: unknown };
    if (typeof own.from === "number" && typeof own.to === "number")
      ranges.push([after.map(own.from, -1), after.map(own.to, 1)]);
    else if (typeof own.pos === "number")
      ranges.push([after.map(own.pos, -1), after.map(own.pos, 1)]);
    const later = tr.mapping.slice(index + 1);
    step
      .getMap()
      .forEach((_oldStart, _oldEnd, newStart, newEnd) =>
        ranges.push([later.map(newStart, -1), later.map(newEnd, 1)]),
      );
  });
  return ranges;
}

/**
 * Draws each web link's site icon before its words, outside the document: icons are never
 * typed, selected, copied, undone or synced. A change rescans only the text blocks it touched.
 */
export function createLinkSiteIconsPlugin(linkType: MarkType, slots: LinkSiteIconSlots): Plugin {
  return new Plugin<DecorationSet>({
    key: linkSiteIconsKey,
    state: {
      init: (_config, state) =>
        DecorationSet.create(
          state.doc,
          decorate(state.doc, 0, state.doc.content.size, linkType, slots),
        ),
      apply: (tr, decorations) => {
        if (!tr.docChanged) return decorations;
        let next = decorations.map(tr.mapping, tr.doc);
        for (const [from, to] of changedRanges(tr)) {
          const [start, end] = touchedBlocks(tr.doc, from, to);
          next = next.remove(next.find(start, end));
          next = next.add(tr.doc, decorate(tr.doc, start, end, linkType, slots));
        }
        return next;
      },
    },
    props: {
      decorations: (state) => linkSiteIconsKey.getState(state),
    },
  });
}
