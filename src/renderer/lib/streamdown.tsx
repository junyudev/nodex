import { Children, isValidElement, type ReactNode } from "react";
import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import remarkBreaks from "remark-breaks";
import { defaultRemarkPlugins, type Components, type MermaidErrorComponentProps } from "streamdown";
import type { Pluggable } from "unified";
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
import { NFM_CODE_THEME_PAIR } from "./syntax-highlighting";
import { streamdownMermaidPlugin } from "./mermaid-runtime";
import { cn } from "./utils";

const baseStreamdownCodePlugin = createCodePlugin({
  themes: [NFM_CODE_THEME_PAIR[0], NFM_CODE_THEME_PAIR[1]],
});

type StreamdownHighlightOptions = Parameters<typeof baseStreamdownCodePlugin.highlight>[0];
type StreamdownHighlightResult = Exclude<
  ReturnType<typeof baseStreamdownCodePlugin.highlight>,
  null
>;

function createPlainTextHighlightResult(code: string): StreamdownHighlightResult {
  return {
    bg: "transparent",
    fg: "inherit",
    tokens: code.split("\n").map((line) => [
      {
        content: line,
        color: "inherit",
        bgColor: "transparent",
        htmlStyle: {},
        offset: 0,
      },
    ]),
  };
}

export const streamdownCodePlugin = {
  ...baseStreamdownCodePlugin,
  highlight(
    options: StreamdownHighlightOptions,
    callback?: Parameters<typeof baseStreamdownCodePlugin.highlight>[1],
  ) {
    if (!baseStreamdownCodePlugin.supportsLanguage(options.language)) {
      return createPlainTextHighlightResult(options.code);
    }
    return baseStreamdownCodePlugin.highlight(options, callback);
  },
};

export const streamdownPlugins = {
  code: streamdownCodePlugin,
  mermaid: streamdownMermaidPlugin,
  math: createMathPlugin({
    errorColor: "var(--foreground-tertiary)",
  }),
  cjk,
} as const;

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
  table: ({ children, className, node, ...props }) => {
    void node;

    return (
      <table {...props} className={cn("my-3 w-full border-collapse", className)}>
        {children}
      </table>
    );
  },
  thead: ({ children, className, node, ...props }) => {
    void node;

    return (
      <thead {...props} className={cn("bg-token-foreground/5", className)}>
        {children}
      </thead>
    );
  },
  tbody: ({ children, className, node, ...props }) => {
    void node;

    return (
      <tbody {...props} className={className}>
        {children}
      </tbody>
    );
  },
  tr: ({ children, className, node, ...props }) => {
    void node;

    return (
      <tr {...props} className={cn("border-b border-token-border", className)}>
        {children}
      </tr>
    );
  },
  th: ({ children, className, node, ...props }) => {
    void node;

    return (
      <th {...props} className={cn("p-1 text-left font-semibold text-token-foreground", className)}>
        {children}
      </th>
    );
  },
  td: ({ children, className, node, ...props }) => {
    void node;

    return (
      <td {...props} className={cn("p-1", className)}>
        {children}
      </td>
    );
  },
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

export const streamdownRemarkPluginsWithBreaks: Pluggable[] = [
  ...Object.values(defaultRemarkPlugins),
  remarkBreaks,
];

export function StreamdownMermaidError({ error }: MermaidErrorComponentProps) {
  return (
    <div className="rounded-md border border-(--destructive)/30 bg-(--destructive)/10 px-3 py-2 text-sm text-(--destructive)">
      Mermaid Error: {error}
    </div>
  );
}
