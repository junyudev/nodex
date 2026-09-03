import { createExtension } from "@blocknote/core";
import type { Node as ProsemirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  readTaskShorthandPagePromotionEnabled,
  TASK_SHORTHAND_PAGE_PROMOTION_CHANGE_EVENT,
} from "../../../lib/page-promotion-preference";
import { previewTaskShorthandTextRun } from "../../../lib/task-shorthand-preview";
import { APP_SHELL_TOOLTIP_LAYER_CLASS } from "../../../lib/app-shell-layers";
import { NFM_EDITOR_FLOATING_SURFACE_CHROME_CLASS } from "./nfm-editor-floating-surface";

interface TaskShorthandDecorationState {
  readonly decorations: DecorationSet;
}

export const taskShorthandPreviewPluginKey = new PluginKey<TaskShorthandDecorationState>(
  "task-shorthand-preview",
);

const blockDecoration = (node: ProsemirrorNode, position: number): Decoration | null => {
  if (!node.isTextblock) return null;
  let leadingText = "";
  let crossedAuthorityBoundary = false;
  let supportedRichTitle = true;
  let hasFollowingRichTitle = false;
  node.forEach((child) => {
    const link = child.marks.some((mark) => mark.type.name === "link");
    if (!crossedAuthorityBoundary && child.isText && !link) {
      leadingText += child.text ?? "";
      return;
    }
    crossedAuthorityBoundary = true;
    if (child.isText) {
      hasFollowingRichTitle ||= /[^\p{White_Space}]/u.test(child.text ?? "");
      return;
    }
    if (child.type.name === "hardBreak") return;
    if (SUPPORTED_RICH_TITLE_NODE_TYPES.has(child.type.name)) {
      hasFollowingRichTitle = true;
      return;
    }
    supportedRichTitle = false;
  });
  if (!supportedRichTitle || leadingText.length === 0) return null;
  const preview = previewTaskShorthandTextRun(leadingText, hasFollowingRichTitle);
  if (!preview) return null;
  const from = position + 1;
  return Decoration.inline(
    from,
    from + preview.consumedCharacters,
    {
      class:
        "rounded-[2px] bg-token-accent/8 underline decoration-token-accent/45 decoration-dotted underline-offset-[3px]",
      "data-task-shorthand-preview": preview.compactLabel,
    },
    { preview: preview.compactLabel },
  );
};

const SUPPORTED_RICH_TITLE_NODE_TYPES = new Set(["threadMention", "pageMention", "dateMention"]);

const buildDecorations = (document: ProsemirrorNode): DecorationSet => {
  if (!readTaskShorthandPagePromotionEnabled()) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  document.descendants((node, position) => {
    const decoration = blockDecoration(node, position);
    if (decoration) decorations.push(decoration);
    if (!node.isTextblock) return true;
    return false;
  });
  return DecorationSet.create(document, decorations);
};

const updateChangedBlockDecorations = (
  transaction: Transaction,
  previous: DecorationSet,
): DecorationSet => {
  if (!readTaskShorthandPagePromotionEnabled()) return DecorationSet.empty;
  let decorations = previous.map(transaction.mapping, transaction.doc);
  const positions = new Set<number>();
  for (const map of transaction.mapping.maps) {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const from = Math.max(0, newStart - 1);
      const to = Math.min(transaction.doc.content.size, Math.max(newEnd, newStart + 1) + 1);
      transaction.doc.nodesBetween(from, to, (node, position) => {
        if (node.isTextblock) positions.add(position);
        return !node.isTextblock;
      });
      const resolved = transaction.doc.resolve(Math.min(newStart, transaction.doc.content.size));
      if (resolved.parent.isTextblock) positions.add(resolved.start(resolved.depth) - 1);
    });
  }
  for (const position of positions) {
    const node = transaction.doc.nodeAt(position);
    if (!node?.isTextblock) continue;
    decorations = decorations.remove(decorations.find(position, position + node.nodeSize));
    const decoration = blockDecoration(node, position);
    if (decoration) decorations = decorations.add(transaction.doc, [decoration]);
  }
  return decorations;
};

const createTooltip = (): HTMLDivElement => {
  const tooltip = document.createElement("div");
  tooltip.setAttribute("role", "tooltip");
  tooltip.dataset.taskShorthandTooltip = "true";
  tooltip.className = `pointer-events-none fixed hidden max-w-[320px] rounded-md px-2.5 py-1.5 text-xs text-token-text-secondary ${APP_SHELL_TOOLTIP_LAYER_CLASS} ${NFM_EDITOR_FLOATING_SURFACE_CHROME_CLASS}`;
  document.body.append(tooltip);
  return tooltip;
};

const showTooltip = (
  tooltip: HTMLDivElement,
  content: string,
  rectangle: Pick<DOMRect, "left" | "bottom">,
): void => {
  tooltip.textContent = content;
  tooltip.style.left = `${Math.round(rectangle.left)}px`;
  tooltip.style.top = `${Math.round(rectangle.bottom + 6)}px`;
  tooltip.classList.remove("hidden");
};

const hideTooltip = (tooltip: HTMLDivElement): void => {
  tooltip.classList.add("hidden");
};

const updateSelectionTooltip = (view: EditorView, tooltip: HTMLDivElement): void => {
  const { from, to } = view.state.selection;
  const decoration = taskShorthandPreviewPluginKey
    .getState(view.state)
    ?.decorations.find(Math.max(0, from - 1), to + 1)
    .find((candidate) => from <= candidate.to && to >= candidate.from);
  const content = decoration?.spec.preview as string | undefined;
  if (!content) {
    hideTooltip(tooltip);
    return;
  }
  showTooltip(tooltip, content, view.coordsAtPos(from));
};

const createTaskShorthandPreviewPlugin = () =>
  new Plugin<TaskShorthandDecorationState>({
    key: taskShorthandPreviewPluginKey,
    state: {
      init: (_, state) => ({ decorations: buildDecorations(state.doc) }),
      apply: (transaction, previous) =>
        transaction.getMeta(taskShorthandPreviewPluginKey) === "refresh"
          ? { decorations: buildDecorations(transaction.doc) }
          : transaction.docChanged
            ? { decorations: updateChangedBlockDecorations(transaction, previous.decorations) }
            : { decorations: previous.decorations.map(transaction.mapping, transaction.doc) },
    },
    props: {
      decorations: (state) =>
        taskShorthandPreviewPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
    view: (view) => {
      const tooltip = createTooltip();
      const onPointerOver = (event: Event) => {
        const target =
          event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>("[data-task-shorthand-preview]")
            : null;
        const content = target?.dataset.taskShorthandPreview;
        if (!target || !content) return;
        showTooltip(tooltip, content, target.getBoundingClientRect());
      };
      const onPointerOut = (event: Event) => {
        const target =
          event.target instanceof HTMLElement
            ? event.target.closest("[data-task-shorthand-preview]")
            : null;
        if (target) hideTooltip(tooltip);
      };
      view.dom.addEventListener("pointerover", onPointerOver);
      view.dom.addEventListener("pointerout", onPointerOut);
      const onPreferenceChange = () => {
        view.dispatch(view.state.tr.setMeta(taskShorthandPreviewPluginKey, "refresh"));
      };
      window.addEventListener(TASK_SHORTHAND_PAGE_PROMOTION_CHANGE_EVENT, onPreferenceChange);
      return {
        update: (nextView, previousState) => {
          if (nextView.state.selection.eq(previousState.selection)) return;
          updateSelectionTooltip(nextView, tooltip);
        },
        destroy: () => {
          view.dom.removeEventListener("pointerover", onPointerOver);
          view.dom.removeEventListener("pointerout", onPointerOut);
          window.removeEventListener(
            TASK_SHORTHAND_PAGE_PROMOTION_CHANGE_EVENT,
            onPreferenceChange,
          );
          tooltip.remove();
        },
      };
    },
  });

export const nfmTaskShorthandPreviewExtension = createExtension(() => ({
  key: "task-shorthand-preview",
  prosemirrorPlugins: [createTaskShorthandPreviewPlugin()],
}));
