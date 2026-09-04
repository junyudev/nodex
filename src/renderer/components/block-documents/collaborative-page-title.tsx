import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentPropsWithoutRef,
  type CompositionEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import * as Y from "yjs";
import {
  portableRichTextPlainText,
  portableRichTextSemanticSource,
  readPortableRichTextFromYText,
  type PortableRichText,
} from "../../../shared/block-documents/portable-rich-text";
import { cn } from "@/lib/utils";
import { selectEditableLeafContent } from "@/lib/editable-leaf-selection";
import {
  portableRichTitleAtomLabel,
  portableRichTitleStyleClass,
} from "@/lib/portable-rich-title-presentation";
import { reconcileYTextInputValues } from "@/lib/y-text-input";
import {
  readRichTitleDomDraft,
  readRichTitleDomDraftSelection,
  readRichTitleDomSelection,
  restoreRichTitleDomSelection,
} from "@/lib/rich-title-editor-dom";
import {
  createRichTitleClipboardPayload,
  resolveRichTitleClipboardColor,
  writeRichTitleClipboardPayload,
} from "@/lib/rich-title-clipboard";
import {
  applyRichTitleTextEdit,
  mapRichTitleCompositionIndexToBase,
  nextRichTitleCodePointIndex,
  previousRichTitleCodePointIndex,
  richTitleRangeHasFormat,
  setRichTitleLink,
  toggleRichTitleFormat,
  type RichTitleFormatAttribute,
} from "@/lib/rich-title-ytext-editing";

type NativeTitleEditorProps = Omit<
  ComponentPropsWithoutRef<"div">,
  | "children"
  | "contentEditable"
  | "dangerouslySetInnerHTML"
  | "onBeforeInput"
  | "onCompositionEnd"
  | "onCompositionStart"
  | "onInput"
  | "role"
  | "title"
>;

export interface CollaborativePageTitleProps extends NativeTitleEditorProps {
  readonly title: Y.Text;
  readonly ref?: Ref<HTMLDivElement>;
  readonly placeholder?: string;
  /** Fires for every authoritative local or remote Y.Text change. */
  readonly onValueChange?: (value: string) => void;
  readonly onCompositionStart?: (event: CompositionEvent<HTMLDivElement>) => void;
  readonly onCompositionEnd?: (event: CompositionEvent<HTMLDivElement>) => void;
}

interface RelativeTitleSelection {
  readonly anchor: Y.RelativePosition;
  readonly focus: Y.RelativePosition;
}

interface AbsoluteTitleSelection {
  readonly anchor: number;
  readonly focus: number;
}

const TITLE_CLASS_NAME = cn(
  "w-full min-w-0 whitespace-pre-wrap wrap-break-word",
  "text-xl/snug-plus font-bold",
  "text-(--foreground)",
  "border-none bg-transparent px-0.5 pt-0.75",
  "focus-visible:ring-0 focus-visible:outline-none",
  "empty:before:pointer-events-none empty:before:text-(--foreground-disabled)",
  "empty:before:content-[attr(data-placeholder)]",
);

const FORMAT_BUTTON_CLASS_NAME = cn(
  "flex size-6 items-center justify-center rounded-md",
  "text-[11px] font-semibold text-token-description-foreground",
  "hover:bg-token-foreground/5 hover:text-token-text-primary",
  "aria-pressed:bg-token-foreground/10 aria-pressed:text-token-text-primary",
);

const renderRichTitleDom = (root: HTMLDivElement, value: PortableRichText): void => {
  const ownerDocument = root.ownerDocument;
  const nodes: Node[] = [];
  let offset = 0;
  value.forEach((item) => {
    const start = offset;
    offset += item.type === "text" || item.type === "link" ? item.text.length : 1;
    const element = ownerDocument.createElement(item.type === "linebreak" ? "br" : "span");
    element.dataset.richTitleSegment = "true";
    element.dataset.richTitleStart = String(start);
    element.dataset.richTitleLength = String(offset - start);
    if (item.type === "linebreak") {
      element.dataset.richTitleKind = "linebreak";
      nodes.push(element);
      return;
    }
    if (
      item.type === "threadMention" ||
      item.type === "pageMention" ||
      item.type === "dateMention"
    ) {
      element.dataset.richTitleKind = "atom";
      element.dataset.richTitleAtom = item.type;
      element.contentEditable = "false";
      element.className =
        "mx-0.5 inline-flex max-w-[18rem] rounded-md bg-token-foreground/5 px-1.5 align-baseline text-[0.72em] font-medium text-token-text-secondary";
      element.title =
        item.type === "threadMention"
          ? item.uuid
          : item.type === "pageMention"
            ? item.targetPageId
            : portableRichTitleAtomLabel(item);
      element.textContent = portableRichTitleAtomLabel(item);
      nodes.push(element);
      return;
    }
    element.dataset.richTitleKind = "text";
    element.className = cn(
      item.type === "link" && "underline decoration-current/40 underline-offset-2",
      portableRichTitleStyleClass(item.styles),
    );
    if (item.type === "link") element.dataset.richTitleLink = item.href;
    element.textContent = item.text;
    nodes.push(element);
  });
  root.replaceChildren(...nodes);
};

export function CollaborativePageTitle({
  title,
  ref: forwardedRef,
  onValueChange,
  onCompositionStart,
  onCompositionEnd,
  onCopy,
  onCut,
  onKeyDown,
  onFocus,
  onBlur,
  className,
  "aria-disabled": ariaDisabled,
  tabIndex,
  spellCheck = true,
  placeholder = "Untitled",
  "aria-label": ariaLabel = "Page title",
  ...props
}: CollaborativePageTitleProps) {
  const [richTitle, setRichTitle] = useState(() => readPortableRichTextFromYText(title));
  const richTitleSourceRef = useRef(portableRichTextSemanticSource(richTitle));
  const [localOrigin] = useState(() => ({ source: "collaborative-page-title" }));
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [renderRevision, setRenderRevision] = useState(0);
  const [selectedRange, setSelectedRange] = useState<{
    readonly start: number;
    readonly end: number;
  } | null>(null);
  const [linkEditorOpen, setLinkEditorOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const editorRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const compositionBaseRef = useRef(title.toString());
  const relativeSelectionRef = useRef<RelativeTitleSelection | null>(null);
  const absoluteSelectionRef = useRef<AbsoluteTitleSelection | null>(null);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;
  const plainTitle = portableRichTextPlainText(richTitle);
  const disabled = ariaDisabled === true || ariaDisabled === "true";

  const captureSelection = (): void => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = composingRef.current
      ? readRichTitleDomDraftSelection(editor)
      : readRichTitleDomSelection(editor);
    setSelectedRange(
      selection && selection.end > selection.start
        ? { start: selection.start, end: selection.end }
        : null,
    );
    if (!selection || selection.end === selection.start) {
      setLinkEditorOpen(false);
    }
  };

  useEffect(() => {
    const document = title.doc;
    if (!document) {
      throw new TypeError("Collaborative Page title must belong to a Y.Doc");
    }
    const undoManager = new Y.UndoManager(title, {
      trackedOrigins: new Set([localOrigin]),
    });
    undoManagerRef.current = undoManager;

    const publishRichTitle = (nextRichTitle: PortableRichText): void => {
      const nextSource = portableRichTextSemanticSource(nextRichTitle);
      if (nextSource === richTitleSourceRef.current) return;
      richTitleSourceRef.current = nextSource;
      setRichTitle(nextRichTitle);
      setRenderRevision((revision) => revision + 1);
    };
    const handleTitleChange = (): void => {
      const nextRichTitle = readPortableRichTextFromYText(title);
      onValueChangeRef.current?.(portableRichTextPlainText(nextRichTitle));
      if (composingRef.current) return;
      publishRichTitle(nextRichTitle);
    };
    const handleBeforeTransaction = (transaction: Y.Transaction): void => {
      if (transaction.origin === localOrigin) return;
      const editor = editorRef.current;
      if (!editor || editor.ownerDocument.activeElement !== editor) return;
      const selection = composingRef.current
        ? readRichTitleDomDraftSelection(editor)
        : readRichTitleDomSelection(editor);
      if (!selection) return;
      const draft = composingRef.current ? readRichTitleDomDraft(editor) : title.toString();
      const anchor = composingRef.current
        ? mapRichTitleCompositionIndexToBase(compositionBaseRef.current, draft, selection.anchor)
        : selection.anchor;
      const focus = composingRef.current
        ? mapRichTitleCompositionIndexToBase(compositionBaseRef.current, draft, selection.focus)
        : selection.focus;
      relativeSelectionRef.current = {
        anchor: Y.createRelativePositionFromTypeIndex(title, anchor),
        focus: Y.createRelativePositionFromTypeIndex(title, focus),
      };
    };
    const handleAfterTransaction = (transaction: Y.Transaction): void => {
      const relative = relativeSelectionRef.current;
      const changedParentTypes = transaction.changedParentTypes as ReadonlyMap<unknown, unknown>;
      if (!relative || !changedParentTypes.has(title)) return;
      const anchor = Y.createAbsolutePositionFromRelativePosition(relative.anchor, document);
      const focus = Y.createAbsolutePositionFromRelativePosition(relative.focus, document);
      if (!anchor || !focus || anchor.type !== title || focus.type !== title) {
        relativeSelectionRef.current = null;
        return;
      }
      if (composingRef.current) {
        relativeSelectionRef.current = {
          anchor: Y.createRelativePositionFromTypeIndex(title, anchor.index),
          focus: Y.createRelativePositionFromTypeIndex(title, focus.index),
        };
        return;
      }
      relativeSelectionRef.current = null;
      absoluteSelectionRef.current = {
        anchor: anchor.index,
        focus: focus.index,
      };
      setSelectionRevision((revision) => revision + 1);
    };

    title.observe(handleTitleChange);
    document.on("beforeTransaction", handleBeforeTransaction);
    document.on("afterTransaction", handleAfterTransaction);
    const currentRichTitle = readPortableRichTextFromYText(title);
    publishRichTitle(currentRichTitle);
    onValueChangeRef.current?.(portableRichTextPlainText(currentRichTitle));
    return () => {
      title.unobserve(handleTitleChange);
      document.off("beforeTransaction", handleBeforeTransaction);
      document.off("afterTransaction", handleAfterTransaction);
      undoManager.destroy();
      if (undoManagerRef.current === undoManager) undoManagerRef.current = null;
    };
  }, [localOrigin, title]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return;
    renderRichTitleDom(editor, richTitle);
  }, [renderRevision, richTitle]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    const selection = absoluteSelectionRef.current;
    absoluteSelectionRef.current = null;
    if (!editor || !selection || editor.ownerDocument.activeElement !== editor) return;
    restoreRichTitleDomSelection(editor, selection.anchor, selection.focus);
    captureSelection();
  }, [plainTitle, richTitle, selectionRevision]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const ownerDocument = editor.ownerDocument;
    const handleSelectionChange = (): void => {
      if (ownerDocument.activeElement === editor) captureSelection();
    };
    ownerDocument.addEventListener("selectionchange", handleSelectionChange);
    return () => ownerDocument.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  const setEditorRef = useCallback(
    (node: HTMLDivElement | null): void => {
      editorRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
        return;
      }
      if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  const applyEdit = (start: number, end: number, insertText: string): void => {
    const result = applyRichTitleTextEdit({
      title,
      start,
      end,
      insertText,
      origin: localOrigin,
    });
    if (!result.changed) return;
    absoluteSelectionRef.current = {
      anchor: result.caret,
      focus: result.caret,
    };
    setSelectionRevision((revision) => revision + 1);
  };

  const applyDomDraft = (): void => {
    const editor = editorRef.current;
    if (!editor) return;
    const draft = readRichTitleDomDraft(editor);
    const draftSelection = readRichTitleDomDraftSelection(editor);
    const hadRelativeSelection = relativeSelectionRef.current !== null;
    const reconciliation = reconcileYTextInputValues({
      baseValue: compositionBaseRef.current,
      currentValue: title.toString(),
      draftValue: draft,
    });
    if (reconciliation.edit) {
      applyRichTitleTextEdit({
        title,
        start: reconciliation.edit.index,
        end: reconciliation.edit.index + reconciliation.edit.deleteLength,
        insertText: reconciliation.edit.insertText,
        origin: localOrigin,
      });
    }
    const nextRichTitle = readPortableRichTextFromYText(title);
    richTitleSourceRef.current = portableRichTextSemanticSource(nextRichTitle);
    setRichTitle(nextRichTitle);
    if (!hadRelativeSelection) {
      absoluteSelectionRef.current = {
        anchor: draftSelection?.anchor ?? reconciliation.value.length,
        focus: draftSelection?.focus ?? reconciliation.value.length,
      };
    }
    setSelectionRevision((revision) => revision + 1);
  };

  const handleBeforeInput = useEffectEvent((event: InputEvent): void => {
    if (
      disabled ||
      event.defaultPrevented ||
      !event.cancelable ||
      composingRef.current ||
      event.isComposing
    ) {
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
      event.preventDefault();
      event.stopPropagation();
      if (event.inputType === "historyUndo") undoManagerRef.current?.undo();
      else undoManagerRef.current?.redo();
      return;
    }
    const selection = readRichTitleDomSelection(editor);
    if (!selection) return;
    const inputType = event.inputType;
    if (inputType === "insertText" || inputType === "insertReplacementText") {
      if (event.data === null) return;
      event.preventDefault();
      applyEdit(selection.start, selection.end, event.data);
      return;
    }
    if (inputType === "deleteContentBackward") {
      event.preventDefault();
      const current = title.toString();
      const start =
        selection.start === selection.end
          ? previousRichTitleCodePointIndex(current, selection.start)
          : selection.start;
      applyEdit(start, selection.end, "");
      return;
    }
    if (inputType === "deleteContentForward") {
      event.preventDefault();
      const current = title.toString();
      const end =
        selection.start === selection.end
          ? nextRichTitleCodePointIndex(current, selection.end)
          : selection.end;
      applyEdit(selection.start, end, "");
      return;
    }
    if (inputType.startsWith("delete")) {
      event.preventDefault();
      applyEdit(selection.start, selection.end, "");
    }
  });

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.addEventListener("beforeinput", handleBeforeInput);
    return () => editor.removeEventListener("beforeinput", handleBeforeInput);
  }, []);

  const toggleFormat = (attribute: RichTitleFormatAttribute): void => {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    const selection = readRichTitleDomSelection(editor);
    if (!selection || selection.end <= selection.start || !title.doc) return;
    toggleRichTitleFormat({
      title,
      start: selection.start,
      end: selection.end,
      attribute,
      origin: localOrigin,
    });
    absoluteSelectionRef.current = {
      anchor: selection.anchor,
      focus: selection.focus,
    };
    setSelectionRevision((revision) => revision + 1);
  };

  const applySelectedLink = (href: string | null): void => {
    const selection = selectedRange;
    const editor = editorRef.current;
    if (!selection || !editor) return;
    if (
      !setRichTitleLink({
        title,
        start: selection.start,
        end: selection.end,
        href,
        origin: localOrigin,
      })
    )
      return;
    setLinkEditorOpen(false);
    editor.focus();
    absoluteSelectionRef.current = {
      anchor: selection.start,
      focus: selection.end,
    };
    setSelectionRevision((revision) => revision + 1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (composingRef.current || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      const editor = editorRef.current;
      const selection = editor ? readRichTitleDomSelection(editor) : null;
      if (selection) applyEdit(selection.start, selection.end, "\n");
      return;
    }
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === "a" && !event.altKey && !event.shiftKey) {
      const editor = editorRef.current;
      if (!editor || !selectEditableLeafContent(editor)) return;
      event.preventDefault();
      return;
    }
    if (!event.altKey && (key === "z" || (key === "y" && !event.shiftKey))) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey || key === "y") undoManagerRef.current?.redo();
      else undoManagerRef.current?.undo();
      return;
    }
    const format =
      key === "b" || key === "i" || key === "u"
        ? key === "b"
          ? "bold"
          : key === "i"
            ? "italic"
            : "underline"
        : key === "e"
          ? "code"
          : null;
    if (!format) return;
    event.preventDefault();
    toggleFormat(format);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const editor = editorRef.current;
    const selection = editor ? readRichTitleDomSelection(editor) : null;
    if (!selection) return;
    event.preventDefault();
    applyEdit(selection.start, selection.end, event.clipboardData.getData("text/plain"));
  };

  const writeSelectionToClipboard = (
    event: ClipboardEvent<HTMLDivElement>,
  ): { readonly start: number; readonly end: number } | null => {
    const editor = editorRef.current;
    const selection = editor ? readRichTitleDomSelection(editor) : null;
    if (!editor || !selection || selection.end <= selection.start) return null;

    const computedStyle = editor.ownerDocument.defaultView?.getComputedStyle(editor);
    const payload = createRichTitleClipboardPayload(
      readPortableRichTextFromYText(title),
      selection,
      computedStyle
        ? (color) =>
            resolveRichTitleClipboardColor(color, (property) =>
              computedStyle.getPropertyValue(property),
            )
        : undefined,
    );
    if (!writeRichTitleClipboardPayload(event.clipboardData, payload)) return null;
    event.preventDefault();
    return selection;
  };

  const handleCopy = (event: ClipboardEvent<HTMLDivElement>): void => {
    onCopy?.(event);
    if (event.defaultPrevented) return;
    writeSelectionToClipboard(event);
  };

  const handleCut = (event: ClipboardEvent<HTMLDivElement>): void => {
    onCut?.(event);
    if (event.defaultPrevented || disabled) return;
    const selection = writeSelectionToClipboard(event);
    if (!selection) return;
    applyEdit(selection.start, selection.end, "");
  };

  const handleCompositionStart = (event: CompositionEvent<HTMLDivElement>): void => {
    composingRef.current = true;
    compositionBaseRef.current = title.toString();
    onCompositionStart?.(event);
  };

  const handleCompositionEnd = (event: CompositionEvent<HTMLDivElement>): void => {
    composingRef.current = false;
    applyDomDraft();
    onCompositionEnd?.(event);
  };

  const handleInput = (): void => {
    if (composingRef.current) return;
    compositionBaseRef.current = title.toString();
    applyDomDraft();
  };

  return (
    <div ref={wrapperRef} className="relative w-full min-w-0">
      {selectedRange && !disabled ? (
        <div
          className="absolute -top-8 right-0 z-10 flex items-center gap-0.5 rounded-lg bg-token-dropdown-background/90 p-1 shadow-lg ring-[0.5px] ring-token-border backdrop-blur-xl"
          contentEditable={false}
          role="toolbar"
          aria-label="Title formatting"
          onMouseDown={(event) => {
            if (event.target instanceof HTMLInputElement) return;
            event.preventDefault();
          }}
        >
          {linkEditorOpen ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                applySelectedLink(linkDraft.length > 0 ? linkDraft : null);
              }}
            >
              <input
                autoFocus
                value={linkDraft}
                onChange={(event) => setLinkDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setLinkEditorOpen(false);
                  const editor = editorRef.current;
                  if (!editor || !selectedRange) return;
                  editor.focus();
                  absoluteSelectionRef.current = {
                    anchor: selectedRange.start,
                    focus: selectedRange.end,
                  };
                  setSelectionRevision((revision) => revision + 1);
                }}
                className="h-6 w-44 rounded-md bg-token-foreground/5 px-1.5 text-xs text-token-text-primary outline-none placeholder:text-token-description-foreground"
                placeholder="Paste a link; empty removes"
                aria-label="Title link URL"
              />
            </form>
          ) : (
            <>
              {(
                [
                  ["bold", "B"],
                  ["italic", "I"],
                  ["underline", "U"],
                  ["code", "<>"],
                ] as const
              ).map(([attribute, label]) => (
                <button
                  key={attribute}
                  type="button"
                  className={FORMAT_BUTTON_CLASS_NAME}
                  aria-label={`Toggle ${attribute}`}
                  aria-pressed={richTitleRangeHasFormat(
                    title,
                    selectedRange.start,
                    selectedRange.end,
                    attribute,
                  )}
                  onClick={() => toggleFormat(attribute)}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                className={FORMAT_BUTTON_CLASS_NAME}
                aria-label="Edit title link"
                onClick={() => {
                  setLinkDraft("");
                  setLinkEditorOpen(true);
                }}
              >
                ↗
              </button>
            </>
          )}
        </div>
      ) : null}
      <div
        {...props}
        ref={setEditorRef}
        role="textbox"
        data-editor-select-all-scope="leaf"
        aria-label={ariaLabel}
        aria-multiline="true"
        aria-disabled={disabled}
        data-placeholder={placeholder}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck={spellCheck}
        tabIndex={disabled ? -1 : tabIndex}
        className={cn(TITLE_CLASS_NAME, className)}
        onCopy={handleCopy}
        onCut={handleCut}
        onInput={handleInput}
        onPaste={handlePaste}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onKeyDown={handleKeyDown}
        onFocus={(event) => {
          captureSelection();
          onFocus?.(event);
        }}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && wrapperRef.current?.contains(nextTarget)) {
            return;
          }
          setSelectedRange(null);
          setLinkEditorOpen(false);
          onBlur?.(event);
        }}
      />
    </div>
  );
}
