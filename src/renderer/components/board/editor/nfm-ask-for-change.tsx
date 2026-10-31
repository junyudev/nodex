import { PositionPopover, useBlockNoteEditor, useEditorState } from "@blocknote/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ActivitySpinnerIcon, AskAiIcon, UpArrowIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexFloatingLayerProvider } from "@/components/ui/floating-layer";
import { NodexTooltip } from "@/components/ui/tooltip";
import { pageTextRewrite } from "@/features/page-text-rewrite/page-text-rewrite";
import { readMarkdown, writeMarkdown, type MarkdownBlock } from "../../../../shared/nodex-markdown";
import {
  createNfmEditorFloatingMiddleware,
  NFM_EDITOR_FLOATING_UI_PORTAL_ELEMENT,
  NFM_EDITOR_FLOATING_UI_Z_INDEX,
} from "./nfm-blocknote-floating-ui";
import {
  buildNfmAskForChangeRequest,
  NFM_ASK_FOR_CHANGE_QUICK_INSTRUCTIONS,
  reduceNfmAskForChange,
  type NfmAskForChangeSource,
  type NfmAskForChangeState,
} from "./nfm-ask-for-change-model";
import { pasteNfmBlocks, type NfmBlocksPasteEditor } from "./nfm-paste-blocks";
import { useNfmRetainedSelectionPresentation } from "./nfm-retained-selection-presentation";
import { ReadonlyMarkdownBlockNotePreview } from "./readonly-nfm-blocknote-preview";
import { resolveNormalizedSelectionBlocks, type SelectionEditorLike } from "./special-block-copy";

const ASK_FOR_CHANGE_SELECTION_KEY = "nfmAskForChange";
const NEIGHBOR_BLOCKS = 3;

interface AskForChangeDocumentEditor {
  readonly document: readonly MarkdownBlock[];
  getSelection(): { blocks: readonly { id: string }[] } | undefined;
}

/** The selection as Nodex Markdown, and a few Blocks on each side to inform the rewrite. */
function captureAskForChangeSource(
  editor: SelectionEditorLike & AskForChangeDocumentEditor,
): NfmAskForChangeSource | null {
  const markdown = writeMarkdown(
    resolveNormalizedSelectionBlocks(editor) as unknown as MarkdownBlock[],
  ).trim();
  if (!markdown) return null;
  const selected = editor.getSelection()?.blocks ?? [];
  const document = editor.document;
  const first = document.findIndex((block) => block.id === selected[0]?.id);
  const last = document.findIndex((block) => block.id === selected.at(-1)?.id);
  const around = (from: number, to: number) =>
    from < to ? writeMarkdown(document.slice(Math.max(0, from), to)) : "";
  return {
    markdown,
    before: first > 0 ? around(first - NEIGHBOR_BLOCKS, first) : "",
    after: last >= 0 ? around(last + 1, last + 1 + NEIGHBOR_BLOCKS) : "",
  };
}

interface NfmAskForChangeValue {
  readonly open: () => void;
}

const NfmAskForChangeContext = createContext<NfmAskForChangeValue | null>(null);

/** Ask for change in this editor, when it offers one. */
export function useNfmAskForChange(): NfmAskForChangeValue | null {
  return useContext(NfmAskForChangeContext);
}

/**
 * Owns one review at a time: a rewrite of the selection that never touches the Document until
 * it is accepted, and then replaces the selection the way pasting Nodex Markdown would.
 */
export function NfmAskForChangeProvider({
  projectId,
  pageId,
  children,
}: {
  readonly projectId: string | null;
  readonly pageId: string | null;
  readonly children: ReactNode;
}) {
  const editor = useBlockNoteEditor();
  const [state, dispatch] = useReducer(reduceNfmAskForChange, { phase: "closed" });

  const open = useCallback(() => {
    if (!editor.isEditable) return;
    const source = captureAskForChangeSource(
      editor as unknown as SelectionEditorLike & AskForChangeDocumentEditor,
    );
    if (source) dispatch({ type: "open", source });
  }, [editor]);
  // Editability changes without re-rendering this provider; the entry point checks it per render.
  const value = useMemo(() => ({ open }), [open]);

  // Each working state is one request; leaving it, however it ends, cancels what is in flight.
  useEffect(() => {
    if (state.phase !== "working") return;
    const handle = pageTextRewrite.start(buildNfmAskForChangeRequest(state));
    let current = true;
    void handle.result.then((result) => {
      if (!current) return;
      if (result.kind === "done") dispatch({ type: "settled", proposal: result.markdown });
      else if (result.kind === "error") dispatch({ type: "failed", message: result.error.message });
    });
    return () => {
      current = false;
      void handle.cancel();
    };
  }, [state]);

  const accept = useCallback(() => {
    if (state.phase !== "review") return;
    editor.focus();
    pasteNfmBlocks(editor as unknown as NfmBlocksPasteEditor, readMarkdown(state.proposal));
    dispatch({ type: "close" });
  }, [editor, state]);

  const close = useCallback(() => {
    dispatch({ type: "close" });
    editor.focus();
  }, [editor]);

  return (
    <NfmAskForChangeContext.Provider value={value}>
      {children}
      {state.phase === "closed" ? null : (
        <AskForChangePanel
          state={state}
          projectId={projectId}
          pageId={pageId}
          onAsk={(instruction) => dispatch({ type: "ask", instruction })}
          onRetry={() => dispatch({ type: "retry" })}
          onAccept={accept}
          onClose={close}
        />
      )}
    </NfmAskForChangeContext.Provider>
  );
}

const PANEL_FLOATING_OPTIONS = {
  useFloatingOptions: {
    open: true,
    placement: "bottom-start" as const,
    strategy: "fixed" as const,
    middleware: createNfmEditorFloatingMiddleware(8),
  },
  focusManagerProps: { disabled: true },
  elementProps: { style: { zIndex: NFM_EDITOR_FLOATING_UI_Z_INDEX } },
};

function AskForChangePanel({
  state,
  projectId,
  pageId,
  onAsk,
  onRetry,
  onAccept,
  onClose,
}: {
  readonly state: Exclude<NfmAskForChangeState, { phase: "closed" }>;
  readonly projectId: string | null;
  readonly pageId: string | null;
  readonly onAsk: (instruction: string) => void;
  readonly onRetry: () => void;
  readonly onAccept: () => void;
  readonly onClose: () => void;
}) {
  const editor = useBlockNoteEditor();
  const range = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const selection = current.prosemirrorState.selection;
      return `${selection.from}:${selection.to}`;
    },
  });
  const [from = 0, to = 0] = range.split(":").map(Number);
  useNfmRetainedSelectionPresentation("inline", ASK_FOR_CHANGE_SELECTION_KEY, []);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");

  // Pointing anywhere else, or returning to the editor, ends the review as Escape does, so
  // typing can never land in the Page while a rewrite of it is on screen.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      onClose();
    };
    const editorRoot = editor.domElement;
    document.addEventListener("pointerdown", onPointerDown, true);
    editorRoot?.addEventListener("focusin", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      editorRoot?.removeEventListener("focusin", onClose);
    };
  }, [editor, onClose]);

  const submit = () => {
    if (draft.trim()) {
      onAsk(draft);
      setDraft("");
    } else if (state.phase === "review") onAccept();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && state.phase === "review") {
      event.preventDefault();
      onAccept();
    }
  };

  return (
    <PositionPopover
      position={{ from, to }}
      portalElement={NFM_EDITOR_FLOATING_UI_PORTAL_ELEMENT}
      {...PANEL_FLOATING_OPTIONS}
    >
      <NodexFloatingLayerProvider zIndex={NFM_EDITOR_FLOATING_UI_Z_INDEX}>
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Ask for change"
          data-nfm-ask-for-change={state.phase}
          onKeyDown={onKeyDown}
          className="pointer-events-auto flex w-[min(32rem,calc(100vw-24px))] flex-col gap-1.5 rounded-[14px] bg-token-dropdown-background p-1.5 text-sm text-token-foreground shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-xl"
        >
          {state.phase === "review" ? (
            <div className="max-h-80 overflow-auto rounded-[10px] bg-token-foreground/[0.03] px-3 py-1">
              <ReadonlyMarkdownBlockNotePreview
                content={state.proposal}
                projectId={projectId ?? ""}
                pageId={pageId ?? ""}
              />
            </div>
          ) : null}
          {state.phase === "working" ? (
            <div className="flex h-8 items-center gap-2 px-2 text-token-description-foreground">
              <ActivitySpinnerIcon className="size-3.5 shrink-0" />
              <span className="shrink-0 text-token-foreground">Rewriting</span>
              <span className="min-w-0 flex-1 truncate">{state.instruction}</span>
              <NodexButton variant="ghostSecondary" size="xs" onClick={onClose}>
                Stop
              </NodexButton>
            </div>
          ) : (
            <form
              className="flex h-8 items-center gap-2 pr-1 pl-2"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <AskAiIcon className="size-3.5 shrink-0 text-token-description-foreground" />
              {/* The panel mounts a frame after it opens; autoFocus lands when the input does. */}
              <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label="Change to ask for"
                placeholder={
                  state.phase === "compose" ? "Ask for a change…" : "Ask for another change…"
                }
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-token-description-foreground"
              />
              {state.phase === "review" && !draft.trim() ? (
                <>
                  <NodexButton variant="ghostSecondary" size="xs" onClick={onClose}>
                    Discard
                  </NodexButton>
                  <NodexButton variant="ghostSecondary" size="xs" onClick={onRetry}>
                    Try again
                  </NodexButton>
                  <NodexTooltip tooltipContent="Accept" shortcutLabel="⏎" side="top" delay={0}>
                    <NodexButton variant="primary" size="xs" type="submit">
                      Accept
                    </NodexButton>
                  </NodexTooltip>
                </>
              ) : (
                <button
                  type="submit"
                  aria-label="Ask"
                  disabled={!draft.trim()}
                  className="flex size-6 shrink-0 cursor-interaction items-center justify-center rounded-full bg-composer-primary text-composer-primary disabled:cursor-default disabled:opacity-40"
                >
                  <UpArrowIcon className="size-3.5" />
                </button>
              )}
            </form>
          )}
          {state.phase === "failed" ? (
            <div className="flex items-center gap-2 px-2 pb-0.5 text-token-error-foreground">
              <span className="min-w-0 flex-1">{state.message}</span>
              <NodexButton variant="ghostSecondary" size="xs" onClick={onRetry}>
                Try again
              </NodexButton>
            </div>
          ) : null}
          {state.phase === "compose" ? (
            <div className="flex flex-wrap gap-1 px-1.5 pb-0.5">
              {NFM_ASK_FOR_CHANGE_QUICK_INSTRUCTIONS.map((quick) => (
                <button
                  key={quick.label}
                  type="button"
                  className="h-6 cursor-interaction rounded-full px-2 text-xs text-token-text-secondary ring-[0.5px] ring-token-border ring-inset hover:bg-token-foreground/5"
                  onClick={() => onAsk(quick.instruction)}
                >
                  {quick.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </NodexFloatingLayerProvider>
    </PositionPopover>
  );
}
