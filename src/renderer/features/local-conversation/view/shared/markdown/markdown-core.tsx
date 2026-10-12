import { useMemo } from "react";
import { Streamdown, defaultRemarkPlugins, type Components } from "streamdown";
import { remarkInlineVisualizations } from "../../../../../lib/inline-visualization/inline-visualization-directives";
import { ConversationVisualizationContext } from "../../inline-visualization-context";
import { LocalConversationInlineVisualization } from "../../local-conversation-inline-visualization";
import { resolveInlineVisualizationMode } from "../../../../../lib/inline-visualization/inline-visualization-presentation";
import { MARKDOWN_CONTENT_CLASS_NAME } from "@/components/shared/inline-markdown-code";
import { FileLinkWorkspaceProvider } from "@/components/shared/file-link-anchor";
import { useDocumentTheme } from "@/lib/use-document-theme";
import {
  StreamdownMermaidError,
  streamdownComponents,
  streamdownPlugins,
  streamdownRemarkPluginsWithBreaks,
} from "../../../../../lib/streamdown";

interface MarkdownCoreProps {
  content: string;
  parseIncompleteMarkdown?: boolean;
  preserveLineBreaks?: boolean;
  animateStreamingText?: boolean;
  cwd?: string | null;
  projectWorkspacePath?: string | null;
  visualizationContext?: ConversationVisualizationContext;
}

const visualizationComponents: Components = {
  ...streamdownComponents,
  "nodex-visualization": ({ file, threadid, mode }) =>
    typeof file === "string" ? (
      <LocalConversationInlineVisualization
        file={file}
        sourceThreadId={typeof threadid === "string" ? threadid : null}
        mode={resolveInlineVisualizationMode(mode)}
      />
    ) : null,
};
const visualizationTags = { "nodex-visualization": ["file", "threadid", "mode"] };
const visualizationPlugins = [...Object.values(defaultRemarkPlugins), remarkInlineVisualizations];
const visualizationBreakPlugins = [
  ...streamdownRemarkPluginsWithBreaks,
  remarkInlineVisualizations,
];

function normalizeMarkdown(content: string): string {
  const normalizedNewlines = content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u2028\u2029\u0085]/g, "\n");

  return normalizedNewlines.replace(/\n{3,}/g, "\n\n");
}

export function MarkdownCore({
  content,
  parseIncompleteMarkdown = false,
  preserveLineBreaks = false,
  animateStreamingText = false,
  cwd,
  projectWorkspacePath,
  visualizationContext,
}: MarkdownCoreProps) {
  const theme = useDocumentTheme();
  const normalizedContent = useMemo(() => normalizeMarkdown(content), [content]);
  const shouldAnimateStreamingText = animateStreamingText && parseIncompleteMarkdown;

  return (
    <ConversationVisualizationContext.Provider value={visualizationContext ?? null}>
      <FileLinkWorkspaceProvider cwd={cwd} workspacePath={projectWorkspacePath}>
        <Streamdown
          components={visualizationContext ? visualizationComponents : streamdownComponents}
          plugins={streamdownPlugins}
          remarkPlugins={
            visualizationContext
              ? preserveLineBreaks
                ? visualizationBreakPlugins
                : visualizationPlugins
              : preserveLineBreaks
                ? streamdownRemarkPluginsWithBreaks
                : undefined
          }
          allowedTags={visualizationContext ? visualizationTags : undefined}
          mermaid={{
            config: { theme: theme === "dark" ? "dark" : "neutral" },
            errorComponent: StreamdownMermaidError,
          }}
          parseIncompleteMarkdown={parseIncompleteMarkdown}
          // Keep stateful document leaves mounted when a response finishes.
          mode={visualizationContext || parseIncompleteMarkdown ? "streaming" : "static"}
          animated={
            shouldAnimateStreamingText
              ? {
                  animation: "fadeIn",
                  sep: "word",
                  duration: 200,
                  easing: "cubic-bezier(.37, .55, .86, .88)",
                }
              : undefined
          }
          isAnimating={shouldAnimateStreamingText}
          lineNumbers={false}
          className={`
          [&>*:first-child]:mt-0
          [&>*:last-child]:mb-0
          ${MARKDOWN_CONTENT_CLASS_NAME}
        `}
          controls={{
            table: false,
            code: {
              copy: true,
              download: false,
            },
            mermaid: true,
          }}
        >
          {normalizedContent}
        </Streamdown>
      </FileLinkWorkspaceProvider>
    </ConversationVisualizationContext.Provider>
  );
}
