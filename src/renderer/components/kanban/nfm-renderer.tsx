import { FileCode2, FileText, Folder, Link2 } from "lucide-react";
import { Streamdown } from "streamdown";
import type {
  NfmBlock,
  NfmInlineContent,
  NfmColor,
  NfmStyleSet,
} from "@/lib/nfm/types";
import { FileLinkAnchor } from "../shared/file-link-anchor";
import { parseNfm } from "@/lib/nfm/parser";
import { resolveAssetSourceToHttpUrl } from "@/lib/assets";
import { cn } from "@/lib/utils";
import { streamdownCodePlugin } from "@/lib/streamdown";

interface NfmRendererProps {
  content: string;
  className?: string;
}

/** Read-only renderer for Notion-flavored Markdown. */
export function NfmRenderer({ content, className }: NfmRendererProps) {
  if (!content.trim()) return null;
  const blocks = parseNfm(content);
  return (
    <div className={cn("nfm-render", className)}>
      <BlockList blocks={blocks} />
    </div>
  );
}

function BlockList({ blocks }: { blocks: NfmBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => (
        <BlockComponent key={i} block={block} />
      ))}
    </>
  );
}

function BlockComponent({ block }: { block: NfmBlock }) {
  const colorClass = block.color ? nfmColorClass(block.color) : undefined;

  switch (block.type) {
    case "paragraph":
      return (
        <p className={cn("my-1 leading-relaxed", colorClass)}>
          <InlineList items={block.content} />
          <ChildBlocks children={block.children} />
        </p>
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
            <summary className={cn("nfm-toggle-summary", sizes[block.level])}>
              <ToggleCaretIcon hasChildren={block.children.length > 0} />
              <span className="min-w-0">
                <InlineList items={block.content} />
              </span>
            </summary>
            {block.children.length > 0 && (
              <div className="mt-1 pl-4">
                <BlockList blocks={block.children} />
              </div>
            )}
          </details>
        );
      }

      return (
        <Tag className={cn(sizes[block.level], colorClass)}>
          <InlineList items={block.content} />
          <ChildBlocks children={block.children} />
        </Tag>
      );
    }

    case "bulletListItem":
      return (
        <ul className="my-0.5 list-disc pl-6">
          <li className={colorClass}>
            <InlineList items={block.content} />
            <ChildBlocks children={block.children} />
          </li>
        </ul>
      );

    case "numberedListItem":
      return (
        <ol className="my-0.5 list-decimal pl-6">
          <li className={colorClass}>
            <InlineList items={block.content} />
            <ChildBlocks children={block.children} />
          </li>
        </ol>
      );

    case "checkListItem":
      return (
        <div className={cn("my-0.5 flex items-start gap-2", colorClass)}>
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
                <path d="M3 7.5L5.5 10L11 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
          <span className={block.checked ? "line-through opacity-60" : ""}>
            <InlineList items={block.content} />
          </span>
          <ChildBlocks children={block.children} />
        </div>
      );

    case "toggle":
      return (
        <details className={cn("nfm-toggle my-1", colorClass)} open={block.isOpen || undefined}>
          <summary className="nfm-toggle-summary">
            <ToggleCaretIcon hasChildren={block.children.length > 0} />
            <span className="min-w-0">
              <InlineList items={block.content} />
            </span>
          </summary>
          {block.children.length > 0 && (
            <div className="mt-1 pl-4">
              <BlockList blocks={block.children} />
            </div>
          )}
        </details>
      );

    case "blockquote":
      return (
        <blockquote
          className={cn(
            "my-2 border-l-[calc(var(--spacing)*0.75)] border-(--border) pl-4 text-(--foreground-secondary)",
            colorClass,
          )}
        >
          <InlineList items={block.content} />
          <ChildBlocks children={block.children} />
        </blockquote>
      );

    case "codeBlock":
      return (
        <HighlightedCodeBlock
          code={block.code}
          language={block.language}
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
          {block.icon && (
            <span className="text-[1.2em] select-none">{block.icon}</span>
          )}
          <div className="min-w-0 flex-1">
            <InlineList items={block.content} />
            <ChildBlocks children={block.children} />
          </div>
        </div>
      );

    case "image": {
      const sourceUrl = resolveAssetSourceToHttpUrl(block.source);
      const alt = inlineText(block.caption) || "Image";
      const widthStyle = block.previewWidth !== undefined
        ? { width: `${block.previewWidth}px`, maxWidth: "100%" }
        : undefined;

      return (
        <figure className={cn("my-3", colorClass)}>
          <img
            src={sourceUrl}
            alt={alt}
            className="max-w-full rounded-md border border-(--border)"
            style={widthStyle}
            loading="lazy"
          />
          {block.caption.length > 0 && (
            <figcaption className="mt-1 text-sm text-(--foreground-secondary)">
              <InlineList items={block.caption} />
            </figcaption>
          )}
          <ChildBlocks children={block.children} />
        </figure>
      );
    }

    case "toggleListInlineView":
      return (
        <div className="my-2.5 inline-flex items-center gap-2 rounded-lg border border-dashed border-(--border) bg-[color-mix(in_srgb,var(--background-secondary)_65%,transparent)] px-2.5 py-2 text-xs leading-none text-(--foreground-secondary)" title={`Inline toggle-list view (${block.sourceProjectId})`}>
          <span aria-hidden="true">∞</span>
          <span className="whitespace-nowrap">
            Toggle List Inline View · {block.sourceProjectId}
          </span>
        </div>
      );

    case "cardRef":
      return (
        <div className="my-2.5 inline-flex items-center gap-2 rounded-lg border border-dashed border-(--border) bg-[color-mix(in_srgb,var(--background-secondary)_65%,transparent)] px-2.5 py-2 text-xs leading-none text-(--foreground-secondary)" title={`Card reference (${block.sourceProjectId}/${block.cardId})`}>
          <span aria-hidden="true">↗</span>
          <span className="whitespace-nowrap">
            Card Reference · {block.sourceProjectId}/{block.cardId || "unlinked"}
          </span>
        </div>
      );

    case "cardToggle":
      return (
        <details className="nfm-toggle my-1" open>
          <summary className="nfm-toggle-summary">
            <ToggleCaretIcon hasChildren={block.children.length > 0} />
            <span className="min-w-0">
              {block.meta && (
                <span className="mr-2 text-(--foreground-secondary)">{block.meta}</span>
              )}
              <InlineList items={block.content} />
            </span>
          </summary>
          {block.children.length > 0 && (
            <div className="mt-1 pl-4">
              <BlockList blocks={block.children} />
            </div>
          )}
        </details>
      );

    case "divider":
      return <hr className="my-4 border-t border-(--border)" />;

    case "emptyBlock":
      return <div className="h-[1em]" />;
  }
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
  const normalizedLanguage = language.trim().toLowerCase();
  const fencedCode = `\`\`\`${normalizedLanguage}\n${code}\n\`\`\``;

  return (
    <div className={cn("nfm-code-block my-2 text-sm", className)}>
      <Streamdown plugins={{ code: streamdownCodePlugin }} controls={false}>
        {fencedCode}
      </Streamdown>
    </div>
  );
}

function ChildBlocks({ children }: { children: NfmBlock[] }) {
  if (!children || children.length === 0) return null;
  return (
    <div className="mt-1 pl-4">
      <BlockList blocks={children} />
    </div>
  );
}

function InlineList({ items }: { items: NfmInlineContent[] }) {
  return (
    <>
      {items.map((item, i) => (
        <InlineItem key={i} item={item} />
      ))}
    </>
  );
}

function InlineItem({ item }: { item: NfmInlineContent }) {
  if (item.type === "linebreak") return <br />;

  if (item.type === "link") {
    return (
      <FileLinkAnchor
        href={item.href}
        className={cn("nfm-render-link", styleClasses(item.styles))}
      >
        {item.text}
      </FileLinkAnchor>
    );
  }

  if (item.type === "attachment") {
    const Icon = item.mode === "link"
      ? Link2
      : item.kind === "folder"
        ? Folder
        : item.kind === "file"
          ? FileCode2
          : FileText;
    const label = item.name.trim() || (item.kind === "text" ? "Pasted text" : "Untitled attachment");

    return (
      <span
        className="inline-flex max-w-[18rem] items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)] px-2 py-0.5 align-middle text-[12px] leading-5 text-[color-mix(in_srgb,var(--foreground)_84%,transparent)] shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--foreground)_10%,transparent)]"
        title={item.mode === "link" ? item.source : (item.origin || item.source)}
      >
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }

  // text span
  const classes = styleClasses(item.styles);
  if (!classes) return <>{item.text}</>;
  return <span className={classes}>{item.text}</span>;
}

function styleClasses(styles: NfmStyleSet): string | undefined {
  const parts: string[] = [];
  if (styles.bold) parts.push("font-semibold");
  if (styles.italic) parts.push("italic");
  if (styles.strikethrough) parts.push("line-through");
  if (styles.underline) parts.push("underline");
  if (styles.code)
    parts.push(
      "font-mono text-[0.9em] text-[var(--inline-code-text)] bg-[var(--inline-code-bg)] px-1.5 py-0.5 rounded",
    );
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
      return item.text;
    })
    .join("")
    .trim();
}
