import { FormattedMessage } from "@/lib/i18n";
import { Children, createContext, isValidElement, useContext, type ReactNode } from "react";
import type { Element } from "hast";
import { type Components, type MermaidErrorComponentProps } from "streamdown";
import {
  InlineMarkdownCode,
  INLINE_MARKDOWN_HEADING_CLASS_NAME,
} from "@/components/shared/inline-markdown-code";
import { ChevronRightIcon } from "@/components/shared/icons";
import { FileLinkAnchor } from "@/components/shared/file-link-anchor";
import {
  groupOrderedListItems,
  type OrderedListGroup,
  resolveOrderedListMargin,
  resolveOrderedListPadding,
} from "./ordered-list-groups";
import { cn } from "./utils";
import { classifyNfmTable, type NfmTableCellFit } from "./nfm-table-layout";
import { NfmReadonlyTable } from "@/components/shared/nfm-readonly-table";

function createHeadingComponent(
  tagName: "h1" | "h2" | "h3" | "h4" | "h5" | "h6",
): NonNullable<Components["h1"]> {
  const headingClassName =
    tagName === "h1"
      ? "font-semibold heading-lg mt-5 mb-2"
      : tagName === "h2"
        ? "font-semibold heading-base mt-4 mb-2"
        : "font-semibold text-size-chat mt-3 mb-1.5";

  return function StreamdownHeading({ children, className, node, ...props }) {
    void node;
    const Tag = tagName;
    return (
      <Tag
        {...props}
        className={cn(headingClassName, INLINE_MARKDOWN_HEADING_CLASS_NAME, className)}
      >
        {children}
      </Tag>
    );
  };
}

function groupOrderedListChildren(children: ReactNode, start = 1): OrderedListGroup<ReactNode>[] {
  const items = Children.toArray(children).filter((child) => isValidElement(child));
  return groupOrderedListItems(items, (_child, index) => start + index);
}

const TableCellFitsContext = createContext<ReadonlyMap<Element, NfmTableCellFit> | null>(null);

function tableElements(node: Element | undefined, tags: readonly string[]): Element[] {
  return (node?.children ?? []).filter(
    (child): child is Element => child.type === "element" && tags.includes(child.tagName),
  );
}

function tableCellPlainText(node: Element): string {
  if (node.tagName === "br") return "\n";
  return node.children
    .map((child) =>
      child.type === "text"
        ? child.value
        : child.type === "element"
          ? tableCellPlainText(child)
          : "",
    )
    .join("");
}

function projectStreamdownTable(node: Element | undefined) {
  const rows = tableElements(node, ["thead", "tbody", "tr"])
    .flatMap((section) => (section.tagName === "tr" ? [section] : tableElements(section, ["tr"])))
    .map((row) => tableElements(row, ["th", "td"]));
  const { layout, columns, cellFits } = classifyNfmTable(
    rows.map((row) => row.map(tableCellPlainText)),
  );
  const fitsByNode = new Map<Element, NfmTableCellFit>();
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      const fit = cellFits[rowIndex][columnIndex];
      if (fit) fitsByNode.set(cell, fit);
    });
  });

  return { layout, columns, fitsByNode };
}

const StreamdownTable: Exclude<Components["table"], string | undefined> = ({
  children,
  node,
  ...props
}) => {
  const { layout, columns, fitsByNode } = projectStreamdownTable(node);

  return (
    <TableCellFitsContext.Provider value={fitsByNode}>
      <NfmReadonlyTable {...props} layout={layout} columns={columns}>
        {children}
      </NfmReadonlyTable>
    </TableCellFitsContext.Provider>
  );
};

function createTableCellComponent(Tag: "th" | "td"): Exclude<Components["td"], string | undefined> {
  return function StreamdownTableCell({ node, children, ...props }) {
    const fits = useContext(TableCellFitsContext);
    return (
      <Tag
        {...props}
        className={undefined}
        {...(node ? { "data-nfm-cell-fit": fits?.get(node) } : {})}
      >
        {children}
      </Tag>
    );
  };
}

export const streamdownComponents: Components = {
  p: ({ children, className, node, ...props }) => {
    void node;

    return (
      <p
        {...props}
        className={cn("text-size-chat leading-relaxed extension:leading-normal my-2", className)}
      >
        {children}
      </p>
    );
  },
  a: ({ href, children, className, node }) => {
    void node;
    // Markdown hrefs are URI-encoded. File URLs decode the path once, separately from fragments.
    const fileHref = href?.startsWith("/") && !href.startsWith("//") ? `file://${href}` : href;
    return (
      <FileLinkAnchor
        href={fileHref}
        className={cn(
          "decoration-opacity-50 text-token-text-link-foreground underline decoration-current decoration-[0.5px]",
          className,
        )}
        showLocalFileTooltip
      >
        {children}
      </FileLinkAnchor>
    );
  },
  h1: createHeadingComponent("h1"),
  h2: createHeadingComponent("h2"),
  h3: createHeadingComponent("h3"),
  h4: createHeadingComponent("h4"),
  h5: createHeadingComponent("h5"),
  h6: createHeadingComponent("h6"),
  ul: ({ children, className, node, ...props }) => {
    void node;

    const isTaskList = className?.includes("contains-task-list") ?? false;

    return (
      <ul
        {...props}
        className={cn(
          "text-size-chat leading-relaxed extension:leading-normal mt-0 mb-4",
          isTaskList ? "list-none pl-0" : "list-disc pl-4",
          className,
        )}
      >
        {children}
      </ul>
    );
  },
  ol: ({ children, className, node, start, ...props }) => {
    void node;

    const isTaskList = className?.includes("contains-task-list") ?? false;
    if (isTaskList) {
      return (
        <ol
          {...props}
          start={start}
          className={cn(
            "text-size-chat leading-relaxed extension:leading-normal mt-0 mb-4 list-none pl-0",
            className,
          )}
        >
          {children}
        </ol>
      );
    }

    const groupedChildren = groupOrderedListChildren(children, start);

    return (
      <>
        {groupedChildren.map((group, index) => (
          <ol
            {...props}
            key={`ol-${group.start}`}
            start={group.start}
            className={cn(
              "text-size-chat leading-relaxed extension:leading-normal list-decimal",
              resolveOrderedListMargin(index, groupedChildren.length),
              resolveOrderedListPadding(group.digits),
              className,
            )}
          >
            {group.items}
          </ol>
        ))}
      </>
    );
  },
  li: ({ children, className, node, ...props }) => {
    void node;

    const isTaskListItem = className?.includes("task-list-item") ?? false;

    return (
      <li
        {...props}
        className={cn(
          "text-size-chat leading-relaxed extension:leading-normal mb-1.5",
          isTaskListItem && "list-none",
          className,
        )}
      >
        {children}
      </li>
    );
  },
  blockquote: ({ children, className, node, ...props }) => {
    void node;

    return (
      <blockquote
        {...props}
        className={cn("my-3 border-l-2 border-gray-300 pl-4 italic", className)}
      >
        {children}
      </blockquote>
    );
  },
  hr: ({ className, node, ...props }) => {
    void node;

    return <hr {...props} className={cn("my-4 border-t border-gray-300", className)} />;
  },
  table: StreamdownTable,
  thead: "thead",
  tbody: "tbody",
  tr: "tr",
  th: createTableCellComponent("th"),
  td: createTableCellComponent("td"),
  details: ({ children, className, node, ...props }) => {
    void node;

    return (
      <details
        {...props}
        className={cn(
          "group my-3 rounded-xl border border-token-border/30 bg-token-bg-secondary/15 px-4 py-3",
          className,
        )}
      >
        {children}
      </details>
    );
  },
  summary: ({ children, className, node, ...props }) => {
    void node;

    return (
      <summary
        {...props}
        className={cn(
          "text-size-chat flex cursor-pointer list-none items-center gap-1.5 font-medium text-token-foreground marker:hidden [&::-webkit-details-marker]:hidden",
          className,
        )}
      >
        <ChevronRightIcon className="icon-2xs shrink-0 transition-transform group-open:rotate-90" />
        <span>{children}</span>
      </summary>
    );
  },
  inlineCode: ({ children, className, node, ...props }) => {
    void node;

    return (
      <InlineMarkdownCode {...props} className={className}>
        {children}
      </InlineMarkdownCode>
    );
  },
};

export function StreamdownMermaidError({ error }: MermaidErrorComponentProps) {
  return (
    <div className="rounded-md border border-(--destructive)/30 bg-(--destructive)/10 px-3 py-2 text-sm text-(--destructive)">
      <FormattedMessage
        id="lib.streamdown.mermaidError"
        defaultMessage="Mermaid Error: {error}"
        values={{ error }}
      />
    </div>
  );
}
