import { beforeEach, describe, expect, test } from "vite-plus/test";
import { act } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { renderWithMaitai } from "@/test/thread-maitai";
import { settleAsyncRender } from "@/test/dom";
import { clearPersistedAtomStoreForTests, writeAtom } from "@/lib/persisted-atom-store";
import type {
  ComposerPromptEditorHandle,
  ComposerPromptEditorKeyboardEvent,
} from "./composer-prompt-editor";
import {
  appendPromptToHistoryState,
  GLOBAL_PROMPT_HISTORY_SCOPE,
  MAX_PROMPT_HISTORY,
  normalizePromptHistoryState,
  PROMPT_HISTORY_ATOM_KEY,
  readScopedPromptHistory,
  useThreadComposerPromptHistoryRecall,
} from "./thread-composer-prompt-history";

interface FakeComposerController {
  editor: ComposerPromptEditorHandle;
  keyDown: (
    key: "ArrowUp" | "ArrowDown",
    options?: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">>,
  ) => {
    handled: boolean;
    prevented: boolean;
    stopped: boolean;
  };
  setComposerText: (text: string) => void;
  setCursorAtEnd: (value: boolean) => void;
  getText: () => string;
  getFocusCount: () => number;
  getSetTextCalls: () => string[];
}

function createKeyboardEvent(
  key: "ArrowUp" | "ArrowDown",
  options?: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">>,
) {
  let prevented = false;
  let stopped = false;
  const event = {
    key,
    altKey: options?.altKey ?? false,
    ctrlKey: options?.ctrlKey ?? false,
    metaKey: options?.metaKey ?? false,
    shiftKey: options?.shiftKey ?? false,
    isComposing: false,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as ComposerPromptEditorKeyboardEvent;

  return {
    event,
    result: () => ({ prevented, stopped }),
  };
}

function PromptHistoryHarness({
  controllerRef,
  initialText = "",
  scopeKey = "thread-1",
  selectLatestQueuedFollowUp,
}: {
  controllerRef: { current: FakeComposerController | null };
  initialText?: string;
  scopeKey?: string | null;
  selectLatestQueuedFollowUp?: () => boolean;
}) {
  const [composerText, setComposerTextState] = useState(initialText);
  const textRef = useRef(initialText);
  const cursorAtEndRef = useRef(true);
  const focusCountRef = useRef(0);
  const setTextCallsRef = useRef<string[]>([]);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);

  if (!editorRef.current) {
    const setText = (text: string) => {
      textRef.current = text;
      setTextCallsRef.current.push(text);
      setComposerTextState(text);
      return text;
    };

    editorRef.current = {
      getElement: () => null,
      focus: () => {
        focusCountRef.current += 1;
      },
      focusAtEnd: () => {
        focusCountRef.current += 1;
      },
      setText,
      setPromptText: setText,
      insertText: (text) => setText(`${textRef.current}${text}`),
      insertMention: () => textRef.current,
      replaceTextRange: ({ from, to, text }) => {
        const current = textRef.current;
        return setText(`${current.slice(0, from)}${text}${current.slice(to)}`);
      },
      clearRange: ({ from, to }) => {
        const current = textRef.current;
        return setText(`${current.slice(0, from)}${current.slice(to)}`);
      },
      toggleContextSuggestions: () => {},
      openSlashSubmenu: () => {},
      closeSuggestions: () => {},
      dismissSuggestions: () => {},
      getSelection: () => null,
      getSuggestionState: () => ({
        active: false,
        activation: null,
        anchorPos: textRef.current.length,
        dismissedMatch: null,
        kind: null,
        query: "",
        range: null,
        source: null,
        trigger: null,
      }),
      getText: () => textRef.current,
      getPersistedText: () => textRef.current,
      isCursorAtEnd: () => cursorAtEndRef.current,
      syncMentionMetadata: () => {},
    };
  }

  const { handlePromptHistoryKeyDown } = useThreadComposerPromptHistoryRecall({
    editorRef,
    scopeKey,
    composerText,
    selectLatestQueuedFollowUp,
  });

  useEffect(() => {
    controllerRef.current = {
      editor: editorRef.current as ComposerPromptEditorHandle,
      keyDown: (key, options) => {
        const { event, result } = createKeyboardEvent(key, options);
        const handled = handlePromptHistoryKeyDown(event);
        const flags = result();
        return {
          handled,
          prevented: flags.prevented,
          stopped: flags.stopped,
        };
      },
      setComposerText: (text) => {
        textRef.current = text;
        setComposerTextState(text);
      },
      setCursorAtEnd: (value) => {
        cursorAtEndRef.current = value;
      },
      getText: () => textRef.current,
      getFocusCount: () => focusCountRef.current,
      getSetTextCalls: () => [...setTextCallsRef.current],
    };
  }, [controllerRef, handlePromptHistoryKeyDown]);

  return <div data-composer-text={composerText} />;
}

describe("composer prompt history helpers", () => {
  test("reads and appends legacy array history through the global scope", () => {
    const state = ["first"];
    const nextState = appendPromptToHistoryState(state, GLOBAL_PROMPT_HISTORY_SCOPE, "second");

    expect(JSON.stringify(readScopedPromptHistory(nextState, GLOBAL_PROMPT_HISTORY_SCOPE))).toBe(
      '["first","second"]',
    );
    expect(JSON.stringify(readScopedPromptHistory(nextState, "thread-1"))).toBe("[]");
  });

  test("migrates legacy array history when writing a non-global scope", () => {
    const nextState = appendPromptToHistoryState(["global prompt"], "thread-1", "thread prompt");

    expect(JSON.stringify(nextState)).toBe(
      '{"global":["global prompt"],"thread-1":["thread prompt"]}',
    );
  });

  test("decodes the versioned persisted envelope", () => {
    const state = normalizePromptHistoryState({
      version: 1,
      histories: {
        global: ["global prompt"],
        "thread-1": ["thread prompt"],
      },
    });

    expect(JSON.stringify(readScopedPromptHistory(state, "thread-1"))).toBe('["thread prompt"]');
  });

  test("keeps keyed object history scoped per thread", () => {
    const nextState = appendPromptToHistoryState(
      { "thread-1": ["one"], "thread-2": ["other"] },
      "thread-1",
      "two",
    );

    expect(JSON.stringify(readScopedPromptHistory(nextState, "thread-1"))).toBe('["one","two"]');
    expect(JSON.stringify(readScopedPromptHistory(nextState, "thread-2"))).toBe('["other"]');
  });

  test("skips blank prompts and keeps only the latest twenty entries", () => {
    const initial = { "thread-1": ["one"] };
    const unchanged = appendPromptToHistoryState(initial, "thread-1", "   ");
    let state = unchanged;

    for (let index = 1; index <= 21; index += 1) {
      state = appendPromptToHistoryState(state, "thread-1", `prompt ${index}`) as Record<
        string,
        string[]
      >;
    }

    const history = readScopedPromptHistory(state, "thread-1");
    expect(unchanged === initial).toBe(true);
    expect(history.length).toBe(MAX_PROMPT_HISTORY);
    expect(history[0]).toBe("prompt 2");
    expect(history[19]).toBe("prompt 21");
  });
});

describe("useThreadComposerPromptHistoryRecall", () => {
  beforeEach(() => {
    Object.defineProperty(window, "api", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    clearPersistedAtomStoreForTests();
  });

  test("recalls newest prompt from an empty composer and walks history with ArrowUp and ArrowDown", async () => {
    await writeAtom(PROMPT_HISTORY_ATOM_KEY, { "thread-1": ["older", "newer"] });
    const controllerRef: { current: FakeComposerController | null } = { current: null };

    renderWithMaitai(<PromptHistoryHarness controllerRef={controllerRef} />);
    await settleAsyncRender();

    await act(async () => {
      const result = controllerRef.current?.keyDown("ArrowUp");
      expect(result?.handled ?? false).toBe(true);
      expect(result?.prevented ?? false).toBe(true);
      expect(result?.stopped ?? false).toBe(true);
      await Promise.resolve();
    });
    expect(controllerRef.current?.getText() ?? "").toBe("newer");

    await act(async () => {
      controllerRef.current?.keyDown("ArrowUp");
      await Promise.resolve();
    });
    expect(controllerRef.current?.getText() ?? "").toBe("older");

    await act(async () => {
      controllerRef.current?.keyDown("ArrowDown");
      await Promise.resolve();
    });
    expect(controllerRef.current?.getText() ?? "").toBe("newer");

    await act(async () => {
      controllerRef.current?.keyDown("ArrowDown");
      await Promise.resolve();
    });
    expect(controllerRef.current?.getText() ?? "not-empty").toBe("");
  });

  test("does not recall when composer is non-empty, cursor is not at end, or a modifier is pressed", async () => {
    await writeAtom(PROMPT_HISTORY_ATOM_KEY, { "thread-1": ["history"] });
    const controllerRef: { current: FakeComposerController | null } = { current: null };

    renderWithMaitai(<PromptHistoryHarness controllerRef={controllerRef} initialText="draft" />);
    await settleAsyncRender();

    await act(async () => {
      const nonEmptyResult = controllerRef.current?.keyDown("ArrowUp");
      expect(nonEmptyResult?.handled ?? true).toBe(false);
      controllerRef.current?.setComposerText("");
      controllerRef.current?.setCursorAtEnd(false);
      await Promise.resolve();
    });

    await act(async () => {
      const cursorResult = controllerRef.current?.keyDown("ArrowUp");
      expect(cursorResult?.handled ?? true).toBe(false);
      controllerRef.current?.setCursorAtEnd(true);
      await Promise.resolve();
    });

    await act(async () => {
      const modifierResult = controllerRef.current?.keyDown("ArrowUp", { shiftKey: true });
      expect(modifierResult?.handled ?? true).toBe(false);
      await Promise.resolve();
    });

    expect(controllerRef.current?.getSetTextCalls().length ?? -1).toBe(0);
  });

  test("resets traversal after manual edits diverge from the recalled entry", async () => {
    await writeAtom(PROMPT_HISTORY_ATOM_KEY, { "thread-1": ["older", "newer"] });
    const controllerRef: { current: FakeComposerController | null } = { current: null };

    renderWithMaitai(<PromptHistoryHarness controllerRef={controllerRef} />);
    await settleAsyncRender();

    await act(async () => {
      controllerRef.current?.keyDown("ArrowUp");
      await Promise.resolve();
    });
    await act(async () => {
      controllerRef.current?.setComposerText("edited");
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      const result = controllerRef.current?.keyDown("ArrowDown");
      expect(result?.handled ?? true).toBe(false);
      await Promise.resolve();
    });

    expect(controllerRef.current?.getText() ?? "").toBe("edited");
  });

  test("lets the latest queued follow-up consume ArrowUp before history recall", async () => {
    await writeAtom(PROMPT_HISTORY_ATOM_KEY, { "thread-1": ["history"] });
    const controllerRef: { current: FakeComposerController | null } = { current: null };
    let queueSelections = 0;

    renderWithMaitai(
      <PromptHistoryHarness
        controllerRef={controllerRef}
        selectLatestQueuedFollowUp={() => {
          queueSelections += 1;
          return true;
        }}
      />,
    );
    await settleAsyncRender();

    await act(async () => {
      const result = controllerRef.current?.keyDown("ArrowUp");
      expect(result?.handled ?? false).toBe(true);
      await Promise.resolve();
    });

    expect(queueSelections).toBe(1);
    expect(controllerRef.current?.getText() ?? "").toBe("");
  });
});
