import type { FileDiffMetadata, SupportedLanguages } from "@pierre/diffs";
import {
  Editor,
  type EditorChangeEvent,
  type EditorFactory,
  type EditorType,
  type EditorViewState,
} from "@pierre/diffs/edit";
import {
  CodeView,
  EditProvider,
  type CodeViewHandle,
  type CodeViewItem,
  type CodeViewProps,
} from "@pierre/diffs/react";
import {
  useEffect,
  useImperativeHandle,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  NODEX_SOURCE_HOST_CLASS,
  getNodexDiffOptions,
  getNodexSourceEditorHostStyle,
  getNodexSourceEditorLineHeight,
  getNodexSourceOptions,
} from "@/lib/diff-presentation";
import { useTheme } from "@/lib/use-theme";
import { useCodeFontSize } from "@/lib/use-code-font-size";
import { cn } from "@/lib/utils";
import {
  buildWorkspaceFileEditorSelection,
  buildWorkspaceFileLineSelection,
  buildWorkspaceFileScrollTarget,
} from "@/lib/workspace-file-reveal";
import {
  workspaceFileChangedSections,
  workspaceFileChangeNavigation,
  type WorkspaceFileChangeNavigationState,
} from "./workspace-file-change-blocks";
import { workspaceFileEditorDiffFromContents } from "./workspace-file-editor-diff";
import {
  buildWorkspaceFileDraftLineMap,
  workspaceFileSavedLineNumber,
} from "./workspace-file-draft-line-map";

export interface WorkspacePierreEditorHandle {
  navigateChange(direction: "previous" | "next"): void;
}

export interface WorkspacePierreEditorProps {
  readonly ref?: Ref<WorkspacePierreEditorHandle>;
  readonly value: string;
  readonly filename: string;
  readonly language: SupportedLanguages | null;
  readonly sourceIdentity: string;
  readonly documentVersion: number;
  readonly ariaLabel: string;
  readonly wrap?: boolean;
  readonly className?: string;
  /** Shows a diff against oldContent. Omit newContent for the live editable draft. */
  readonly comparison?: {
    readonly oldContent: string;
    readonly oldPath: string;
    readonly newContent?: string | null;
    readonly layout: "unified" | "split";
  } | null;
  readonly onChangeNavigationChange?: (state: WorkspaceFileChangeNavigationState | null) => void;
  readonly activeLineBlame?: {
    readonly savedContent: string;
    readonly labelForSavedLine: (lineNumber: number) => string | null;
  } | null;
  readonly onChange: (value: string) => void;
  readonly onRevealComplete?: (
    location: NonNullable<WorkspacePierreEditorProps["revealLocation"]>,
  ) => void;
  readonly revealLocation?: {
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
  };
}

const INLINE_BLAME_CSS = `
[data-content] > [data-line] > [data-pierre-editor-inline-blame]::after {
  content: attr(data-pierre-editor-inline-blame);
  color: var(--color-text-tertiary);
  margin-inline-start: var(--padding-row-x);
  pointer-events: none;
  user-select: none;
  white-space: nowrap;
}
`;
const EMPTY_ITEMS: CodeViewItem<undefined>[] = [];

interface EditorSession {
  readonly sourceIdentity: string;
  readonly documentVersion: number;
  readonly filename: string;
  readonly language: SupportedLanguages | null;
  readonly oldContent: string | undefined;
  readonly oldPath: string | undefined;
  readonly snapshotContent: string | null;
  content: string;
  lineCount: number;
  caretLineIndex: number;
  diff?: FileDiffMetadata;
  editor?: Editor;
}

const createWorkspaceEditor: EditorFactory<undefined, undefined> = (
  editorType,
  options,
  editStateKey,
) => new Editor(editorType, options, editStateKey);

function editorCaretLine(editor: Editor | undefined): number | undefined {
  const selection = editor?.getViewState().selections?.at(-1);
  if (!selection) return undefined;
  return selection.direction < 0 ? selection.start.line : selection.end.line;
}

function editorChangedSections(session: EditorSession) {
  // Active hunks belong to Pierre's edit session; the input diff stays immutable.
  const state = session.editor?.getEditState();
  const diff = state?.type === "file-diff" ? state.diffSession : session.diff;
  return diff ? workspaceFileChangedSections(diff) : [];
}

export function WorkspacePierreEditor({
  ref,
  value,
  filename,
  language,
  sourceIdentity,
  documentVersion,
  ariaLabel,
  wrap = true,
  className,
  comparison,
  activeLineBlame,
  onChangeNavigationChange,
  onChange,
  revealLocation,
  onRevealComplete,
}: WorkspacePierreEditorProps) {
  const codeViewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<EditorSession | null>(null);
  const restoreRef = useRef<{ state: EditorViewState; focused: boolean; scrollTop: number } | null>(
    null,
  );
  const surfaceRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<MutationObserver | null>(null);
  const inlineBlameRef = useRef<HTMLSpanElement | null>(null);
  const navigationRef = useRef<{
    state: WorkspaceFileChangeNavigationState | null;
    callback: WorkspacePierreEditorProps["onChangeNavigationChange"];
  } | null>(null);
  const mappedRef = useRef<{
    saved: string;
    draft: string;
    ranges: ReturnType<typeof buildWorkspaceFileDraftLineMap>;
  } | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const revisionRef = useRef(0);
  const editorIdentity = useId();
  const [attachment, setAttachment] = useState<EditorSession | null>(null);
  const [schedule] = useState(() => {
    let pending = false;
    return () => {
      if (pending) return;
      pending = true;
      // Coalesce document, selection, and virtualized-row updates after the current turn.
      queueMicrotask(() => {
        pending = false;
        refreshRef.current?.();
      });
    };
  });
  const { resolved } = useTheme();
  const { codeFontSize } = useCodeFontSize();
  const oldContent = comparison?.oldContent;
  const oldPath = comparison?.oldPath;
  const snapshotContent = comparison?.newContent ?? null;
  const layout = comparison?.layout;

  const options = useMemo<NonNullable<CodeViewProps<undefined, undefined>["options"]>>(() => {
    const presentation = getNodexSourceOptions(resolved, true, {
      disableLineNumbers: false,
      wrap: !!layout || wrap,
    });
    const diffOptions = layout
      ? getNodexDiffOptions(resolved, true, { diffStyle: layout, wrap: true })
      : undefined;
    return {
      ...presentation,
      diffStyle: diffOptions?.diffStyle,
      diffIndicators: diffOptions?.diffIndicators,
      lineDiffType: diffOptions?.lineDiffType,
      hunkSeparators: "simple",
      expandUnchanged: true,
      unsafeCSS: `${presentation.unsafeCSS ?? ""}\n${INLINE_BLAME_CSS}`,
      itemMetrics: { lineHeight: getNodexSourceEditorLineHeight(codeFontSize), spacing: 0 },
      onPostRender: (node, _instance, phase) => {
        if (phase === "unmount") {
          if (surfaceRef.current !== node) return;
          surfaceRef.current = null;
          observerRef.current?.disconnect();
          inlineBlameRef.current?.remove();
          inlineBlameRef.current = null;
          return;
        }
        if (surfaceRef.current !== node) {
          observerRef.current?.disconnect();
          surfaceRef.current = node;
          observerRef.current = new MutationObserver(schedule);
          if (node.shadowRoot)
            observerRef.current.observe(node.shadowRoot, {
              subtree: true,
              childList: true,
              attributes: true,
              attributeFilter: ["data-line", "data-line-type"],
            });
        }
        schedule();
      },
    };
  }, [codeFontSize, layout, resolved, schedule, wrap]);
  const style = useMemo(
    () => getNodexSourceEditorHostStyle(resolved, codeFontSize),
    [codeFontSize, resolved],
  );

  useLayoutEffect(() => {
    const codeView = codeViewRef.current;
    if (!codeView) return;
    const previous = sessionRef.current;
    const content = snapshotContent ?? value;
    // A remounted CodeView (React's development double mount) starts without the item.
    const mounted = codeView.getInstance()?.getItem(sourceIdentity) != null;
    if (
      mounted &&
      previous &&
      previous.sourceIdentity === sourceIdentity &&
      previous.documentVersion === documentVersion &&
      previous.filename === filename &&
      previous.language === language &&
      previous.oldContent === oldContent &&
      previous.oldPath === oldPath &&
      previous.snapshotContent === snapshotContent &&
      previous.content === content
    ) {
      schedule();
      return;
    }

    const previousEditor = previous?.editor;
    if (
      previous?.sourceIdentity !== sourceIdentity ||
      previous.documentVersion !== documentVersion
    ) {
      restoreRef.current = null;
    } else if (previousEditor) {
      restoreRef.current = {
        state: previousEditor.getViewState(),
        focused: surfaceRef.current?.shadowRoot?.activeElement != null,
        scrollTop: codeView.getInstance()?.getScrollTop() ?? 0,
      };
    }
    const revision = ++revisionRef.current;
    // Differently edited surfaces for the same file must not share highlighted content.
    const cacheKey = `${editorIdentity}:${sourceIdentity}:${documentVersion}:${revision}`;
    const diff =
      oldContent === undefined
        ? undefined
        : workspaceFileEditorDiffFromContents({
            path: filename,
            oldPath,
            oldContent,
            newContent: content,
          });
    if (diff) {
      diff.cacheKey = cacheKey;
      diff.lang = language ?? undefined;
    }
    const item: CodeViewItem<undefined> = diff
      ? {
          id: sourceIdentity,
          type: "diff",
          edit: snapshotContent === null,
          version: revision,
          fileDiff: diff,
        }
      : {
          id: sourceIdentity,
          type: "file",
          edit: true,
          version: revision,
          file: { name: filename, contents: content, cacheKey, lang: language ?? undefined },
        };
    const session: EditorSession = {
      sourceIdentity,
      documentVersion,
      filename,
      language,
      oldContent,
      oldPath,
      snapshotContent,
      diff,
      content,
      lineCount: content.split("\n").length,
      caretLineIndex: previous?.sourceIdentity === sourceIdentity ? previous.caretLineIndex : 0,
    };
    sessionRef.current = session;
    // CodeView rejects a type change for an existing id. A new baseline/revision also
    // starts a fresh session; normal draft echoes keep Pierre's owned hunks and history.
    // Unkeyed editors retain active state across layout/virtualization, then release it here.
    codeView.getInstance()?.setItems(EMPTY_ITEMS);
    codeView.addItems([item]);
    schedule();
  }, [
    documentVersion,
    editorIdentity,
    filename,
    language,
    oldContent,
    oldPath,
    schedule,
    snapshotContent,
    sourceIdentity,
    value,
  ]);

  useLayoutEffect(() => {
    refreshRef.current = () => {
      const session = sessionRef.current;
      if (!session) return;
      const caretLine = editorCaretLine(session.editor);
      session.caretLineIndex = caretLine ?? session.caretLineIndex;
      const nextState = session.diff
        ? workspaceFileChangeNavigation(
            editorChangedSections(session),
            session.caretLineIndex,
            session.lineCount,
          )
        : null;
      const previous = navigationRef.current;
      const sameState =
        previous &&
        nextState?.count === previous.state?.count &&
        nextState?.activeIndex === previous.state?.activeIndex &&
        nextState?.previousIndex === previous.state?.previousIndex &&
        nextState?.nextIndex === previous.state?.nextIndex;
      if (!sameState || previous.callback !== onChangeNavigationChange) {
        const state = sameState ? previous.state : nextState;
        navigationRef.current = { state, callback: onChangeNavigationChange };
        onChangeNavigationChange?.(state);
      }

      const root = surfaceRef.current?.shadowRoot;
      const draft = session.editor?.getText();
      if (
        !activeLineBlame ||
        caretLine === undefined ||
        session.snapshotContent !== null ||
        draft === undefined ||
        !root
      ) {
        inlineBlameRef.current?.remove();
        inlineBlameRef.current = null;
        return;
      }
      let mapped = mappedRef.current;
      if (mapped?.saved !== activeLineBlame.savedContent || mapped?.draft !== draft) {
        mapped = {
          saved: activeLineBlame.savedContent,
          draft,
          ranges: buildWorkspaceFileDraftLineMap(activeLineBlame.savedContent, draft),
        };
        mappedRef.current = mapped;
      }
      const lineNumber = session.caretLineIndex + 1;
      const savedLine = workspaceFileSavedLineNumber(mapped.ranges, lineNumber);
      const label = savedLine === null ? null : activeLineBlame.labelForSavedLine(savedLine);
      const line =
        label == null
          ? null
          : root.querySelector(
              `[data-code]:not([data-deletions]) [data-content] > [data-line="${lineNumber}"]:not([data-line-type="change-deletion"])`,
            );
      if (!line) {
        inlineBlameRef.current?.remove();
        inlineBlameRef.current = null;
        return;
      }
      // Pierre annotations occupy rows and markers underline diagnostics; neither can
      // append an inline label. Keep one empty span and reattach after row reuse.
      if (inlineBlameRef.current?.parentElement !== line) {
        inlineBlameRef.current?.remove();
        const span = line.ownerDocument.createElement("span");
        span.contentEditable = "false";
        span.setAttribute("aria-hidden", "true");
        inlineBlameRef.current = span;
        line.append(span);
      }
      inlineBlameRef.current.setAttribute("data-pierre-editor-inline-blame", label!);
    };
    schedule();
    return () => {
      refreshRef.current = null;
    };
  }, [activeLineBlame, onChangeNavigationChange, schedule]);

  useEffect(() => {
    const container = containerRef.current;
    const document = container?.ownerDocument;
    if (!document) return;
    container.tabIndex = -1;
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("keyup", schedule);
    document.addEventListener("pointerup", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("keyup", schedule);
      document.removeEventListener("pointerup", schedule);
      observerRef.current?.disconnect();
      inlineBlameRef.current?.remove();
    };
  }, [schedule]);

  useImperativeHandle(
    ref,
    () => ({
      navigateChange(direction) {
        const session = sessionRef.current;
        const codeView = codeViewRef.current;
        if (!session?.diff || !codeView) return;
        const caretLine = editorCaretLine(session.editor) ?? session.caretLineIndex;
        const sections = editorChangedSections(session);
        const navigation = workspaceFileChangeNavigation(sections, caretLine, session.lineCount);
        const targetIndex =
          direction === "previous" ? navigation.previousIndex : navigation.nextIndex;
        const block = sections[targetIndex];
        if (!block) return;
        const position = {
          line: Math.min(block.additionLineIndex, session.lineCount - 1),
          character: 0,
        };
        session.caretLineIndex = position.line;
        codeView.setSelectedLines(null);
        session.editor?.setSelections([{ start: position, end: position, direction: "none" }]);
        codeView.scrollTo({
          type: "line",
          id: session.sourceIdentity,
          side: block.additions > 0 ? "additions" : "deletions",
          lineNumber: (block.additions > 0 ? block.additionLineIndex : block.deletionLineIndex) + 1,
          align: "center",
          behavior: "instant",
        });
        if (session.editor) session.editor.focus({ preventScroll: true });
        else containerRef.current?.focus({ preventScroll: true });
        schedule();
      },
    }),
    [schedule],
  );

  useEffect(() => {
    if (!revealLocation?.line || attachment !== sessionRef.current || !attachment?.editor) return;
    const codeView = codeViewRef.current;
    if (!codeView || attachment.sourceIdentity !== sourceIdentity) return;
    if (codeView.getEditor(sourceIdentity) !== attachment.editor) return;
    const editorSelection = buildWorkspaceFileEditorSelection(revealLocation);
    if (editorSelection) {
      codeView.setSelectedLines(null);
      attachment.editor.setSelections([editorSelection]);
    } else {
      codeView.setSelectedLines(buildWorkspaceFileLineSelection(sourceIdentity, revealLocation));
    }
    const target = buildWorkspaceFileScrollTarget(sourceIdentity, revealLocation);
    if (target) codeView.scrollTo(target);
    schedule();
    onRevealComplete?.(revealLocation);
  }, [attachment, onRevealComplete, revealLocation, schedule, sourceIdentity]);

  const handleEditChange = ({ file }: EditorChangeEvent<EditorType, undefined, undefined>) => {
    const session = sessionRef.current;
    if (!session || session.snapshotContent !== null) return;
    session.content = file.contents;
    session.lineCount = file.contents.split("\n").length;
    onChange(file.contents);
    schedule();
  };

  return (
    <section
      role="region"
      aria-label={ariaLabel}
      className={cn("h-full min-h-0 overflow-hidden", className)}
      data-workspace-pierre-editor="true"
    >
      <EditProvider createEditor={createWorkspaceEditor}>
        <CodeView
          ref={codeViewRef}
          containerRef={containerRef}
          initialItems={EMPTY_ITEMS}
          options={options}
          editorOptions={{
            onAttach: (editor) => {
              const session = sessionRef.current;
              if (!session || codeViewRef.current?.getEditor(session.sourceIdentity) !== editor)
                return;
              session.editor = editor;
              const restore = restoreRef.current;
              restoreRef.current = null;
              if (restore) {
                // setSelections clamps retained positions after an external content replacement.
                editor.setSelections(
                  (restore.state.selections ?? []).map((selection) => ({
                    ...selection,
                    direction:
                      selection.direction < 0
                        ? "backward"
                        : selection.direction > 0
                          ? "forward"
                          : "none",
                  })),
                );
                if (restore.state.view)
                  editor.setViewState({ ...editor.getViewState(), view: restore.state.view });
                codeViewRef.current?.scrollTo({
                  type: "position",
                  position: restore.scrollTop,
                  behavior: "instant",
                });
                if (restore.focused) editor.focus({ preventScroll: true });
              }
              setAttachment(session);
              schedule();
            },
            clipboard: {
              readText: async () => {
                if (typeof navigator.clipboard?.readText !== "function") return "";
                return await navigator.clipboard.readText();
              },
            },
          }}
          disableWorkerPool
          onItemEditChange={snapshotContent === null ? handleEditChange : undefined}
          onSelectedLinesChange={(selection) => {
            const session = sessionRef.current;
            if (session?.snapshotContent == null || !selection) return;
            session.caretLineIndex = Math.max(0, selection.range.end - 1);
            schedule();
          }}
          onScroll={schedule}
          className={cn(NODEX_SOURCE_HOST_CLASS, "h-full min-h-0 overflow-auto")}
          style={style}
        />
      </EditProvider>
    </section>
  );
}
