import { createContext, useContext, type ReactNode } from "react";
import { Link2 } from "@/components/shared/icons/generic-icons";
import { NodexLogoMarkIcon } from "@/components/shared/icons";
import {
  InlineMarkdownCode,
  INLINE_MARKDOWN_HEADING_CLASS_NAME,
  MARKDOWN_CONTENT_CLASS_NAME,
} from "@/components/shared/inline-markdown-code";
import {
  groupOrderedListItems,
  resolveOrderedListMargin,
  resolveOrderedListPadding,
} from "@/lib/ordered-list-groups";
import { buildPageDeepLink } from "../../../shared/nodex-deeplink";
import type { MarkdownBlock, MarkdownInline } from "../../../shared/nodex-markdown";
import type { RichTextColor } from "../../../shared/rich-text/colors";
import { normalizeDateMention } from "../../../shared/rich-text/date-mention";
import { FileLinkAnchor } from "../shared/file-link-anchor";
import { readMarkdown } from "../../../shared/nodex-markdown";
import { ImageViewerButton, InlineImage, inlineImageProps } from "./inline-image";
import { useMarkdownImage, type MarkdownImage } from "./markdown-image";
import {
  ImageErrorTile,
  ImageLoadingTile,
} from "@/features/local-conversation/view/shared/user-message-attachments";
import { formatThreadMentionShortUuid } from "@/lib/editor-model/thread-mention-display";
import { formatDateMentionPlainText } from "../../../shared/rich-text/date-mention";
import { cn } from "@/lib/utils";
import { NodexTooltip } from "@/components/ui/tooltip";
import { DateMentionInlineVisual } from "./date-mention-inline-visual";
import { ThreadMentionInlineVisual } from "./thread-mention-inline-visual";
import { PageMentionInlineVisual } from "./page-mention-inline-visual";
import { InlineReferenceVisual } from "./inline-reference-visual";
import { AttachmentResourceIcon } from "./attachment-resource-icon";
import { CodeBlockReadOnlyHeader } from "@/components/shared/code-block-readonly-header";
import { ReadonlyCodeBlock } from "@/components/shared/readonly-code-block";
import { MermaidCodePreview } from "@/components/board/editor/mermaid-code-preview";
import { useTheme } from "@/lib/use-theme";
import { resolveCodeLanguage } from "../../../shared/code-languages/code-language-catalog";
import { latexToHTMLString } from "@blocknote/math-block";
import { resolveAgentConfigChip } from "./editor/agent-config-chip";

interface NfmRendererProps {
  content: string;
  className?: string;
  projectWorkspacePath?: string | null;
}

/** Read-only renderer for Nodex Markdown. */
export function NfmRenderer({ content, className, projectWorkspacePath }: NfmRendererProps) {
  if (!content.trim()) return null;
  return (
    <NfmDocument
      blocks={readMarkdown(content)}
      className={className}
      projectWorkspacePath={projectWorkspacePath}
    />
  );
}

/**
 * How Blocks are spaced: as a Page lays them out, or as a message does, where lines of one
 * paragraph sit together, paragraphs are a short step apart and headings take the size the
 * surrounding chat typography gives them.
 */
export type NfmDensity = "page" | "message";

const NfmDensityContext = createContext<NfmDensity>("page");

/**
 * Read-only rendering of parsed Nodex Markdown Blocks. Library File images resolve through the
 * enclosing File runtime. `lead` opens the first line: the words follow it on that line, and the
 * lines after it take the full width.
 */
export function NfmDocument({
  blocks,
  className,
  projectWorkspacePath,
  density = "page",
  lead,
}: {
  readonly blocks: readonly MarkdownBlock[];
  readonly className?: string;
  readonly projectWorkspacePath?: string | null;
  readonly density?: NfmDensity;
  readonly lead?: ReactNode;
}) {
  return (
    <NfmDensityContext.Provider value={density}>
      <div className={cn("nfm-render", MARKDOWN_CONTENT_CLASS_NAME, className)}>
        <BlockList blocks={blocks} projectWorkspacePath={projectWorkspacePath} lead={lead} />
      </div>
    </NfmDensityContext.Provider>
  );
}

/** Blocks whose first line is their own text, which a lead can open in place. */
const opensWithText = (block: MarkdownBlock | undefined) =>
  block?.type === "paragraph" || (block?.type === "heading" && !block.props?.isToggleable);

/**
 * A document's lead, one line tall so it sits level with the words beside it. Within a line it
 * counts toward the text's width, so it never pushes a line that fits onto the next one.
 */
function NfmLead({ children, float = false }: { children: ReactNode; float?: boolean }) {
  return (
    <span
      className={cn("mr-1 h-lh items-center", float ? "float-left flex" : "inline-flex align-top")}
    >
      {children}
    </span>
  );
}

const HEADING_SIZES: Record<NfmDensity, Record<1 | 2 | 3 | 4, string>> = {
  page: {
    1: "text-[1.875em] font-bold mt-6 mb-2",
    2: "text-[1.5em] font-semibold mt-5 mb-2",
    3: "text-[1.25em] font-semibold mt-4 mb-1",
    4: "text-[1.1em] font-semibold mt-3 mb-1",
  },
  message: {
    1: "mt-[0.75em] mb-[0.25em] first:mt-0",
    2: "mt-[0.75em] mb-[0.25em] first:mt-0",
    3: "mt-[0.5em] mb-[0.25em] first:mt-0",
    4: "mt-[0.5em] mb-[0.25em] first:mt-0",
  },
};

const PARAGRAPH_SPACING: Record<NfmDensity, string> = {
  page: "my-1",
  message: "[&:not(:first-child)]:mt-[0.5em]",
};

/** Chat typography for a message's quotes, lists and tables; Pages keep their own. */
const MESSAGE_STYLES = {
  quote: "my-[0.5em] first:mt-0 border-s-2 border-gray-300 ps-4 italic",
  list: "pl-5",
  numberedItem: "mb-0.5",
  // Text keeps the spaces it was written with, so an indented line reads indented.
  text: "whitespace-pre-wrap",
  // Children of a list item sit under its text; those of other Blocks step in.
  children: { listItem: "mt-0.5", checkItem: "mt-0.5 pl-6", block: "mt-0.5 pl-5" },
  table: "my-[0.5em] first:mt-0",
  cell: "border-b border-token-border px-2 py-1.5 text-left align-top",
  header: "font-semibold",
} as const;

function BlockList({
  blocks,
  projectWorkspacePath,
  lead,
}: {
  blocks: readonly MarkdownBlock[];
  projectWorkspacePath?: string | null;
  lead?: ReactNode;
}) {
  const children: ReactNode[] = [];
  const leadsInline = lead != null && opensWithText(blocks[0]);
  // A list, quote or code block keeps its own first line; the lead floats beside it instead.
  if (lead != null && !leadsInline) {
    children.push(
      <NfmLead key="lead" float>
        {lead}
      </NfmLead>,
    );
  }

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];

    if (block.type !== "numberedListItem") {
      children.push(
        <BlockComponent
          key={index}
          block={block}
          projectWorkspacePath={projectWorkspacePath}
          lead={leadsInline && index === 0 ? lead : undefined}
        />,
      );
      continue;
    }

    const orderedBlocks: MarkdownBlock[] = [block];
    while (index + 1 < blocks.length && blocks[index + 1]?.type === "numberedListItem") {
      orderedBlocks.push(blocks[index + 1] as MarkdownBlock);
      index += 1;
    }

    const starts = orderedBlocks.map(
      (_, index) => Number(orderedBlocks[0]?.props?.start ?? 1) + index,
    );
    const groups = groupOrderedListItems(
      orderedBlocks,
      (_orderedBlock, orderedIndex) => starts[orderedIndex] ?? 1,
    );

    groups.forEach((group, groupIndex) => {
      children.push(
        <ol
          key={`${index}-${group.start}-${groupIndex}`}
          start={group.start}
          className={cn(
            "list-decimal",
            resolveOrderedListMargin(groupIndex, groups.length),
            resolveOrderedListPadding(group.digits),
          )}
        >
          {group.items.map((orderedBlock, orderedItemIndex) => (
            <NumberedListItemContent
              key={`${group.start}-${orderedItemIndex}`}
              block={orderedBlock}
              projectWorkspacePath={projectWorkspacePath}
            />
          ))}
        </ol>,
      );
    });
  }

  return <>{children}</>;
}

function BlockComponent({
  block,
  projectWorkspacePath,
  lead,
}: {
  block: MarkdownBlock;
  projectWorkspacePath?: string | null;
  /** Opens this Block's text; only a Block that `opensWithText` receives one. */
  lead?: ReactNode;
}) {
  const colorClass = blockColorClass(block);
  const density = useContext(NfmDensityContext);
  const leading = lead == null ? null : <NfmLead>{lead}</NfmLead>;

  switch (block.type) {
    case "paragraph":
      return (
        <div className={cn(PARAGRAPH_SPACING[density], "leading-relaxed", colorClass)}>
          <p className="whitespace-pre-wrap">
            {leading}
            <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
          </p>
          <ChildBlocks
            children={block.children ?? []}
            projectWorkspacePath={projectWorkspacePath}
          />
        </div>
      );

    case "heading": {
      const level = Math.min(4, Math.max(1, Number(block.props?.level ?? 1))) as 1 | 2 | 3 | 4;
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      const sizes = HEADING_SIZES[density];

      if (block.props?.isToggleable) {
        return (
          <details className={cn("nfm-toggle my-1", colorClass)} open={undefined}>
            <summary
              className={cn("nfm-toggle-summary", sizes[level], INLINE_MARKDOWN_HEADING_CLASS_NAME)}
            >
              <ToggleCaretIcon hasChildren={(block.children ?? []).length > 0} />
              <span className="min-w-0">
                <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
              </span>
            </summary>
            {(block.children ?? []).length > 0 && (
              <div className="mt-1 pl-4">
                <BlockList
                  blocks={block.children ?? []}
                  projectWorkspacePath={projectWorkspacePath}
                />
              </div>
            )}
          </details>
        );
      }

      return (
        <Tag className={cn(sizes[level], colorClass, INLINE_MARKDOWN_HEADING_CLASS_NAME)}>
          {leading}
          <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
        </Tag>
      );
    }

    case "bulletListItem":
      return (
        <ul
          className={cn("my-0.5 list-disc", density === "message" ? MESSAGE_STYLES.list : "pl-6")}
        >
          <li className={cn(density === "message" && MESSAGE_STYLES.text, colorClass)}>
            <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
            <ChildBlocks
              children={block.children ?? []}
              projectWorkspacePath={projectWorkspacePath}
              parent="listItem"
            />
          </li>
        </ul>
      );

    case "checkListItem":
      return (
        <div className={cn("my-0.5", colorClass)}>
          <div className="flex items-start gap-2">
            <span
              aria-checked={block.props?.checked === true}
              role="checkbox"
              className={cn(
                "mt-0.75 inline-block h-4 w-4 min-w-4 shrink-0 rounded-sm border-[calc(var(--spacing)*0.375)]",
                block.props?.checked === true
                  ? "border-transparent bg-primary-solid text-primary-solid"
                  : "border-(--foreground-tertiary) bg-transparent",
              )}
              style={block.props?.checked === true ? { position: "relative" } : undefined}
            >
              {block.props?.checked === true && (
                <svg viewBox="0 0 14 14" fill="none" className="h-full w-full">
                  <path
                    d="M3 7.5L5.5 10L11 4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </span>
            <span
              className={cn(
                block.props?.checked === true && "line-through opacity-60",
                density === "message" && MESSAGE_STYLES.text,
              )}
            >
              <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
            </span>
          </div>
          <ChildBlocks
            children={block.children ?? []}
            projectWorkspacePath={projectWorkspacePath}
            parent="checkItem"
          />
        </div>
      );

    case "toggleListItem":
      return (
        <details className={cn("nfm-toggle my-1", colorClass)} open={undefined}>
          <summary className="nfm-toggle-summary">
            <ToggleCaretIcon hasChildren={(block.children ?? []).length > 0} />
            <span className="min-w-0">
              <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
            </span>
          </summary>
          {(block.children ?? []).length > 0 && (
            <div className="mt-1 pl-4">
              <BlockList
                blocks={block.children ?? []}
                projectWorkspacePath={projectWorkspacePath}
              />
            </div>
          )}
        </details>
      );

    case "quote":
      return (
        <blockquote
          className={cn(
            density === "message"
              ? [MESSAGE_STYLES.quote, MESSAGE_STYLES.text]
              : "m-2 border-s-[3px] border-current px-[22px] text-[1em] leading-[1.5]",
            colorClass,
          )}
        >
          <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
          <ChildBlocks
            children={block.children ?? []}
            projectWorkspacePath={projectWorkspacePath}
          />
        </blockquote>
      );

    case "codeBlock":
      return (
        <HighlightedCodeBlock
          code={blockText(block)}
          language={String(block.props?.language ?? "text")}
          className={colorClass}
        />
      );

    case "mathBlock":
      return <MathSourcePreview source={blockText(block)} displayMode />;

    case "table":
      return (
        <NfmTableBlock
          table={block}
          projectWorkspacePath={projectWorkspacePath}
          className={colorClass}
        />
      );

    case "callout":
      return (
        <div
          className={cn(
            "nfm-callout my-2 flex gap-2 rounded-sm bg-(--background-tertiary) p-4",
            colorClass,
          )}
        >
          {String(block.props?.icon ?? "💡") && (
            <span className="text-[1.2em] select-none">{String(block.props?.icon ?? "💡")}</span>
          )}
          <div className="min-w-0 flex-1">
            <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
            <ChildBlocks
              children={block.children ?? []}
              projectWorkspacePath={projectWorkspacePath}
            />
          </div>
        </div>
      );

    case "image":
      return <ImageFigure block={block} className={colorClass} />;

    case "pageRef": {
      const mentionUrl = buildPageDeepLink({
        pageId: String(block.props?.targetBlockId ?? ""),
      });
      return (
        <NodexTooltip tooltipContent={`Page mention (${mentionUrl})`}>
          <div className="my-2.5 inline-flex items-center gap-2 rounded-lg border border-dashed border-(--border) bg-[color-mix(in_srgb,var(--background-secondary)_65%,transparent)] px-2.5 py-2 text-xs leading-none text-(--foreground-secondary)">
            <span aria-hidden="true">↗</span>
            <span className="whitespace-nowrap">Page Mention · {mentionUrl}</span>
          </div>
        </NodexTooltip>
      );
    }

    case "page":
      return (
        <div className="my-2.5 inline-flex items-center gap-2 rounded-lg border border-(--border) bg-[color-mix(in_srgb,var(--background-secondary)_65%,transparent)] px-2.5 py-2 text-xs leading-none text-(--foreground-secondary)">
          <span aria-hidden="true">▣</span>
          <span className="whitespace-nowrap">Page · {block.id}</span>
        </div>
      );

    case "database":
      return <ResourceBlock label="Database" detail={block.id ?? ""} />;

    case "canvas":
      return <ResourceBlock label="Canvas" detail={block.id ?? ""} />;

    case "databaseViewRef":
      return (
        <ResourceBlock
          label="Database view"
          detail={String(block.props?.displayHint || block.props?.databaseViewId || "")}
        />
      );

    case "syncedBlockRef":
      return (
        <ResourceBlock label="Synced block" detail={String(block.props?.sourceBlockId ?? "")} />
      );

    case "templateRef":
      return (
        <ResourceBlock
          label="Template"
          detail={String(block.props?.displayHint || block.props?.sourceBlockId || "")}
        />
      );

    case "divider":
      return <hr className="my-4 border-t border-(--border)" />;

    case "emptyBlock":
      return <div className="h-[1em]" />;
  }
}

function ImageFigure({ block, className }: { block: MarkdownBlock; className?: string }) {
  const density = useContext(NfmDensityContext);
  const image = useMarkdownImage(String(block.props?.url ?? ""));
  const alt = markdownImageAlt(block);
  const widthStyle =
    numberProp(block, "previewWidth") !== undefined
      ? { width: `${numberProp(block, "previewWidth")}px`, maxWidth: "100%" }
      : undefined;

  return (
    <figure className={cn(density === "message" ? "my-[0.5em] first:mt-0" : "my-3", className)}>
      {density === "message" ? (
        <MessageFigureImage image={image} alt={alt} />
      ) : image.url ? (
        <img
          src={image.url}
          alt={alt}
          className="max-w-full rounded-md border border-(--border)"
          style={widthStyle}
          width={numberProp(block, "sourceWidth")}
          height={numberProp(block, "sourceHeight")}
          loading="lazy"
          onError={image.onError}
        />
      ) : null}
      {Boolean(block.props?.caption) && (
        <figcaption className="mt-1 text-sm text-(--foreground-secondary)">
          {String(block.props?.caption ?? "")}
        </figcaption>
      )}
    </figure>
  );
}

/**
 * An image between a message's paragraphs, shown at most as tall as an Agent's reply shows one,
 * that opens full size. One that cannot be read says so, as an attached image does.
 */
function MessageFigureImage({ image, alt }: { image: MarkdownImage; alt: string }) {
  if (image.failed) return <ImageErrorTile />;
  if (!image.url) return <ImageLoadingTile label="Loading image" />;
  return (
    <ImageViewerButton src={image.url} label={alt} className="flex max-w-full rounded-md">
      <img
        src={image.url}
        alt={alt}
        draggable={false}
        onError={image.onError}
        className="h-auto max-h-50 w-auto max-w-full rounded-md border border-token-border object-contain"
      />
    </ImageViewerButton>
  );
}

export const markdownImageAlt = (block: MarkdownBlock): string =>
  String(block.props?.caption || block.props?.name || "Image");

function ResourceBlock({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="my-2.5 inline-flex items-center gap-2 rounded-lg border border-(--border) bg-[color-mix(in_srgb,var(--background-secondary)_65%,transparent)] px-2.5 py-2 text-xs leading-none text-(--foreground-secondary)">
      <span aria-hidden="true">▣</span>
      <span className="whitespace-nowrap">
        {label} · {detail}
      </span>
    </div>
  );
}

function NumberedListItemContent({
  block,
  projectWorkspacePath,
}: {
  block: MarkdownBlock;
  projectWorkspacePath?: string | null;
}) {
  const colorClass = blockColorClass(block);
  const density = useContext(NfmDensityContext);

  return (
    <li
      className={cn(
        density === "message" ? [MESSAGE_STYLES.numberedItem, MESSAGE_STYLES.text] : "mb-1.5",
        colorClass,
      )}
    >
      <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
      <ChildBlocks
        children={block.children ?? []}
        projectWorkspacePath={projectWorkspacePath}
        parent="listItem"
      />
    </li>
  );
}

function NfmTableBlock({
  table,
  projectWorkspacePath,
  className,
}: {
  table: MarkdownBlock;
  projectWorkspacePath?: string | null;
  className?: string;
}) {
  const content = table.content as {
    headerRows?: number;
    headerCols?: number;
    columnWidths?: (number | null)[];
    rows: { cells: { props?: Record<string, unknown>; content?: unknown }[] }[];
  };
  return (
    <div className={cn("my-3 max-w-full overflow-x-auto", className)}>
      <table className="border-collapse text-sm leading-5">
        <tbody>
          {content.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.cells.map((cell, columnIndex) => {
                const Tag =
                  rowIndex < (content.headerRows ?? 0) || columnIndex < (content.headerCols ?? 0)
                    ? "th"
                    : "td";
                return (
                  <Tag
                    key={columnIndex}
                    className={cn(
                      "border border-token-border px-2 py-1.5 text-left align-top",
                      cell.props?.backgroundColor
                        ? nfmColorClass(`${cell.props.backgroundColor}_bg` as RichTextColor)
                        : undefined,
                    )}
                    style={{
                      width: content.columnWidths?.[columnIndex] ?? undefined,
                      textAlign: cell.props?.textAlignment as
                        | "left"
                        | "center"
                        | "right"
                        | undefined,
                    }}
                  >
                    <InlineList items={cell.content} projectWorkspacePath={projectWorkspacePath} />
                  </Tag>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HighlightedCodeBlock({
  code,
  language,
  className,
}: {
  code: string;
  language: string;
  className?: string;
}) {
  // In a message the language and copy controls wait for the pointer, like the code itself.
  const message = useContext(NfmDensityContext) === "message";
  const languageId = resolveCodeLanguage(language).id;
  if (languageId === "mermaid") {
    return <ReadonlyMermaidCodeBlock code={code} className={className} />;
  }
  return (
    <ReadonlyCodeBlock
      code={code}
      language={languageId}
      revealActions={message ? "hover" : "always"}
      className={cn("my-2", className)}
    />
  );
}

function ReadonlyMermaidCodeBlock({ code, className }: { code: string; className?: string }) {
  const { resolved: theme } = useTheme();

  return (
    <figure
      className={cn(
        "relative my-2 overflow-hidden rounded-[10px] bg-[var(--code-block-bg)] pt-6 text-sm",
        className,
      )}
    >
      <div className="absolute top-1 right-1 z-[3]">
        <CodeBlockReadOnlyHeader language="mermaid" code={code} />
      </div>
      <MermaidCodePreview source={code} theme={theme} />
    </figure>
  );
}

function ChildBlocks({
  children,
  projectWorkspacePath,
  parent = "block",
}: {
  children: readonly MarkdownBlock[];
  projectWorkspacePath?: string | null;
  parent?: keyof (typeof MESSAGE_STYLES)["children"];
}) {
  const density = useContext(NfmDensityContext);
  if (!children || children.length === 0) return null;
  return (
    <div className={density === "message" ? MESSAGE_STYLES.children[parent] : "mt-1 pl-4"}>
      <BlockList blocks={children} projectWorkspacePath={projectWorkspacePath} />
    </div>
  );
}

function InlineList({
  items,
  projectWorkspacePath,
}: {
  items: unknown;
  projectWorkspacePath?: string | null;
}) {
  return (
    <>
      {(Array.isArray(items) ? (items as MarkdownInline[]) : []).map((item, i) => (
        <InlineItem key={i} item={item} projectWorkspacePath={projectWorkspacePath} />
      ))}
    </>
  );
}

function InlineItem({
  item,
  projectWorkspacePath,
}: {
  item: MarkdownInline;
  projectWorkspacePath?: string | null;
}) {
  const props = item.props ?? {};
  if (item.type === "link")
    return (
      <FileLinkAnchor
        href={item.href ?? ""}
        projectWorkspacePath={projectWorkspacePath}
        className="nfm-render-link"
      >
        <InlineList items={item.content} projectWorkspacePath={projectWorkspacePath} />
      </FileLinkAnchor>
    );
  if (item.type === "inlineImage")
    return <InlineImage {...inlineImageProps(props)} projectWorkspacePath={projectWorkspacePath} />;
  if (item.type === "attachment") {
    const name = String(props.name ?? "");
    const kind = props.kind === "file" || props.kind === "folder" ? props.kind : "text";
    return (
      <NodexTooltip tooltipContent={String(props.origin || props.source || "")}>
        <InlineReferenceVisual
          className="max-w-[18rem]"
          label={name || "Attachment"}
          icon={
            <AttachmentResourceIcon
              kind={kind}
              name={name}
              mimeType={typeof props.mimeType === "string" ? props.mimeType : undefined}
              className="size-full"
            />
          }
          trailing={props.mode === "link" ? <Link2 className="size-full" /> : undefined}
          data-attachment-inline-chip="true"
        />
      </NodexTooltip>
    );
  }
  if (item.type === "agentConfig") {
    const chip = resolveAgentConfigChip(props);
    return (
      <span className="inline-flex max-w-[18rem] items-center gap-1 rounded-full border border-token-border/55 px-2 py-0.5 align-middle text-[12px] leading-5">
        <NodexLogoMarkIcon monochrome className="size-3 shrink-0" />
        <span className="truncate">{chip.label}</span>
        {chip.summary ? <span className="truncate opacity-70">{chip.summary}</span> : null}
      </span>
    );
  }
  if (item.type === "threadMention")
    return (
      <ThreadMentionInlineVisual
        className="max-w-[18rem] align-baseline"
        title={String(props.uuid ?? "")}
        label={formatThreadMentionShortUuid(String(props.uuid ?? ""))}
      />
    );
  if (item.type === "pageMention")
    return (
      <PageMentionInlineVisual
        className="max-w-[18rem] align-baseline"
        title={buildPageDeepLink({ pageId: String(props.targetPageId ?? "") })}
        label={String(props.targetPageId ?? "")}
      />
    );
  if (item.type === "dateMention") {
    const payload = normalizeDateMention({ ...props, type: "dateMention" });
    return payload ? (
      <DateMentionInlineVisual
        payload={payload}
        className="max-w-[18rem]"
        title={formatDateMentionPlainText(payload)}
      />
    ) : null;
  }
  if (item.type === "math")
    return <MathSourcePreview source={typeof item.content === "string" ? item.content : ""} />;
  const classes = styleClasses(item.styles ?? {}, { includeCode: false });
  const text = (item.text ?? "").split("\n").map((line, index) => (
    <span key={index}>
      {index > 0 ? <br /> : null}
      {line}
    </span>
  ));
  if (item.styles?.code) return <InlineMarkdownCode className={classes}>{text}</InlineMarkdownCode>;
  return classes ? <span className={classes}>{text}</span> : <>{text}</>;
}

function MathSourcePreview({
  source,
  displayMode = false,
}: {
  source: string;
  displayMode?: boolean;
}) {
  const { htmlString, error } = latexToHTMLString(source, !displayMode);
  const Tag = displayMode ? "div" : "span";

  return (
    <Tag
      className={cn(
        displayMode && "my-3 overflow-x-auto py-2 text-center",
        error && "font-mono text-[0.92em] text-token-description-foreground",
      )}
      title={error}
      dangerouslySetInnerHTML={{ __html: htmlString }}
    />
  );
}

function styleClasses(
  styles: NonNullable<MarkdownInline["styles"]>,
  options?: { includeCode?: boolean },
): string | undefined {
  const parts: string[] = [];
  if (styles.bold) parts.push("font-semibold");
  if (styles.italic) parts.push("italic");
  if (styles.strike) parts.push("line-through");
  if (styles.underline) parts.push("underline");
  if (styles.code && options?.includeCode !== false) parts.push("font-mono");
  if (typeof styles.textColor === "string")
    parts.push(nfmColorClass(styles.textColor as RichTextColor));
  if (typeof styles.backgroundColor === "string")
    parts.push(nfmColorClass(`${styles.backgroundColor}_bg` as RichTextColor));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function nfmColorClass(color: RichTextColor): string {
  // Map NFM colors to CSS variable-based classes
  const colorMap: Record<string, string> = {
    gray: "text-[var(--gray-text)]",
    brown: "text-[var(--brown-text,#64473a)]",
    orange: "text-[var(--orange-text,#d9730d)]",
    yellow: "text-[var(--yellow-text,#cb8a00)]",
    green: "text-[var(--green-text,#448361)]",
    blue: "text-[var(--blue-text)]",
    purple: "text-[var(--purple-text,#9065b0)]",
    pink: "text-[var(--pink-text,#ad1a72)]",
    red: "text-[var(--red-text,#e03e3e)]",
    gray_bg: "bg-[var(--gray-bg)] text-[var(--gray-text)]",
    brown_bg: "bg-[var(--brown-bg,#e9e5e3)] text-[var(--brown-text,#64473a)]",
    orange_bg: "bg-[var(--orange-bg,#faebdd)] text-[var(--orange-text,#d9730d)]",
    yellow_bg: "bg-[var(--yellow-bg,#fbf3db)] text-[var(--yellow-text,#cb8a00)]",
    green_bg: "bg-[var(--green-bg,#ddedea)] text-[var(--green-text,#448361)]",
    blue_bg: "bg-[var(--blue-bg)] text-[var(--blue-text)]",
    purple_bg: "bg-[var(--purple-bg,#e8deee)] text-[var(--purple-text,#9065b0)]",
    pink_bg: "bg-[var(--pink-bg,#f4dfeb)] text-[var(--pink-text,#ad1a72)]",
    red_bg: "bg-[var(--red-bg,#fbe4e4)] text-[var(--red-text,#e03e3e)]",
  };
  return colorMap[color] || "";
}

function ToggleCaretIcon({ hasChildren }: { hasChildren: boolean }) {
  return (
    <svg
      aria-hidden="true"
      role="graphics-symbol"
      viewBox="0 0 16 16"
      className="nfm-toggle-caret"
      style={hasChildren ? undefined : { color: "#848483" }}
    >
      <path d="M2.835 3.25a.8.8 0 0 0-.69 1.203l5.164 8.854a.8.8 0 0 0 1.382 0l5.165-8.854a.8.8 0 0 0-.691-1.203z" />
    </svg>
  );
}

function blockText(block: MarkdownBlock): string {
  return Array.isArray(block.content)
    ? (block.content as MarkdownInline[]).map((item) => item.text ?? "").join("")
    : "";
}
function numberProp(block: MarkdownBlock, name: string): number | undefined {
  const value = block.props?.[name];
  return typeof value === "number" ? value : undefined;
}
function blockColorClass(block: MarkdownBlock): string {
  return cn(
    nfmColorClass(String(block.props?.textColor ?? "") as RichTextColor),
    nfmColorClass(`${block.props?.backgroundColor ?? ""}_bg` as RichTextColor),
  );
}
