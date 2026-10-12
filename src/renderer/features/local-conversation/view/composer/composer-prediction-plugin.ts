import { DOMSerializer, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { CodexComposerPredictionResult } from "../../../../../shared/codex-composer-prediction";
import { readComposerSuggestionState } from "./composer-suggestion-state";

export interface ComposerPredictionInteraction {
  readonly prediction: CodexComposerPredictionResult;
  readonly action: "shown" | "accepted";
  readonly acceptedText?: string;
}
interface PredictionState {
  readonly prediction: CodexComposerPredictionResult;
  readonly doc: ProseMirrorNode;
  readonly widget: Decoration;
  readonly hiddenForComposition: boolean;
}
type PredictionMeta =
  | { readonly type: "prediction"; readonly prediction: CodexComposerPredictionResult | null }
  | { readonly type: "composition"; readonly hidden: boolean }
  | { readonly type: "document"; readonly doc: ProseMirrorNode };

export const composerPredictionPluginKey = new PluginKey<PredictionState | null>(
  "composer-prediction",
);

function canShowPrediction(state: EditorState, composing: boolean, disabled: boolean): boolean {
  if (composing || disabled || composerPredictionPluginKey.getState(state)?.hiddenForComposition)
    return false;
  if (readComposerSuggestionState(state).active) return false;
  return (
    state.doc.childCount === 1 &&
    state.doc.firstChild?.type === state.schema.nodes.paragraph &&
    state.doc.firstChild.content.size === 0
  );
}

/** Prediction acceptance fills the ordinary document; the Send shortcut runs on a later event. */
export function acceptComposerPrediction(view: EditorView, event: KeyboardEvent): boolean {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return false;
  if (event.key !== "Tab" && event.key !== "ArrowRight" && event.key !== "Enter") return false;
  const prediction = composerPredictionPluginKey.getState(view.state);
  if (!prediction || !canShowPrediction(view.state, view.composing, !view.editable)) return false;
  const transaction = view.state.tr.replaceWith(
    0,
    view.state.doc.content.size,
    prediction.doc.content,
  );
  view.dispatch(
    transaction
      .setSelection(TextSelection.atEnd(transaction.doc))
      .setMeta("composer-prediction-accepted", prediction.prediction),
  );
  return true;
}

export function setComposerPrediction(
  view: EditorView,
  prediction: CodexComposerPredictionResult | null,
): void {
  if ((composerPredictionPluginKey.getState(view.state)?.prediction ?? null) === prediction) return;
  view.dispatch(
    view.state.tr.setMeta(composerPredictionPluginKey, {
      type: "prediction",
      prediction,
    } satisfies PredictionMeta),
  );
}

export function setComposerPredictionDocument(view: EditorView, doc: ProseMirrorNode): void {
  const current = composerPredictionPluginKey.getState(view.state);
  if (!current || current.doc.eq(doc)) return;
  view.dispatch(
    view.state.tr.setMeta(composerPredictionPluginKey, {
      type: "document",
      doc,
    } satisfies PredictionMeta),
  );
}

export function createComposerPredictionPlugin({
  initialPrediction,
  parsePromptText,
  getText,
  disabled,
  onInteraction,
}: {
  readonly initialPrediction: () => CodexComposerPredictionResult | null;
  readonly parsePromptText: (text: string) => ProseMirrorNode;
  readonly getText: (doc: ProseMirrorNode) => string;
  readonly disabled: () => boolean;
  readonly onInteraction: (interaction: ComposerPredictionInteraction) => void;
}): Plugin<PredictionState | null> {
  let restoreCompositionFrame: number | null = null;
  const buildState = (
    prediction: CodexComposerPredictionResult,
    doc: ProseMirrorNode,
    hiddenForComposition: boolean,
  ): PredictionState => ({
    prediction,
    doc,
    hiddenForComposition,
    widget: Decoration.widget(
      1,
      (view) => {
        const element = view.dom.ownerDocument.createElement("span");
        element.dataset.composerPrediction = "";
        element.className = "select-none text-token-description-foreground";
        element.inert = true;
        element.setAttribute("aria-hidden", "true");
        element.appendChild(
          DOMSerializer.fromSchema(view.state.schema).serializeFragment(doc.content, {
            document: view.dom.ownerDocument,
          }),
        );
        return element;
      },
      { side: 1, ignoreSelection: true },
    ),
  });
  const restoreComposition = (view: EditorView) => {
    if (restoreCompositionFrame !== null)
      view.dom.ownerDocument.defaultView?.cancelAnimationFrame(restoreCompositionFrame);
    restoreCompositionFrame =
      view.dom.ownerDocument.defaultView?.requestAnimationFrame(() => {
        restoreCompositionFrame = null;
        if (view.isDestroyed || view.composing || !composerPredictionPluginKey.getState(view.state))
          return;
        view.dispatch(
          view.state.tr.setMeta(composerPredictionPluginKey, {
            type: "composition",
            hidden: false,
          } satisfies PredictionMeta),
        );
      }) ?? null;
  };
  let shownId: string | null = null;
  return new Plugin({
    key: composerPredictionPluginKey,
    state: {
      init: () => {
        const prediction = initialPrediction();
        return prediction?.text
          ? buildState(prediction, parsePromptText(prediction.text), false)
          : null;
      },
      apply(transaction, current) {
        const meta = transaction.getMeta(composerPredictionPluginKey) as PredictionMeta | undefined;
        if (!meta) return current;
        if (meta.type === "composition")
          return current ? { ...current, hiddenForComposition: meta.hidden } : null;
        if (meta.type === "document")
          return current && !meta.doc.eq(current.doc)
            ? buildState(current.prediction, meta.doc, current.hiddenForComposition)
            : current;
        if (!meta.prediction?.text) return null;
        if (meta.prediction.text === current?.prediction.text)
          return { ...current, prediction: meta.prediction };
        return buildState(
          meta.prediction,
          parsePromptText(meta.prediction.text),
          current?.hiddenForComposition ?? false,
        );
      },
    },
    view(view) {
      const reportShown = (currentView: EditorView) => {
        const state = composerPredictionPluginKey.getState(currentView.state);
        if (!state || !canShowPrediction(currentView.state, currentView.composing, disabled()))
          return;
        if (state.prediction.predictionThreadId === shownId) return;
        shownId = state.prediction.predictionThreadId;
        onInteraction({ prediction: state.prediction, action: "shown" });
      };
      reportShown(view);
      return {
        update: reportShown,
        destroy: () => {
          if (restoreCompositionFrame !== null)
            view.dom.ownerDocument.defaultView?.cancelAnimationFrame(restoreCompositionFrame);
        },
      };
    },
    appendTransaction(transactions, _oldState, state) {
      for (const transaction of transactions) {
        const accepted = transaction.getMeta("composer-prediction-accepted") as
          | CodexComposerPredictionResult
          | undefined;
        if (accepted)
          onInteraction({
            prediction: accepted,
            action: "accepted",
            acceptedText: getText(state.doc),
          });
      }
      return null;
    },
    props: {
      decorations(state) {
        const prediction = composerPredictionPluginKey.getState(state);
        return prediction && canShowPrediction(state, false, disabled())
          ? DecorationSet.create(state.doc, [prediction.widget])
          : null;
      },
      handleKeyDown: acceptComposerPrediction,
      handleDOMEvents: {
        keydown(view, event) {
          if (event.keyCode === 229 && composerPredictionPluginKey.getState(view.state)) {
            view.dispatch(
              view.state.tr.setMeta(composerPredictionPluginKey, {
                type: "composition",
                hidden: true,
              } satisfies PredictionMeta),
            );
            restoreComposition(view);
          }
          return false;
        },
        compositionstart(view) {
          if (!composerPredictionPluginKey.getState(view.state)) return false;
          view.dispatch(
            view.state.tr.setMeta(composerPredictionPluginKey, {
              type: "composition",
              hidden: true,
            } satisfies PredictionMeta),
          );
          return false;
        },
        compositionend(view) {
          if (!composerPredictionPluginKey.getState(view.state)) return false;
          restoreComposition(view);
          return false;
        },
        mousedown(view, event) {
          if (
            event.button !== 0 ||
            !composerPredictionPluginKey.getState(view.state) ||
            !canShowPrediction(view.state, view.composing, disabled())
          )
            return false;
          event.preventDefault();
          view.focus();
          return true;
        },
      },
    },
  });
}
