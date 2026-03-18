import type { CodexItemNormalizedKind, CodexItemView } from "../../../lib/types";
import { MarkdownRenderer } from "./markdown/markdown-renderer";
import { PlanMessage } from "./plan-message";
import { UserInputTranscriptView } from "./stage-threads-request-cards";
import {
  CopyMessageActionButton,
  EditMessageIcon,
  ThreadActionIconButton,
  ThreadMessageActionRow,
} from "./thread-message-actions";
import { getToolComponent } from "./tools/get-tool-component";
import { InlineToolToggle, JsonBlock } from "./tools/tool-primitives";

interface ThreadItemRendererProps {
  item: CodexItemView;
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  showUserMessageActions?: boolean;
  showAssistantMessageActions?: boolean;
  projectWorkspacePath?: string;
  threadCwd?: string;
}

function resolveKind(item: CodexItemView): CodexItemNormalizedKind {
  return item.normalizedKind;
}

function isToolKind(kind: CodexItemNormalizedKind): boolean {
  return kind === "toolCall" || kind === "commandExecution" || kind === "fileChange";
}

export function ThreadItemRenderer({
  item,
  isLatestTurn,
  isStreamingTurn,
  showUserMessageActions = false,
  showAssistantMessageActions = false,
  projectWorkspacePath,
  threadCwd,
}: ThreadItemRendererProps) {
  const kind = resolveKind(item);

  if (isToolKind(kind) || item.toolCall) {
    const ToolComponent = getToolComponent(item);
    return (
      <div className="px-2.5">
        <ToolComponent item={item} projectWorkspacePath={projectWorkspacePath} threadCwd={threadCwd} />
      </div>
    );
  }

  if (kind === "userMessage") {
    const content = item.markdownText ?? "";
    return (
      <div className="flex flex-col items-end gap-2 px-2.5">
        <div className="group flex w-full flex-col items-end justify-end gap-1">
          <div className="max-w-[77%] rounded-2xl bg-token-foreground/5 px-3 py-2 wrap-break-word [&_.contain-inline-size]:contain-[initial]">
            <MarkdownRenderer content={content} preserveLineBreaks className="codex-markdown-user" />
          </div>
          {showUserMessageActions && (
            <div className="flex flex-row-reverse items-center gap-1">
              <ThreadMessageActionRow align="end">
                <CopyMessageActionButton text={content} />
                <ThreadActionIconButton
                  label="Edit message"
                  title="Edit message (mock)"
                  onClick={() => {}}
                >
                  <EditMessageIcon />
                </ThreadActionIconButton>
              </ThreadMessageActionRow>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (kind === "assistantMessage" || kind === "plan" || kind === "reasoning") {
    const markdownText = item.markdownText ?? "";
    const parseIncompleteMarkdown =
      isStreamingTurn && (item.status === "inProgress" || isLatestTurn);

    if (kind === "reasoning") {
      return (
        <div className="px-2.5">
          <InlineToolToggle
            label="Thinking"
            leadingLabel="Thinking"
            status={item.status}
          >
            <MarkdownRenderer
              content={markdownText}
              parseIncompleteMarkdown={parseIncompleteMarkdown}
              preserveLineBreaks
            />
          </InlineToolToggle>
        </div>
      );
    }

    if (kind === "plan") {
      return (
        <PlanMessage
          content={markdownText}
          parseIncompleteMarkdown={parseIncompleteMarkdown}
          defaultExpanded={Boolean(isStreamingTurn || item.status === "inProgress")}
        />
      );
    }

    return (
      <div className="px-2.5">
        <div className="group flex flex-col gap-1">
          <MarkdownRenderer
            content={markdownText}
            parseIncompleteMarkdown={parseIncompleteMarkdown}
          />
          {showAssistantMessageActions && (
            <div className="flex items-center gap-1">
              <ThreadMessageActionRow align="start">
                <CopyMessageActionButton text={markdownText} />
              </ThreadMessageActionRow>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (kind === "userInputRequest") {
    const questions = item.userInputQuestions ?? [];
    const answersByQuestion = item.userInputAnswers ?? {};
    const hasAnyAnswer = questions.some((question) => (answersByQuestion[question.id]?.length ?? 0) > 0);
    if (!hasAnyAnswer) return null;

    return (
      <div className="px-2.5">
        <UserInputTranscriptView item={item} />
      </div>
    );
  }

  if (item.markdownText) {
    return (
      <div className="px-2.5">
        <p className="text-sm/reading whitespace-pre-wrap text-(--foreground-secondary)">{item.markdownText}</p>
      </div>
    );
  }

  if (item.rawItem) {
    return (
      <div className="px-2.5">
        <div className="rounded-lg border border-(--border) bg-(--background-secondary) px-2.5 py-1.5">
          <div className="mb-0.5 text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">
            System event
          </div>
          <JsonBlock value={item.rawItem} />
        </div>
      </div>
    );
  }

  if (!isLatestTurn) {
    return null;
  }

  return (
    <div className="px-2.5 text-sm text-(--foreground-tertiary)">
      {isStreamingTurn ? "Working..." : "No renderable content."}
    </div>
  );
}
