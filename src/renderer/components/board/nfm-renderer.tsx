import type { ReactNode } from "react";
import { Link2 } from "@/components/shared/icons/generic-icons";
import { NodexLogoMarkIcon } from "@/components/shared/icons";
import { Streamdown } from "streamdown";
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
import { resolveOrderedListStarts } from "../../../shared/nfm/ordered-list";
import type {
  NfmBlock,
  NfmInlineContent,
  NfmColor,
  NfmNumberedListItem,
  NfmStyleSet,
  NfmTable,
} from "@/lib/nfm/types";
import { FileLinkAnchor } from "../shared/file-link-anchor";
import { parseNfm } from "@/lib/nfm/parser";
import { resolveAssetSourceToDisplayUrl } from "@/lib/assets";
import { formatThreadMentionShortUuid } from "@/lib/nfm/thread-mention-display";
import { formatDateMentionPlainText } from "@/lib/nfm/date-mention";
import { cn } from "@/lib/utils";
import { NodexTooltip } from "@/components/ui/tooltip";
import { streamdownCodePlugin } from "@/lib/streamdown";
import { DateMentionInlineVisual } from "./date-mention-inline-visual";
import { ThreadMentionInlineVisual } from "./thread-mention-inline-visual";
import { PageMentionInlineVisual } from "./page-mention-inline-visual";
import { InlineReferenceVisual } from "./inline-reference-visual";
import { AttachmentResourceIcon } from "./attachment-resource-icon";
import { CodeBlockReadOnlyHeader } from "@/components/shared/code-block-readonly-header";
import { MermaidCodePreview } from "@/components/board/editor/mermaid-code-preview";
import { useTheme } from "@/lib/use-theme";
import { resolveCodeLanguage } from "../../../shared/nfm/code-language-catalog";
import { latexToHTMLString } from "@blocknote/math-block";
import { resolveAgentConfigChip } from "./editor/agent-config-chip";

interface NfmRendererProps {
  content: string;
  className?: string;
  projectWorkspacePath?: string | null;
}

/** Read-only renderer for Notion-flavored Markdown. */
export function NfmRenderer({ content, className, projectWorkspacePath }: NfmRendererProps) {
  if (!content.trim()) return null;
  const blocks = parseNfm(content);
  return (
    <div className={cn("nfm-render", MARKDOWN_CONTENT_CLASS_NAME, className)}>
      <BlockList blocks={blocks} projectWorkspacePath={projectWorkspacePath} />
    </div>
  );
}

function BlockList({
  blocks,
  projectWorkspacePath,
}: {
  blocks: NfmBlock[];
  projectWorkspacePath?: string | null;
}) {
  const children: ReactNode[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];

    if (block.type !== "numberedListItem") {
      children.push(
        <BlockComponent key={index} block={block} projectWorkspacePath={projectWorkspacePath} />,
      );
      continue;
    }

    const orderedBlocks: NfmNumberedListItem[] = [block];
    while (index + 1 < blocks.length && blocks[index + 1]?.type === "numberedListItem") {
      orderedBlocks.push(blocks[index + 1] as NfmNumberedListItem);
      index += 1;
    }

    const starts = resolveOrderedListStarts(orderedBlocks);
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
}: {
  block: NfmBlock;
  projectWorkspacePath?: string | null;
}) {
  const colorClass = block.color ? nfmColorClass(block.color) : undefined;

  switch (block.type) {
    case "paragraph":
      return (
        <div className={cn("my-1 leading-relaxed", colorClass)}>
          <p>
            <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
          </p>
          <ChildBlocks children={block.children} projectWorkspacePath={projectWorkspacePath} />
        </div>
      );

    case "heading": {
      const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4";
      const sizes = {
        1: "text-[1.875em] font-bold mt-6 mb-2",
        2: "text-[1.5em] font-semibold mt-5 mb-2",
        3: "text-[1.25em] font-semibold mt-4 mb-1",
        4: "text-[1.1em] font-semibold mt-3 mb-1",
      };

      if (block.isToggleable) {
        return (
          <details className={cn("nfm-toggle my-1", colorClass)} open={block.isOpen || undefined}>
            <summary
              className={cn(
                "nfm-toggle-summary",
                sizes[block.level],
                INLINE_MARKDOWN_HEADING_CLASS_NAME,
              )}
            >
              <ToggleCaretIcon hasChildren={block.children.length > 0} />
              <span className="min-w-0">
                <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
              </span>
            </summary>
            {block.children.length > 0 && (
              <div className="mt-1 pl-4">
                <BlockList blocks={block.children} projectWorkspacePath={projectWorkspacePath} />
              </div>
            )}
          </details>
        );
      }

      return (
        <Tag className={cn(sizes[block.level], colorClass, INLINE_MARKDOWN_HEADING_CLASS_NAME)}>
          <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
        </Tag>
      );
    }

    case "bulletListItem":
      return (
        <ul className="my-0.5 list-disc pl-6">
          <li className={colorClass}>
            <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
            <ChildBlocks children={block.children} projectWorkspacePath={projectWorkspacePath} />
          </li>
        </ul>
      );

    case "checkListItem":
      return (
        <div className={cn("my-0.5", colorClass)}>
          <div className="flex items-start gap-2">
            <span
              aria-checked={block.checked}
              role="checkbox"
              className={cn(
                "mt-0.75 inline-block h-4 w-4 min-w-4 shrink-0 rounded-sm border-[calc(var(--spacing)*0.375)]",
                block.checked
                  ? "border-(--accent-blue) bg-(--accent-blue)"
                  : "border-(--foreground-tertiary) bg-transparent",
              )}
              style={block.checked ? { position: "relative" } : undefined}
            >
              {block.checked && (
                <svg viewBox="0 0 14 14" fill="none" className="h-full w-full text-white">
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
            <span className={block.checked ? "line-through opacity-60" : ""}>
              <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
            </span>
          </div>
          <ChildBlocks children={block.children} projectWorkspacePath={projectWorkspacePath} />
        </div>
      );

    case "toggle":
      return (
        <details className={cn("nfm-toggle my-1", colorClass)} open={block.isOpen || undefined}>
          <summary className="nfm-toggle-summary">
            <ToggleCaretIcon hasChildren={block.children.length > 0} />
            <span className="min-w-0">
              <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
            </span>
          </summary>
          {block.children.length > 0 && (
            <div className="mt-1 pl-4">
              <BlockList blocks={block.children} projectWorkspacePath={projectWorkspacePath} />
            </div>
          )}
        </details>
      );

    case "blockquote":
      return (
        <blockquote
          className={cn(
            "m-2 border-s-[3px] border-current px-[22px] text-[1em] leading-[1.5]",
            colorClass,
          )}
        >
          <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
          <ChildBlocks children={block.children} projectWorkspacePath={projectWorkspacePath} />
        </blockquote>
      );

    case "codeBlock":
      return (
        <HighlightedCodeBlock code={block.code} language={block.language} className={colorClass} />
      );

    case "mathBlock":
      return <MathSourcePreview source={block.source} displayMode />;

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
          {block.icon && <span className="text-[1.2em] select-none">{block.icon}</span>}
          <div className="min-w-0 flex-1">
            <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
            <ChildBlocks children={block.children} projectWorkspacePath={projectWorkspacePath} />
          </div>
        </div>
      );

    case "image": {
      const sourceUrl = resolveAssetSourceToDisplayUrl(block.source);
      const alt = inlineText(block.caption) || "Image";
      const widthStyle =
        block.previewWidth !== undefined
          ? { width: `${block.previewWidth}px`, maxWidth: "100%" }
          : undefined;

      return (
        <figure className={cn("my-3", colorClass)}>
          {sourceUrl ? (
            <img
              src={sourceUrl}
              alt={alt}
              className="max-w-full rounded-md border border-(--border)"
              style={widthStyle}
              width={block.sourceWidth}
              height={block.sourceHeight}
              loading="lazy"
            />
          ) : null}
          {block.caption.length > 0 && (
            <figcaption className="mt-1 text-sm text-(--foreground-secondary)">
              <InlineList items={block.caption} projectWorkspacePath={projectWorkspacePath} />
            </figcaption>
          )}
        </figure>
      );
    }

    case "pageRef": {
      const mentionUrl = buildPageDeepLink({
        pageId: block.targetBlockId,
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
          <span className="whitespace-nowrap">Page · {block.uuid}</span>
        </div>
      );

    case "database":
      return <ResourceBlock label="Database" detail={block.uuid} />;

    case "canvas":
      return <ResourceBlock label="Canvas" detail={block.uuid} />;

    case "databaseViewRef":
      return (
        <ResourceBlock label="Database view" detail={block.displayHint || block.databaseViewId} />
      );

    case "syncedBlockRef":
      return <ResourceBlock label="Synced block" detail={block.sourceBlockId} />;

    case "templateRef":
      return <ResourceBlock label="Template" detail={block.displayHint || block.sourceBlockId} />;

    case "threadSection":
      return (
        <div className="mt-5 mb-1 flex items-center gap-2 text-xs font-medium tracking-wide text-(--foreground-tertiary)">
          <span aria-hidden="true">◆</span>
          <span>{block.label || block.threadId || "Thread section"}</span>
        </div>
      );

    case "divider":
      return <hr className="my-4 border-t border-(--border)" />;

    case "emptyBlock":
      return <div className="h-[1em]" />;
  }
}

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
  block: NfmNumberedListItem;
  projectWorkspacePath?: string | null;
}) {
  const colorClass = block.color ? nfmColorClass(block.color) : undefined;

  return (
    <li className={cn("mb-1.5", colorClass)}>
      <InlineList items={block.content} projectWorkspacePath={projectWorkspacePath} />
      <ChildBlocks children={block.children} projectWorkspacePath={projectWorkspacePath} />
    </li>
  );
}

function NfmTableBlock({
  table,
  projectWorkspacePath,
  className,
}: {
  table: NfmTable;
  projectWorkspacePath?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("nfm-render-table my-3 max-w-full overflow-x-auto", className)}>
      <table className="border-collapse text-sm leading-5">
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.cells.map((cell, columnIndex) => {
                const Tag =
                  (table.headerRow && rowIndex === 0) || (table.headerColumn && columnIndex === 0)
                    ? "th"
                    : "td";
                const column = table.columns[columnIndex];
                const color = cell.color ?? row.color ?? column?.color;
                const style = {
                  width: column?.width ? `${column.width}px` : undefined,
                  textAlign: column?.align,
                };
                return (
                  <Tag
                    key={columnIndex}
                    className={cn(
                      "min-w-[120px] max-w-[240px] border border-token-border px-[9px] py-[7px] text-left align-top font-normal",
                      (table.headerRow && rowIndex === 0) ||
                        (table.headerColumn && columnIndex === 0)
                        ? "bg-token-foreground/5"
                        : "",
                      color ? nfmColorClass(color) : "",
                    )}
                    style={style}
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
  const resolvedLanguage = resolveCodeLanguage(language);
  if (resolvedLanguage.id === "mermaid") {
    return <ReadonlyMermaidCodeBlock code={code} className={className} />;
  }
  const highlightLanguage = resolvedLanguage.shikiLanguage ?? "text";
  const fencedCode = `\`\`\`${highlightLanguage}\n${code}\n\`\`\``;

  return (
    <div className={cn("nfm-code-block relative my-2 text-sm", className)}>
      <div className="absolute top-1 right-1 z-[3]">
        <CodeBlockReadOnlyHeader languageId={resolvedLanguage.id} code={code} />
      </div>
      <Streamdown plugins={{ code: streamdownCodePlugin }} controls={false} lineNumbers={false}>
        {fencedCode}
      </Streamdown>
    </div>
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
        <CodeBlockReadOnlyHeader languageId="mermaid" code={code} />
      </div>
      <MermaidCodePreview source={code} theme={theme} />
    </figure>
  );
}

function ChildBlocks({
  children,
  projectWorkspacePath,
}: {
  children: NfmBlock[];
  projectWorkspacePath?: string | null;
}) {
  if (!children || children.length === 0) return null;
  return (
    <div className="mt-1 pl-4">
      <BlockList blocks={children} projectWorkspacePath={projectWorkspacePath} />
    </div>
  );
}

function InlineList({
  items,
  projectWorkspacePath,
}: {
  items: NfmInlineContent[];
  projectWorkspacePath?: string | null;
}) {
  return (
    <>
      {items.map((item, i) => (
        <InlineItem key={i} item={item} projectWorkspacePath={projectWorkspacePath} />
      ))}
    </>
  );
}

function InlineItem({
  item,
  projectWorkspacePath,
}: {
  item: NfmInlineContent;
  projectWorkspacePath?: string | null;
}) {
  if (item.type === "linebreak") return <br />;

  if (item.type === "link") {
    return (
      <FileLinkAnchor
        href={item.href}
        projectWorkspacePath={projectWorkspacePath}
        className={cn("nfm-render-link", styleClasses(item.styles))}
      >
        {item.text}
      </FileLinkAnchor>
    );
  }

  if (item.type === "attachment") {
    const label =
      item.name.trim() || (item.kind === "text" ? "Pasted text" : "Untitled attachment");

    return (
      <NodexTooltip
        tooltipContent={item.mode === "link" ? item.source : item.origin || item.source}
      >
        <InlineReferenceVisual
          className="max-w-[18rem]"
          label={label}
          icon={
            <AttachmentResourceIcon
              kind={item.kind}
              name={item.name}
              mimeType={item.mimeType}
              className="size-full"
            />
          }
          trailing={item.mode === "link" ? <Link2 className="size-full" /> : undefined}
          data-attachment-inline-chip="true"
        />
      </NodexTooltip>
    );
  }

  if (item.type === "agentConfig") {
    const chip = resolveAgentConfigChip({
      ...item,
      unknownAttributes: item.unknownAttributes?.join(",") ?? "",
      rawAttributes: item.rawAttributes ?? "",
    });
    return (
      <span
        className={cn(
          "inline-flex max-w-[18rem] items-center gap-1 rounded-full px-2 py-0.5 align-middle text-[12px] leading-5",
          chip.invalid
            ? "bg-token-foreground/8 text-token-description-foreground"
            : "border border-token-border/55 bg-token-foreground/[0.035] text-token-foreground",
        )}
      >
        <NodexLogoMarkIcon monochrome className="size-3 shrink-0" />
        <span className="truncate">{chip.label}</span>
        {chip.summary ? <span className="truncate opacity-70">{chip.summary}</span> : null}
      </span>
    );
  }

  if (item.type === "threadMention") {
    const label = formatThreadMentionShortUuid(item.uuid);
    return (
      <ThreadMentionInlineVisual
        className="max-w-[18rem] align-baseline"
        title={item.uuid}
        label={label}
      />
    );
  }

  if (item.type === "pageMention") {
    return (
      <PageMentionInlineVisual
        className="max-w-[18rem] align-baseline"
        title={buildPageDeepLink({ pageId: item.targetPageId })}
        label={item.targetPageId}
      />
    );
  }

  if (item.type === "dateMention") {
    return (
      <DateMentionInlineVisual
        payload={item}
        className="max-w-[18rem]"
        title={formatDateMentionPlainText(item)}
      />
    );
  }

  if (item.type === "math") {
    return <MathSourcePreview source={item.source} />;
  }

  // text span
  const classes = styleClasses(item.styles, { includeCode: false });
  if (item.styles.code) {
    return <InlineMarkdownCode className={classes}>{item.text}</InlineMarkdownCode>;
  }
  if (!classes) return <>{item.text}</>;
  return <span className={classes}>{item.text}</span>;
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
  styles: NfmStyleSet,
  options?: { includeCode?: boolean },
): string | undefined {
  const parts: string[] = [];
  if (styles.bold) parts.push("font-semibold");
  if (styles.italic) parts.push("italic");
  if (styles.strikethrough) parts.push("line-through");
  if (styles.underline) parts.push("underline");
  if (styles.code && options?.includeCode !== false) parts.push("font-mono");
  if (styles.color) parts.push(nfmColorClass(styles.color));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function nfmColorClass(color: NfmColor): string {
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

function inlineText(items: NfmInlineContent[]): string {
  return items
    .map((item) => {
      if (item.type === "linebreak") return " ";
      if (item.type === "attachment") return item.name;
      if (item.type === "agentConfig") return "";
      if (item.type === "threadMention") return item.uuid;
      if (item.type === "pageMention") return item.targetPageId;
      if (item.type === "dateMention") return formatDateMentionPlainText(item);
      if (item.type === "math") return item.source;
      return item.text;
    })
    .join("")
    .trim();
}
