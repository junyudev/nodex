import { useState } from "react";
import { CreatedTaskIcon } from "@/components/shared/icons";
import type { CodexCreatedThreadResult } from "../../../../shared/codex-created-thread-result";
import type { ThreadStageActions } from "../thread-stage-types";
import { useCreatedThreadCardState } from "../use-created-thread-card-state";
import { CodexShimmerText } from "./shared/codex-shimmer-text";

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
    <button
      type="button"
      aria-label={`Open chat: ${title}`}
      className="flex min-w-0 items-center gap-3 rounded-lg border-[0.5px] border-token-border p-3 text-left hover:bg-token-list-hover-background focus-visible:outline-2 focus-visible:outline-token-focus-border"
      onClick={() => void onOpenThread?.(id, { createdTarget: result, sourceRoot })}
    >
      <CreatedTaskIcon className="icon-sm shrink-0 text-token-text-secondary" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-token-foreground">{title}</span>
        {state.isWorking ? (
          <CodexShimmerText className="text-sm">Working</CodexShimmerText>
        ) : state.text ? (
          <span className="line-clamp-2 text-sm text-token-text-secondary">{state.text}</span>
        ) : null}
      </span>
    </button>
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
      <div className="grid grid-cols-1 gap-2 @lg/thread-content:grid-cols-2">
        {visible.map((result, index) => (
          <CreatedThreadCard
            key={`${"threadId" in result ? result.threadId : result.clientThreadId}:${index}`}
            result={result}
            onOpenThread={onOpenThread}
            sourceRoot={sourceRoot}
          />
        ))}
      </div>
      {supported.length > 4 ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="self-start text-sm text-token-text-secondary hover:text-token-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show fewer chats" : `Show ${hidden} more chats`}
        </button>
      ) : null}
    </div>
  );
}
