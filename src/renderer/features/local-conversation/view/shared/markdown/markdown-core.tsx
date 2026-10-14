import { type Components } from "streamdown";
import MarkdownDocumentSurface from "./markdown-document-surface";
import {
  ConversationTokenRenderer,
  type ConversationDirectiveRenderer,
} from "@/lib/markdown/conversation-token-renderer";
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
import {
  ConversationMediaProvider,
  conversationMediaComponents,
} from "@/lib/conversation-media/conversation-media";
import type { ReactNode } from "react";
import { streamdownComponents } from "../../../../../lib/streamdown";

import type { MarkdownDisplayDialect } from "../../../../../../shared/conversation-markdown-display";
import {
  ConversationMarkdownItemSourceProvider,
  useConversationMarkdownSource,
  type ConversationMarkdownNativeSource,
} from "../../conversation-markdown-source";
import { renderConversationInline } from "../../conversation-markdown-inline";
import { ConversationDirectiveDetails } from "./conversation-directive-details";
import { ConversationTaskSuggestion } from "./conversation-task-suggestion";

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
  nativeSource?: ConversationMarkdownNativeSource;
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
const conversationComponents: Components = {
  ...streamdownComponents,
  ...conversationMediaComponents,
};
function ConversationResources({ children }: { readonly children: ReactNode }) {
  const source = useConversationMarkdownSource();
  return <ConversationMediaProvider source={source}>{children}</ConversationMediaProvider>;
}
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
const renderConversationDirective: ConversationDirectiveRenderer = (token, context) => {
  const { registration } = context;
  if (registration.kind === "task-stub")
    return (
      <ConversationTaskSuggestion
        title={registration.title}
        prompt={registration.prompt}
        raw={token.raw}
      />
    );
  if (registration.kind !== "github-details") return undefined;
  return (
    <ConversationDirectiveDetails
      summary={registration.summary}
      initiallyOpen={registration.initiallyOpen}
    >
      {context.renderChildren()}
    </ConversationDirectiveDetails>
  );
};
const renderVisualizedConversationDirective: ConversationDirectiveRenderer = (token, context) => {
  const registered = renderConversationDirective(token, context);
  return registered !== undefined ? registered : renderVisualization(token);
};
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
  nativeSource,
}: MarkdownCoreProps) {
  const components = visualizationContext ? visualizationComponents : streamdownComponents;

  return (
    <ConversationVisualizationContext.Provider value={visualizationContext ?? null}>
      <FileLinkWorkspaceProvider cwd={cwd} workspacePath={projectWorkspacePath}>
        <FileMarkdownMediaProvider scope={fileMediaScope}>
          {dialect === "conversation" ? (
            <ConversationMarkdownItemSourceProvider source={nativeSource}>
              <ConversationResources>
                <ConversationTokenRenderer
                  source={content}
                  sourceIdentity={sourceIdentity}
                  streaming={parseIncompleteMarkdown}
                  animate={animateStreamingText}
                  adaptive={adaptiveStreaming}
                  components={conversationComponents}
                  renderDirective={
                    visualizationContext
                      ? renderVisualizedConversationDirective
                      : renderConversationDirective
                  }
                  renderInline={renderConversationInline}
                  className={`[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${MARKDOWN_CONTENT_CLASS_NAME}`}
                />
              </ConversationResources>
            </ConversationMarkdownItemSourceProvider>
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
