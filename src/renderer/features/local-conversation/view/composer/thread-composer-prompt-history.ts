import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import {
  persistedAtom,
  preloadPersistedAtom,
  useMaitaiStore,
  usePersistedAtomValue,
  useSetPersistedAtom,
} from "@/lib/maitai";
import type {
  ComposerPromptEditorHandle,
  ComposerPromptEditorKeyboardEvent,
} from "./composer-prompt-editor";

export const PROMPT_HISTORY_ATOM_KEY = "prompt-history";
export const GLOBAL_PROMPT_HISTORY_SCOPE = "global";
export const MAX_PROMPT_HISTORY = 20;

export type PromptHistoryState = string[] | Record<string, string[]>;

interface PromptHistoryEnvelopeV1 {
  readonly version: 1;
  readonly histories: Record<string, string[]>;
}

interface UseThreadComposerPromptHistoryRecallInput {
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
  scopeKey: string | null;
  composerText: string;
  selectLatestQueuedFollowUp?: () => boolean;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveScopeKey(scopeKey: string | null): string {
  const trimmed = scopeKey?.trim();
  return trimmed ? trimmed : GLOBAL_PROMPT_HISTORY_SCOPE;
}

export function normalizePromptHistoryState(value: unknown): PromptHistoryState {
  if (isRecord(value) && value.version === 1 && isRecord(value.histories)) {
    return normalizePromptHistoryState(value.histories);
  }

  if (isStringArray(value)) {
    return [...value];
  }

  if (!isRecord(value)) {
    return [];
  }

  const next: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isStringArray(entry)) {
      next[key] = [...entry];
    }
  }

  return next;
}

function encodePromptHistoryState(value: PromptHistoryState): PromptHistoryEnvelopeV1 {
  return {
    version: 1,
    histories: Array.isArray(value)
      ? { [GLOBAL_PROMPT_HISTORY_SCOPE]: [...value] }
      : Object.fromEntries(Object.entries(value).map(([scope, history]) => [scope, [...history]])),
  };
}

export const promptHistoryAtom = persistedAtom<PromptHistoryState>({
  debugLabel: "thread-composer-prompt-history",
  storageKey: PROMPT_HISTORY_ATOM_KEY,
  defaultValue: [],
  hydration: "eager",
  synchronization: "cross-window",
  optimistic: true,
  writeFailure: "retain-and-error",
  decode: normalizePromptHistoryState,
  encode: encodePromptHistoryState,
});

export function readScopedPromptHistory(
  state: PromptHistoryState,
  scopeKey: string | null,
): string[] {
  const scope = resolveScopeKey(scopeKey);
  if (Array.isArray(state)) {
    return scope === GLOBAL_PROMPT_HISTORY_SCOPE ? state : [];
  }

  return state[scope] ?? [];
}

export function appendPromptToHistoryState(
  state: PromptHistoryState,
  scopeKey: string | null,
  text: string,
): PromptHistoryState {
  if (text.trim().length === 0) {
    return state;
  }

  const scope = resolveScopeKey(scopeKey);
  const previous = readScopedPromptHistory(state, scope);
  const nextScopedHistory = [...previous, text].slice(-MAX_PROMPT_HISTORY);

  if (Array.isArray(state)) {
    return scope === GLOBAL_PROMPT_HISTORY_SCOPE
      ? nextScopedHistory
      : {
          [GLOBAL_PROMPT_HISTORY_SCOPE]: state,
          [scope]: nextScopedHistory,
        };
  }

  return {
    ...state,
    [scope]: nextScopedHistory,
  };
}

function eventHasModifier(event: ComposerPromptEditorKeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

export function useThreadComposerPromptHistoryRecall({
  editorRef,
  scopeKey,
  composerText,
  selectLatestQueuedFollowUp,
}: UseThreadComposerPromptHistoryRecallInput) {
  const scope = resolveScopeKey(scopeKey);
  const store = useMaitaiStore();
  const historyLoadable = usePersistedAtomValue(promptHistoryAtom);
  const setHistoryState = useSetPersistedAtom(promptHistoryAtom);
  const historyState = historyLoadable.value;
  const historyStateRef = useRef<PromptHistoryState>(historyState);
  const selectedIndexRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    historyStateRef.current = historyState;
  }, [historyState]);
  const selectionScopeRef = useRef(scope);
  useEffect(() => {
    if (selectionScopeRef.current === scope) return;
    selectionScopeRef.current = scope;
    selectedIndexRef.current = null;
  }, [scope]);

  useEffect(() => {
    const selectedIndex = selectedIndexRef.current;
    if (selectedIndex === null) return;

    const scopedHistory = readScopedPromptHistory(historyStateRef.current, scope);
    if (scopedHistory[selectedIndex] !== composerText) {
      selectedIndexRef.current = null;
    }
  }, [composerText, scope]);

  const scopedHistory = useMemo(
    () => readScopedPromptHistory(historyState, scope),
    [historyState, scope],
  );

  const resetHistorySelection = useCallback(() => {
    selectedIndexRef.current = null;
  }, []);

  const appendPromptToHistory = useCallback(
    (text: string) => {
      if (text.trim().length === 0) return;

      selectedIndexRef.current = null;
      void preloadPersistedAtom(store, promptHistoryAtom)
        .then(() =>
          setHistoryState((currentState) => {
            const nextState = appendPromptToHistoryState(currentState, scope, text);
            historyStateRef.current = nextState;
            return nextState;
          }),
        )
        .catch(() => undefined);
    },
    [scope, setHistoryState, store],
  );

  const restoreHistoryEntry = useCallback(
    (index: number): boolean => {
      const editor = editorRef.current;
      if (!editor) return false;

      const history = readScopedPromptHistory(historyStateRef.current, scope);
      const entry = history[index];
      if (typeof entry !== "string") return false;

      selectedIndexRef.current = index;
      editor.setPromptText(entry);
      editor.focus();
      return true;
    },
    [editorRef, scope],
  );

  const moveHistorySelection = useCallback(
    (direction: "up" | "down"): boolean => {
      const editor = editorRef.current;
      if (!editor) return false;

      const history = readScopedPromptHistory(historyStateRef.current, scope);
      if (history.length === 0) return false;

      const selectedIndex = selectedIndexRef.current;
      if (selectedIndex === null) {
        if (direction === "down") return false;
        if (editor.getPersistedText().trim().length !== 0) return false;
        return restoreHistoryEntry(history.length - 1);
      }

      if (direction === "down" && selectedIndex === history.length - 1) {
        selectedIndexRef.current = null;
        editor.setText("");
        editor.focus();
        return true;
      }

      const delta = direction === "up" ? -1 : 1;
      const nextIndex = (selectedIndex + delta + history.length) % history.length;
      return restoreHistoryEntry(nextIndex);
    },
    [editorRef, restoreHistoryEntry, scope],
  );

  const handlePromptHistoryKeyDown = useCallback(
    (event: ComposerPromptEditorKeyboardEvent): boolean => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
      if (eventHasModifier(event)) return false;

      const editor = editorRef.current;
      if (!editor || !editor.isCursorAtEnd()) return false;

      const handled =
        event.key === "ArrowUp"
          ? selectLatestQueuedFollowUp?.() || moveHistorySelection("up")
          : moveHistorySelection("down");
      if (!handled) return false;

      event.preventDefault();
      event.stopPropagation();
      return true;
    },
    [editorRef, moveHistorySelection, selectLatestQueuedFollowUp],
  );

  return {
    appendPromptToHistory,
    handlePromptHistoryKeyDown,
    resetHistorySelection,
    scopedHistory,
  };
}
