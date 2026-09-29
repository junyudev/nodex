import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentToolOutputReference } from "../../../../../../shared/agent-tool-output";
import { useConversationToolOutputReader } from "../../conversation-tool-output-context";

/** Full output is an explicit owner query, never another resident transcript copy. */
export function LazyToolOutput({ reference }: { reference: AgentToolOutputReference }) {
  const { readToolOutput: read, conversationId } = useConversationToolOutputReader();
  const [expanded, setExpanded] = useState(false);
  // The owner function is authority; the conversation and exact native tuple are content identity.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const query = useQuery({
    queryKey: [
      "agent-tool-output",
      conversationId,
      reference.sessionId,
      reference.nativeMessageId,
      reference.toolUseId,
    ],
    enabled: expanded && Boolean(read),
    staleTime: Infinity,
    gcTime: 30_000,
    retry: false,
    queryFn: () => {
      if (!read) throw new Error("Tool output is unavailable");
      return read(reference);
    },
  });
  if (!read) return null;
  return (
    <div className="px-3 py-1 text-xs">
      <button
        type="button"
        className="text-token-text-secondary hover:text-token-text-primary"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "Hide full output" : "Show full output"}
      </button>
      {expanded ? (
        query.isPending ? (
          <p className="text-token-text-secondary">Loading…</p>
        ) : query.error ? (
          <button
            type="button"
            className="text-token-text-secondary"
            onClick={() => {
              void query.refetch();
            }}
          >
            Retry output
          </button>
        ) : query.data ? (
          <>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-token-text-primary">
              {query.data.text}
            </pre>
            {query.data.truncated ? (
              <p className="text-token-text-secondary">
                Output exceeds the display limit ({query.data.originalBytes.toLocaleString()} bytes)
              </p>
            ) : null}
          </>
        ) : null
      ) : null}
    </div>
  );
}
