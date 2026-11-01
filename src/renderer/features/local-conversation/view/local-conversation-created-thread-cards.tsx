import { useState } from "react";
import { CreatedTaskIcon } from "@/components/shared/icons";
import type { CodexCreatedThreadResult } from "../../../../shared/codex-created-thread-result";
import type { ThreadStageActions } from "../thread-stage-types";
import { useCreatedThreadCardState } from "../use-created-thread-card-state";
import { CodexShimmerText } from "./shared/codex-shimmer-text";
import {
  ThreadResourceCard,
  ThreadResourceCardGrid,
  ThreadResourceCardMore,
} from "./shared/thread-resource-card";

function CreatedThreadCard({
  result,
  onOpenThread,
  sourceRoot,
}: {
  readonly result: CodexCreatedThreadResult;
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
  readonly sourceRoot?: { readonly hostId: string; readonly threadId: string };
}) {
  const state = useCreatedThreadCardState(result);
  const id = "threadId" in result ? result.threadId : result.clientThreadId;
  const title = state.title || ("clientThreadId" in result ? "Worktree chat" : "Created chat");
  return (
    <ThreadResourceCard
      aria-label={`Open chat: ${title}`}
      icon={<CreatedTaskIcon className="icon-sm" aria-hidden />}
      title={title}
      detail={
        state.isWorking ? (
          <CodexShimmerText className="text-sm">Working</CodexShimmerText>
        ) : state.text ? (
          <span className="line-clamp-2 text-sm text-token-text-secondary">{state.text}</span>
        ) : null
      }
      onClick={() => void onOpenThread?.(id, { createdTarget: result, sourceRoot })}
    />
  );
}

/** Hidden results have no mounted card or summary observer. */
export function LocalConversationCreatedThreadCards({
  results,
  onOpenThread,
  sourceRoot,
}: {
  readonly results: readonly CodexCreatedThreadResult[];
  readonly onOpenThread?: ThreadStageActions["onOpenThread"];
  readonly sourceRoot?: { readonly hostId: string; readonly threadId: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const supported = results.filter((result) => result.kind !== "chatgpt");
  if (supported.length === 0) return null;
  const visible = !expanded && supported.length > 4 ? supported.slice(0, 3) : supported;
  const hidden = supported.length - visible.length;
  return (
    <div data-content-search-skip="true" className="flex flex-col gap-2">
      <ThreadResourceCardGrid>
        {visible.map((result, index) => (
          <CreatedThreadCard
            key={`${"threadId" in result ? result.threadId : result.clientThreadId}:${index}`}
            result={result}
            onOpenThread={onOpenThread}
            sourceRoot={sourceRoot}
          />
        ))}
      </ThreadResourceCardGrid>
      {supported.length > 4 ? (
        <ThreadResourceCardMore
          expanded={expanded}
          label={expanded ? "Show fewer chats" : `Show ${hidden} more chats`}
          onClick={() => setExpanded((current) => !current)}
        />
      ) : null}
    </div>
  );
}
