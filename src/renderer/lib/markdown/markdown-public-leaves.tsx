import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { CodeBlock, StreamdownContext, type Components } from "streamdown";
import type { Element } from "hast";
import { MarkdownCodeCopyButton } from "./markdown-code-copy-button";
import {
  FileMarkdownImageFrame,
  useFileMarkdownImagePresentation,
} from "../file-markdown-media/file-markdown-image-presentation";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogTitle,
  NodexDialogTrigger,
} from "@/components/ui/dialog";
import { renderMermaidDiagram, renderMermaidDownload } from "../mermaid-runtime";
import { writeTextToClipboard } from "../clipboard";
import { useDocumentTheme } from "../use-document-theme";
import { cn } from "../utils";
import { DownloadIcon, CopyIcon, ExpandPanelIcon } from "@/components/shared/icons";

function htmlText(node: Element): string {
  return node.children
    .map((child) =>
      child.type === "text" ? child.value : child.type === "element" ? htmlText(child) : "",
    )
    .join("");
}

function clickMarkdownDownload(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = href;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(href);
  }
}

function markdownImageFilename(src: string): string {
  try {
    return new URL(src).pathname.split("/").at(-1) || "image";
  } catch {
    return "image";
  }
}

export function MarkdownCodeBlock({
  node,
  incomplete,
}: {
  readonly node: Element;
  readonly incomplete: boolean;
}) {
  const context = useContext(StreamdownContext);
  const code = node.children.find(
    (child): child is Element => child.type === "element" && child.tagName === "code",
  );
  if (!code) return null;
  const classes = code.properties.className;
  const language =
    (Array.isArray(classes) ? classes.join(" ") : String(classes ?? "")).match(
      /language-([^\s]+)/u,
    )?.[1] ?? "text";
  const text = htmlText(code).replace(/\n$/u, "");
  const meta = typeof code.properties.metastring === "string" ? code.properties.metastring : "";
  if (language === "mermaid") return <MarkdownMermaid source={text} incomplete={incomplete} />;
  const showCopy =
    context.controls === true ||
    (context.controls !== false &&
      context.controls.code !== false &&
      (typeof context.controls.code !== "object" || context.controls.code.copy !== false));
  return (
    <CodeBlock
      code={text}
      language={language}
      isIncomplete={incomplete}
      lineNumbers={context.lineNumbers && !/\bnoLineNumbers\b/u.test(meta)}
      startLine={Number(meta.match(/startLine=(\d+)/u)?.[1] ?? 1)}
    >
      {showCopy ? <MarkdownCodeCopyButton text={text} disabled={incomplete} /> : null}
    </CodeBlock>
  );
}

function MarkdownMermaid({
  source,
  incomplete,
}: {
  readonly source: string;
  readonly incomplete: boolean;
}) {
  const theme = useDocumentTheme();
  const id = useId().replaceAll(":", "");
  const [result, setResult] = useState<{
    source: string;
    theme: string;
    svg?: string;
    error?: string;
  } | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let current = true;
    if (incomplete)
      return () => {
        current = false;
      };
    void renderMermaidDiagram({ source, theme, requestId: `markdown-${id}` }).then(
      (value) => {
        if (current) setResult({ source, theme, svg: value.svg });
      },
      (error: unknown) => {
        if (current)
          setResult({
            source,
            theme,
            error: error instanceof Error ? error.message : "Unable to render diagram",
          });
      },
    );
    return () => {
      current = false;
    };
  }, [source, theme, id, incomplete]);
  const current = result?.source === source && result.theme === theme ? result : null;
  const download = async () => {
    if (!current?.svg) return;
    const value = await renderMermaidDownload({ svg: current.svg, theme });
    clickMarkdownDownload(value.blob, `diagram.${value.format}`);
  };
  const drawing: ReactNode = current?.svg ? (
    <div dangerouslySetInnerHTML={{ __html: current.svg }} />
  ) : (
    <pre>
      <code>{source}</code>
    </pre>
  );
  return (
    <div
      data-streamdown="mermaid-block"
      className="relative my-3 rounded-lg border border-token-border p-3"
    >
      <div className="flex justify-end gap-1" data-content-search-skip="true">
        <NodexTooltip tooltipContent="Copy diagram">
          <button
            type="button"
            aria-label="Copy diagram"
            onClick={() => {
              void writeTextToClipboard(source);
            }}
          >
            <CopyIcon className="icon-sm" />
          </button>
        </NodexTooltip>
        {current?.svg ? (
          <NodexTooltip tooltipContent="Download diagram">
            <button
              type="button"
              aria-label="Download diagram"
              onClick={() => {
                void download().catch(() => undefined);
              }}
            >
              <DownloadIcon className="icon-sm" />
            </button>
          </NodexTooltip>
        ) : null}
        <NodexDialog open={expanded} onOpenChange={setExpanded}>
          <NodexDialogTrigger>
            <button type="button" aria-label="Expand diagram">
              <ExpandPanelIcon className="icon-sm" />
            </button>
          </NodexDialogTrigger>
          <NodexDialogContent size="large">
            <NodexDialogTitle className="sr-only">Diagram</NodexDialogTitle>
            {drawing}
          </NodexDialogContent>
        </NodexDialog>
      </div>
      {drawing}
      {!incomplete && current?.error ? (
        <div role="status" data-content-search-skip="true">
          {current.error}
        </div>
      ) : null}
    </div>
  );
}

function MarkdownNativeImage({
  node: _node,
  src,
  srcSet,
  alt,
  title,
  className,
  ...props
}: ComponentProps<"img"> & { node?: Element }) {
  const parent = useFileMarkdownImagePresentation();
  const ref = useRef<HTMLImageElement | null>(null);
  useLayoutEffect(() => {
    const names = new Map<string, string>();
    if (typeof src === "string" && /^(?:https?:|data:image\/)/iu.test(src)) {
      names.set(src, markdownImageFilename(src));
    }
    return parent?.registerResources(names, true);
  }, [src, parent]);
  useEffect(() => {
    const image = ref.current;
    if (image?.complete && image.naturalWidth > 0) parent?.loaded(image);
  }, [src, srcSet, parent]);
  const image = (
    <img
      {...props}
      src={src}
      srcSet={srcSet}
      alt={alt ?? ""}
      className={cn("max-w-full rounded-lg", parent?.failed && "hidden", className)}
      ref={(element) => {
        ref.current = element;
        parent?.attach(element);
      }}
      onLoad={(event) => {
        parent?.loaded(event.currentTarget);
        props.onLoad?.(event);
      }}
      onError={(event) => {
        parent?.errored(event.currentTarget);
        props.onError?.(event);
      }}
    />
  );
  return title ? <NodexTooltip tooltipContent={title}>{image}</NodexTooltip> : image;
}

/** Public primitive adapters observe actual props rather than source-position equality. */
export const markdownPublicLeafComponents: Components = {
  strong: ({ node, children, className, ...props }) => {
    void node;
    return (
      <strong {...props} className={cn("font-semibold", className)}>
        {children}
      </strong>
    );
  },
  sup: ({ node, ...props }) => {
    void node;
    return <sup {...props} />;
  },
  sub: ({ node, ...props }) => {
    void node;
    return <sub {...props} />;
  },
  section: ({ node, ...props }) => {
    void node;
    return <section {...props} />;
  },
  del: ({ node, ...props }) => {
    void node;
    return <del {...props} />;
  },
  em: ({ node, ...props }) => {
    void node;
    return <em {...props} />;
  },
  code: ({ node, ...props }) => {
    void node;
    return <code {...props} />;
  },
  img: ({ node, ...props }) => (
    <FileMarkdownImageFrame identity={JSON.stringify([props.src, props.srcSet])}>
      <MarkdownNativeImage {...props} node={node} />
    </FileMarkdownImageFrame>
  ),
};
