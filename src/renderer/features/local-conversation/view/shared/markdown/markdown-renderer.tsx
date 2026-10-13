import { cn } from "../../../../../lib/utils";
import { MarkdownCore } from "./markdown-core";
import type { CSSProperties } from "react";
import type { ConversationVisualizationContext } from "../../inline-visualization-context";
import type { FileMarkdownMediaScope } from "@/lib/file-markdown-media/file-markdown-media-model";
import {
  useAdaptiveMarkdown,
  type AdaptiveMarkdownOptions,
} from "../../../../../lib/markdown/use-adaptive-markdown";

import type { MarkdownDisplayDialect } from "../../../../../../shared/conversation-markdown-display";

export interface MarkdownRendererProps {
  dialect?: MarkdownDisplayDialect;
  content: string;
  className?: string;
  style?: CSSProperties;
  parseIncompleteMarkdown?: boolean;
  preserveLineBreaks?: boolean;
  animateStreamingText?: boolean;
  adaptiveBuffering?: AdaptiveMarkdownOptions;
  cwd?: string | null;
  projectWorkspacePath?: string | null;
  visualizationContext?: ConversationVisualizationContext;
  fileMediaScope?: FileMarkdownMediaScope;
}

export function MarkdownRenderer({
  content,
  dialect,
  className,
  style,
  parseIncompleteMarkdown,
  preserveLineBreaks,
  animateStreamingText,
  adaptiveBuffering,
  cwd,
  projectWorkspacePath,
  visualizationContext,
  fileMediaScope,
}: MarkdownRendererProps) {
  return (
    <div className={cn("codex-markdown", className)} style={style}>
      {adaptiveBuffering ? (
        <BufferedMarkdown
          content={content}
          dialect={dialect}
          parseIncompleteMarkdown={parseIncompleteMarkdown}
          preserveLineBreaks={preserveLineBreaks}
          animateStreamingText={animateStreamingText}
          cwd={cwd}
          projectWorkspacePath={projectWorkspacePath}
          visualizationContext={visualizationContext}
          fileMediaScope={fileMediaScope}
          buffering={adaptiveBuffering}
        />
      ) : (
        <MarkdownCore
          content={content}
          dialect={dialect}
          parseIncompleteMarkdown={parseIncompleteMarkdown}
          preserveLineBreaks={preserveLineBreaks}
          animateStreamingText={animateStreamingText}
          cwd={cwd}
          projectWorkspacePath={projectWorkspacePath}
          visualizationContext={visualizationContext}
          fileMediaScope={fileMediaScope}
        />
      )}
    </div>
  );
}

function BufferedMarkdown({
  buffering,
  ...props
}: MarkdownRendererProps & { readonly buffering: AdaptiveMarkdownOptions }) {
  const value = useAdaptiveMarkdown(
    props.content,
    buffering,
    props.parseIncompleteMarkdown ?? false,
    props.animateStreamingText ?? true,
  );
  return (
    <MarkdownCore
      {...props}
      content={value.text}
      animateStreamingText={value.animate}
      adaptiveStreaming={value.active}
      sourceIdentity={buffering.streamId}
    />
  );
}
