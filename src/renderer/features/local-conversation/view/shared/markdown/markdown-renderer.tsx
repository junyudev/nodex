import { cn } from "../../../../../lib/utils";
import { writeTextToClipboard } from "../../../../../lib/clipboard";
import { MarkdownCore } from "./markdown-core";
import type { CSSProperties, MouseEvent } from "react";
import type { ConversationVisualizationContext } from "../../inline-visualization-context";

export interface MarkdownRendererProps {
  content: string;
  className?: string;
  style?: CSSProperties;
  parseIncompleteMarkdown?: boolean;
  preserveLineBreaks?: boolean;
  animateStreamingText?: boolean;
  cwd?: string | null;
  projectWorkspacePath?: string | null;
  visualizationContext?: ConversationVisualizationContext;
}

function readStreamdownCodeLineText(line: Element): string {
  const text = line.textContent ?? "";
  if (text === "\n") return "";
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

function readStreamdownCodeBlockText(codeBlock: Element): string | null {
  const code = codeBlock.querySelector("code");
  if (!code) return null;

  const lineNodes = Array.from(code.querySelectorAll(":scope > span"));
  if (lineNodes.length === 0) return code.textContent;

  return lineNodes.map(readStreamdownCodeLineText).join("\n");
}

function handleStreamdownCodeBlockCopyClick(event: MouseEvent<HTMLDivElement>) {
  const { target, currentTarget } = event;
  if (!(target instanceof Element)) return;

  const button = target.closest('[data-streamdown="code-block-copy-button"]');
  if (!button || !currentTarget.contains(button)) return;

  const codeBlock = button.closest('[data-streamdown="code-block"]');
  if (!codeBlock || !currentTarget.contains(codeBlock)) return;

  const codeText = readStreamdownCodeBlockText(codeBlock);
  if (codeText === null) return;

  void writeTextToClipboard(codeText).catch(() => undefined);
}

export function MarkdownRenderer({
  content,
  className,
  style,
  parseIncompleteMarkdown,
  preserveLineBreaks,
  animateStreamingText,
  cwd,
  projectWorkspacePath,
  visualizationContext,
}: MarkdownRendererProps) {
  return (
    <div
      className={cn("codex-markdown", className)}
      onClickCapture={handleStreamdownCodeBlockCopyClick}
      style={style}
    >
      <MarkdownCore
        content={content}
        parseIncompleteMarkdown={parseIncompleteMarkdown}
        preserveLineBreaks={preserveLineBreaks}
        animateStreamingText={animateStreamingText}
        cwd={cwd}
        projectWorkspacePath={projectWorkspacePath}
        visualizationContext={visualizationContext}
      />
    </div>
  );
}
