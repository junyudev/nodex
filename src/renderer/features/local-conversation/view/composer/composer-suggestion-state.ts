import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Selection,
  type Transaction,
} from "@tiptap/pm/state";

export type ComposerSuggestionKind = "at-mention" | "skill-mention" | "slash-command";
export type ComposerSuggestionTrigger = "+" | "@" | "$" | "/";
export type ComposerSuggestionActivation = "synthetic" | "typed";

export interface ComposerSuggestionRange {
  readonly from: number;
  readonly to: number;
}

export interface ComposerSuggestionDismissedMatch {
  readonly from: number;
  readonly query: string;
  readonly trigger: Exclude<ComposerSuggestionTrigger, "+">;
}

export interface ComposerSlashSuggestionSource {
  readonly kind: "slash-command";
  readonly commandId: string;
  readonly dismissOnInput?: boolean;
}

export interface ComposerSuggestionState {
  readonly active: boolean;
  readonly activation: ComposerSuggestionActivation | null;
  readonly anchorPos: number | null;
  readonly dismissedMatch: ComposerSuggestionDismissedMatch | null;
  readonly kind: ComposerSuggestionKind | null;
  readonly query: string;
  readonly range: ComposerSuggestionRange | null;
  readonly source: ComposerSlashSuggestionSource | null;
  readonly trigger: ComposerSuggestionTrigger | null;
}

export type ComposerSuggestionTransactionMeta =
  | {
      readonly type: "open-synthetic";
      readonly from: number;
      readonly kind: ComposerSuggestionKind;
      readonly trigger: "+" | "/";
    }
  | { readonly type: "close" }
  | { readonly type: "dismiss" }
  | {
      readonly type: "set-source";
      readonly source: ComposerSlashSuggestionSource | null;
    };

export const composerSuggestionPluginKey = new PluginKey<ComposerSuggestionState>(
  "composer-suggestion",
);

export function inactiveComposerSuggestionState(input?: {
  readonly dismissedMatch?: ComposerSuggestionDismissedMatch | null;
}): ComposerSuggestionState {
  return {
    active: false,
    activation: null,
    anchorPos: null,
    dismissedMatch: input?.dismissedMatch ?? null,
    kind: null,
    query: "",
    range: null,
    source: null,
    trigger: null,
  };
}

function readTextBeforeCursor(
  doc: ProseMirrorNode,
  selection: Selection,
): { readonly text: string; readonly cursor: number } | null {
  if (!selection.empty) return null;
  const cursor = selection.from;
  const resolved = doc.resolve(cursor);
  if (!resolved.parent.isTextblock) return null;

  return {
    text: resolved.nodeBefore?.text ?? "",
    cursor,
  };
}

function deriveTypedSuggestionState(input: {
  readonly doc: ProseMirrorNode;
  readonly selection: Selection;
  readonly dismissedMatch: ComposerSuggestionDismissedMatch | null;
  readonly previous?: ComposerSuggestionState;
}): ComposerSuggestionState {
  const beforeCursor = readTextBeforeCursor(input.doc, input.selection);
  if (!beforeCursor) {
    return inactiveComposerSuggestionState();
  }

  const slashMatch = /(?:^|\s)\/([\p{L}\p{N}\p{M}.:_/\\-]*)$/u.exec(beforeCursor.text);
  const atMatch = /(?:^|[\s([{])@([^@]*)$/u.exec(beforeCursor.text);
  const skillMatch = /(?:^|[\s([{])\$([^$]*)$/u.exec(beforeCursor.text);
  let match: {
    readonly trigger: "/" | "@" | "$";
    readonly query: string;
  } | null = slashMatch ? { trigger: "/", query: slashMatch[1] ?? "" } : null;
  if (atMatch && (!skillMatch || (atMatch.index ?? 0) > (skillMatch.index ?? 0))) {
    match = { trigger: "@", query: atMatch[1] ?? "" };
  } else if (skillMatch) {
    match = { trigger: "$", query: skillMatch[1] ?? "" };
  }
  if (!match) return inactiveComposerSuggestionState();

  const { trigger, query } = match;
  const tokenLength = trigger.length + query.length;
  const from = beforeCursor.cursor - tokenLength;
  const to = beforeCursor.cursor;
  if (
    input.dismissedMatch?.from === from &&
    input.dismissedMatch.trigger === trigger &&
    query.startsWith(input.dismissedMatch.query)
  ) {
    return inactiveComposerSuggestionState({
      dismissedMatch: input.dismissedMatch,
    });
  }

  return {
    active: true,
    activation: "typed",
    anchorPos: from + 1,
    dismissedMatch: null,
    kind: trigger === "/" ? "slash-command" : trigger === "$" ? "skill-mention" : "at-mention",
    query,
    range: { from, to },
    source:
      input.previous?.active === true && input.previous.range?.from === from
        ? input.previous.source
        : null,
    trigger,
  };
}

function deriveSyntheticSuggestionState(input: {
  readonly previous: ComposerSuggestionState;
  readonly transaction: Transaction;
}): ComposerSuggestionState {
  if (
    !input.previous.active ||
    input.previous.activation !== "synthetic" ||
    input.previous.range === null
  ) {
    return inactiveComposerSuggestionState();
  }
  if (
    input.transaction.docChanged &&
    input.previous.source?.kind === "slash-command" &&
    input.previous.source.dismissOnInput === true
  ) {
    return inactiveComposerSuggestionState();
  }

  const from = input.transaction.mapping.map(input.previous.range.from, -1);
  const mappedTo = input.transaction.mapping.map(input.previous.range.to, 1);
  const selection = input.transaction.selection;
  if (!selection.empty || selection.from < from) {
    return inactiveComposerSuggestionState();
  }

  const typed = deriveTypedSuggestionState({
    doc: input.transaction.doc,
    selection,
    dismissedMatch: input.previous.dismissedMatch,
  });
  if (typed.active && typed.range !== null && typed.range.from >= from) {
    return typed;
  }

  const to = input.previous.kind === "slash-command" ? mappedTo : selection.from;
  if (to < from) return inactiveComposerSuggestionState();

  const query = input.transaction.doc.textBetween(from, to, "\n", "\n");
  if (query.includes("\n")) return inactiveComposerSuggestionState();

  return {
    ...input.previous,
    anchorPos: from,
    query,
    range: { from, to },
    source: input.previous.kind === "slash-command" ? input.previous.source : null,
  };
}

function dismissComposerSuggestionState(
  previous: ComposerSuggestionState,
): ComposerSuggestionState {
  if (
    previous.active &&
    previous.activation === "typed" &&
    previous.range !== null &&
    previous.trigger !== null &&
    previous.trigger !== "+"
  ) {
    return inactiveComposerSuggestionState({
      dismissedMatch: {
        from: previous.range.from,
        query: previous.query,
        trigger: previous.trigger,
      },
    });
  }
  return inactiveComposerSuggestionState();
}

function applyComposerSuggestionTransaction(
  transaction: Transaction,
  previous: ComposerSuggestionState,
): ComposerSuggestionState {
  const meta = transaction.getMeta(composerSuggestionPluginKey) as
    | ComposerSuggestionTransactionMeta
    | undefined;

  if (meta?.type === "open-synthetic") {
    return {
      active: true,
      activation: "synthetic",
      anchorPos: meta.from,
      dismissedMatch: null,
      kind: meta.kind,
      query: "",
      range: { from: meta.from, to: meta.from },
      source: null,
      trigger: meta.trigger,
    };
  }

  if (meta?.type === "close") {
    return inactiveComposerSuggestionState();
  }

  if (meta?.type === "dismiss") {
    return dismissComposerSuggestionState(previous);
  }

  if (meta?.type === "set-source" && previous.active && previous.range !== null) {
    const from = transaction.mapping.map(previous.range.from, -1);
    const anchorPos = previous.activation === "typed" ? from + 1 : from;
    return {
      ...previous,
      anchorPos,
      query: "",
      range: { from, to: anchorPos },
      source: meta.source,
    };
  }

  if (!transaction.docChanged && !transaction.selectionSet) return previous;

  if (previous.activation === "synthetic" && previous.range !== null) {
    return deriveSyntheticSuggestionState({
      previous,
      transaction,
    });
  }

  return deriveTypedSuggestionState({
    doc: transaction.doc,
    selection: transaction.selection,
    dismissedMatch: previous.dismissedMatch,
    previous,
  });
}

export function createComposerSuggestionPlugin(
  options: { allowSlashCommands?: boolean } = {},
): Plugin<ComposerSuggestionState> {
  const admitted = (suggestion: ComposerSuggestionState) =>
    options.allowSlashCommands === false && suggestion.kind === "slash-command"
      ? inactiveComposerSuggestionState()
      : suggestion;
  return new Plugin<ComposerSuggestionState>({
    key: composerSuggestionPluginKey,
    state: {
      init: (_config, state) =>
        admitted(
          deriveTypedSuggestionState({
            doc: state.doc,
            selection: state.selection,
            dismissedMatch: null,
          }),
        ),
      apply: (transaction, previous) =>
        admitted(applyComposerSuggestionTransaction(transaction, previous)),
    },
    props: {
      handleDOMEvents: {
        blur(view) {
          const suggestion = readComposerSuggestionState(view.state);
          if (!suggestion.active) return false;
          view.dispatch(
            createComposerSuggestionTransaction(view.state, {
              type: "dismiss",
            }),
          );
          return false;
        },
      },
    },
  });
}

export function createComposerSuggestionTransaction(
  state: EditorState,
  meta: ComposerSuggestionTransactionMeta,
): Transaction {
  const suggestion = readComposerSuggestionState(state);
  const transaction = state.tr;
  if (
    (meta.type === "close" || meta.type === "dismiss") &&
    suggestion.active &&
    suggestion.activation === "synthetic" &&
    suggestion.kind === "slash-command" &&
    suggestion.range !== null
  ) {
    transaction.delete(suggestion.range.from, suggestion.range.to);
  }
  return transaction.setMeta(composerSuggestionPluginKey, meta);
}

export function readComposerSuggestionState(state: EditorState): ComposerSuggestionState {
  return composerSuggestionPluginKey.getState(state) ?? inactiveComposerSuggestionState();
}
