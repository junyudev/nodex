import { type Components } from "streamdown";
import MarkdownDocumentSurface from "./markdown-document-surface";
import { ConversationTokenRenderer } from "@/lib/markdown/conversation-token-renderer";
import type { ConversationDirectiveToken } from "@/lib/markdown/conversation-directives";
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

import type { MarkdownDisplayDialect } from "../../../../../../shared/conversation-markdown-display";

interface MarkdownCoreProps {
  dialect?: MarkdownDisplayDialect;
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
function renderVisualization(token: ConversationDirectiveToken) {
  if (token.name === "codex-live-vis") return null;
  if (token.name !== "codex-inline-vis" || !token.block) return undefined;
  const file = token.attributes.file ?? token.attributes.path;
  if (typeof file !== "string" || !file) return undefined;
  return (
    <LocalConversationInlineVisualization
      file={file}
      sourceThreadId={
        typeof token.attributes.threadId === "string" ? token.attributes.threadId : null
      }
      mode={resolveInlineVisualizationMode(token.attributes.mode)}
    />
  );
}
export function MarkdownCore({
  content,
  dialect = "document",
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
  const components = visualizationContext ? visualizationComponents : streamdownComponents;

  return (
    <ConversationVisualizationContext.Provider value={visualizationContext ?? null}>
      <FileLinkWorkspaceProvider cwd={cwd} workspacePath={projectWorkspacePath}>
        <FileMarkdownMediaProvider scope={fileMediaScope}>
          {dialect === "conversation" ? (
            <ConversationTokenRenderer
              source={content}
              sourceIdentity={sourceIdentity}
              streaming={parseIncompleteMarkdown}
              animate={animateStreamingText}
              adaptive={adaptiveStreaming}
              components={streamdownComponents}
              renderDirective={visualizationContext ? renderVisualization : undefined}
              className={`[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${MARKDOWN_CONTENT_CLASS_NAME}`}
            />
          ) : content ? (
            <MarkdownDocumentSurface
              source={content}
              sourceIdentity={sourceIdentity}
              streaming={parseIncompleteMarkdown}
              animate={animateStreamingText}
              adaptive={adaptiveStreaming}
              preserveLineBreaks={preserveLineBreaks}
              visualizations={Boolean(visualizationContext)}
              fileMedia={Boolean(fileMediaScope)}
              components={
                fileMediaScope ? { ...components, ...fileMarkdownMediaComponents } : components
              }
              className={`
          [&>*:first-child]:mt-0
          [&>*:last-child]:mb-0
          ${MARKDOWN_CONTENT_CLASS_NAME}
        `}
            />
          ) : null}
        </FileMarkdownMediaProvider>
      </FileLinkWorkspaceProvider>
    </ConversationVisualizationContext.Provider>
  );
}
