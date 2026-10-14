import { useLayoutEffect, useMemo, useState } from "react";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useConversationMarkdownSource } from "../../conversation-markdown-source";

function createTaskLease() {
  let current: object | null = null;
  return {
    activate(identity: object) {
      current = identity;
      return () => {
        if (current === identity) current = null;
      };
    },
    matches: (identity: object) => current === identity,
  };
}

/** Suggestions only prepare another draft; execution remains an explicit Composer action. */
export function ConversationTaskSuggestion({
  title,
  prompt,
  raw,
}: {
  readonly title: string;
  readonly prompt: string;
  readonly raw: string;
}) {
  const source = useConversationMarkdownSource();
  const [lease] = useState(createTaskLease);
  const identity = useMemo(() => ({ source, title, prompt }), [source, title, prompt]);
  useLayoutEffect(() => lease.activate(identity), [lease, identity]);
  const isCurrent = () => lease.matches(identity) && source?.isCurrent() === true;
  const prefill = source?.onStartNewChatWithPrompt;
  if (!source || !prefill) return raw;
  return (
    <div className="my-3 flex items-center gap-3 rounded-xl px-3 py-3 ring-[0.5px] ring-inset ring-token-border">
      <div className="min-w-0 flex-1">
        <span className="text-tertiary text-sm">Suggested task</span>
        <div className="text-sm font-medium">{title}</div>
      </div>
      <NodexButton
        variant="outline"
        size="sm"
        onClick={() => {
          if (!isCurrent()) return;
          void prefill({ projectId: source.projectId, prompt, isSourceCurrent: isCurrent }).catch(
            (error: unknown) => {
              if (isCurrent())
                toast.danger(
                  error instanceof Error ? error.message : "Could not open the suggested draft",
                );
            },
          );
        }}
      >
        Use suggestion
      </NodexButton>
    </div>
  );
}
