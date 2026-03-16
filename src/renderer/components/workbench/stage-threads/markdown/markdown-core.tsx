import { useMemo } from "react";
import { Streamdown } from "streamdown";
import {
  StreamdownMermaidError,
  streamdownComponents,
  streamdownPlugins,
  streamdownRemarkPluginsWithBreaks,
} from "../../../../lib/streamdown";

interface MarkdownCoreProps {
  content: string;
  parseIncompleteMarkdown?: boolean;
  preserveLineBreaks?: boolean;
}

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
}: MarkdownCoreProps) {
  const normalizedContent = useMemo(() => normalizeMarkdown(content), [content]);

  return (
    <Streamdown
      components={streamdownComponents}
      plugins={streamdownPlugins}
      remarkPlugins={preserveLineBreaks ? streamdownRemarkPluginsWithBreaks : undefined}
      mermaid={{ errorComponent: StreamdownMermaidError }}
      parseIncompleteMarkdown={parseIncompleteMarkdown}
      mode={parseIncompleteMarkdown ? "streaming" : "static"}
      className="space-y-1"
      controls={{ table: false, code: true, mermaid: true }}
    >
      {normalizedContent}
    </Streamdown>
  );
}
