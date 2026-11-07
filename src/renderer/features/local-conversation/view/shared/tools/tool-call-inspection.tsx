import { useId, useRef, useState, type ReactNode } from "react";
import { CodeIcon } from "@/components/shared/icons";
import {
  NodexDialog as Dialog,
  NodexDialogBody as DialogBody,
  NodexDialogContent as DialogContent,
  NodexDialogFrame as DialogFrame,
  NodexDialogHeader as DialogHeader,
  NodexDialogTitle as DialogTitle,
} from "../../../../../components/ui/dialog";
import { cn } from "../../../../../lib/utils";
import { CopyMessageActionButton } from "../thread-message-actions";
import { LazySourceViewer, preloadSourceViewer } from "@/components/ui/lazy-source-viewer";
import {
  buildTextPreview,
  INLINE_TEXT_PREVIEW_MAX_CHARS,
  type TextPreview,
} from "@/lib/text-preview";

export function stringifyToolCallValue(value: unknown): string {
  try {
    return (
      JSON.stringify(
        value,
        (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
        2,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

export function ToolCallCodePanel({
  title,
  preview,
  actions,
  getCopyText,
  getFullText,
  bodyClassName,
  preClassName,
  stickyHeaderClassName,
  previewCharacterLimit = INLINE_TEXT_PREVIEW_MAX_CHARS,
}: {
  title: string;
  preview: TextPreview;
  /** Inspection controls shown before Copy in the panel toolbar. */
  actions?: ReactNode;
  getCopyText?: () => string;
  getFullText?: () => string;
  bodyClassName?: string;
  preClassName?: string;
  stickyHeaderClassName?: string;
  /** Null preserves a payload whose producing protocol already bounds its size. */
  previewCharacterLimit?: number | null;
}) {
  const [fullTextOpen, setFullTextOpen] = useState(false);
  const boundedPreview =
    previewCharacterLimit === null || preview.text.length <= previewCharacterLimit
      ? preview
      : buildTextPreview(preview.text, previewCharacterLimit);
  return (
    <div
      className="bg-token-text-code-block-background border-token-border-heavy relative overflow-clip rounded-lg border contain-inline-size dark"
      data-theme="dark"
    >
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center justify-between py-1 ps-2 pe-2 font-sans text-sm text-token-description-foreground select-none",
          stickyHeaderClassName,
        )}
      >
        <div className="min-w-0 truncate">{title}</div>
        <div className="flex items-center">
          {actions}
          {boundedPreview.kind === "omitted" && getFullText ? (
            <ToolCallFullTextDialog
              open={fullTextOpen}
              onOpenChange={setFullTextOpen}
              title={`Full ${title}`}
              getText={getFullText}
              triggerLabel={`View full ${title}`}
            />
          ) : null}
          {getCopyText ? (
            <CopyMessageActionButton
              getText={getCopyText}
              label="Copy"
              copiedLabel="Copied"
              tooltipLabel="Copy"
              copiedTooltipLabel="Copied"
              className="enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background"
            />
          ) : null}
        </div>
      </div>
      <div className={cn("text-size-chat max-h-48 overflow-y-auto p-2", bodyClassName)} dir="ltr">
        <pre className={cn("m-0 whitespace-pre-wrap break-words", preClassName)}>
          {boundedPreview.text}
        </pre>
      </div>
    </div>
  );
}

function ToolCallFullTextDialog({
  open,
  onOpenChange,
  title,
  getText,
  triggerLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  getText: () => string;
  triggerLabel: string;
}) {
  const dialogId = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <button
        type="button"
        className="border-token-border user-select-none no-drag cursor-interaction flex items-center justify-center gap-1 rounded-md border border-transparent px-1.5 py-1 text-xs font-medium text-token-description-foreground focus:outline-none enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background"
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        data-state={open ? "open" : "closed"}
        onClick={() => {
          onOpenChange(true);
        }}
        onPointerEnter={preloadSourceViewer}
        onFocus={preloadSourceViewer}
      >
        <CodeIcon className="icon-xxs" />
        <span>View full</span>
      </button>
      <DialogContent
        id={dialogId}
        ref={contentRef}
        tabIndex={-1}
        showCloseButton={false}
        aria-describedby={undefined}
        initialFocus={contentRef}
        size="large"
      >
        {open ? <ToolCallFullTextFrame title={title} getText={getText} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ToolCallFullTextFrame({
  title,
  getText,
}: {
  readonly title: string;
  readonly getText: () => string;
}) {
  const [text] = useState(getText);
  return (
    <DialogFrame>
      <DialogHeader className="flex-row items-center justify-between gap-3">
        <DialogTitle className="truncate">{title}</DialogTitle>
        <CopyMessageActionButton
          getText={() => text}
          label="Copy"
          copiedLabel="Copied"
          tooltipLabel="Copy"
          copiedTooltipLabel="Copied"
        />
      </DialogHeader>
      <DialogBody className="max-h-[min(65vh,40rem)] min-h-0">
        <ToolCallSourceSurface value={text} ariaLabel={title} language={null} />
      </DialogBody>
    </DialogFrame>
  );
}

/** One code surface: short values fit their content; longer ones scroll inside its cap. */
export function ToolCallSourceSurface({
  value,
  ariaLabel,
  language,
}: {
  readonly value: string;
  readonly ariaLabel: string;
  readonly language: "json" | null;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-[10px] bg-[var(--code-block-bg)] py-3 ps-1 [--codex-diffs-surface-override:transparent]">
      <LazySourceViewer
        value={value}
        ariaLabel={ariaLabel}
        language={language}
        syntaxTheme="code-block"
        wrap
        className="flex h-auto flex-col"
      />
    </div>
  );
}
