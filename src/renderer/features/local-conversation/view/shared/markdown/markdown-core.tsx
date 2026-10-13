import { type Components } from "streamdown";
import { MarkdownDocumentRenderer } from "@/lib/markdown/markdown-document-renderer";
import { readMarkdownSyntaxPolicy } from "@/lib/markdown/markdown-policy";
import { ConversationVisualizationContext } from "../../inline-visualization-context";
import { LocalConversationInlineVisualization } from "../../local-conversation-inline-visualization";
import { resolveInlineVisualizationMode } from "../../../../../lib/inline-visualization/inline-visualization-presentation";
import { MARKDOWN_CONTENT_CLASS_NAME } from "@/components/shared/inline-markdown-code";
import { FileLinkWorkspaceProvider } from "@/components/shared/file-link-anchor";
import {
  FileMarkdownMediaProvider,
  fileMarkdownMediaComponents,
} from "@/lib/file-markdown-media/file-markdown-media";
import type { FileMarkdownMediaScope } from "@/lib/file-markdown-media/file-markdown-media-model";
import { streamdownComponents } from "../../../../../lib/streamdown";

interface MarkdownCoreProps {
  content: string;
  sourceIdentity?: string;
  parseIncompleteMarkdown?: boolean;
  preserveLineBreaks?: boolean;
  animateStreamingText?: boolean;
  adaptiveStreaming?: boolean;
  cwd?: string | null;
  projectWorkspacePath?: string | null;
  visualizationContext?: ConversationVisualizationContext;
  fileMediaScope?: FileMarkdownMediaScope;
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
export function MarkdownCore({
  content,
  sourceIdentity,
  parseIncompleteMarkdown = false,
  preserveLineBreaks = false,
  animateStreamingText = false,
  adaptiveStreaming = false,
  cwd,
  projectWorkspacePath,
  visualizationContext,
  fileMediaScope,
}: MarkdownCoreProps) {
  const policy = readMarkdownSyntaxPolicy({
    preserveLineBreaks,
    visualizations: Boolean(visualizationContext),
    fileMedia: Boolean(fileMediaScope),
    repairIncomplete: parseIncompleteMarkdown,
  });
  const components = visualizationContext ? visualizationComponents : streamdownComponents;

  return (
    <ConversationVisualizationContext.Provider value={visualizationContext ?? null}>
      <FileLinkWorkspaceProvider cwd={cwd} workspacePath={projectWorkspacePath}>
        <FileMarkdownMediaProvider scope={fileMediaScope}>
          <MarkdownDocumentRenderer
            source={content}
            sourceIdentity={sourceIdentity}
            streaming={parseIncompleteMarkdown}
            animate={animateStreamingText}
            adaptive={adaptiveStreaming}
            policy={policy}
            components={
              fileMediaScope ? { ...components, ...fileMarkdownMediaComponents } : components
            }
            className={`
          [&>*:first-child]:mt-0
          [&>*:last-child]:mb-0
          ${MARKDOWN_CONTENT_CLASS_NAME}
        `}
          />
        </FileMarkdownMediaProvider>
      </FileLinkWorkspaceProvider>
    </ConversationVisualizationContext.Provider>
  );
}
