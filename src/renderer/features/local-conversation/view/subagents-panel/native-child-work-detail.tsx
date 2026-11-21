import { useQuery } from "@tanstack/react-query";
import { FormattedMessage } from "@/lib/i18n";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { spaceQueryKey } from "@/lib/renderer-space";
import type {
  AgentRuntimeNativeChildWork,
  AgentRuntimeNativeChildWorkTarget,
} from "../../../../../shared/agent-runtime-api";
import { ThreadActivityHeader, ThreadActivityShell } from "../shared/tools/tool-primitives";
import { TerminalActivityIcon } from "@/components/shared/icons";

type Child = AgentRuntimeNativeChildWork["children"][number];

function NativeChildSteps({ child }: { readonly child: Child }) {
  if (!child.steps?.length)
    return (
      <p className="text-token-description-foreground">
        <FormattedMessage
          id="conversation.nativeChildWork.noTranscript"
          defaultMessage="No transcript yet."
        />
      </p>
    );
  return (
    <ol className="flex flex-col gap-3">
      {child.steps.map((step) => (
        <li key={step.index}>
          <ThreadActivityShell
            className="gap-1"
            header={
              <ThreadActivityHeader>
                <span className="text-token-text-secondary">{step.type.replaceAll("_", " ")}</span>
                {step.status ? (
                  <span className="text-token-description-foreground">{step.status}</span>
                ) : null}
              </ThreadActivityHeader>
            }
            body={
              <>
                {step.text ? (
                  <p className="whitespace-pre-wrap wrap-anywhere">{step.text}</p>
                ) : null}
                {step.toolCalls.map((call, index) => (
                  <ThreadActivityHeader key={`${index}:${call.name}`}>
                    <TerminalActivityIcon className="icon-xs shrink-0 text-token-description-foreground" />
                    <span className="shrink-0">{call.name}</span>
                    <span className="truncate text-token-description-foreground">{call.input}</span>
                  </ThreadActivityHeader>
                ))}
              </>
            }
          />
        </li>
      ))}
    </ol>
  );
}

/** The selected provider-owned batch is a read-only detail view in the Subagents tab. */
export function NativeChildWorkDetail({ sessionId, threadId }: AgentRuntimeNativeChildWorkTarget) {
  const work = useQuery({
    queryKey: spaceQueryKey(["agent-runtime", "native-child-work", sessionId, threadId]),
    queryFn: () => agentRuntimeRuntime.nativeChildWork({ sessionId, threadId }),
    refetchOnMount: "always",
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3 text-size-chat">
      {work.isPending ? (
        <p role="status" className="text-token-description-foreground">
          <FormattedMessage
            id="conversation.nativeChildWork.loading"
            defaultMessage="Loading subagent work…"
          />
        </p>
      ) : work.isError ? (
        <div
          role="status"
          className="flex flex-wrap items-baseline gap-x-2 text-token-text-secondary"
        >
          <FormattedMessage
            id="conversation.nativeChildWork.loadFailed"
            defaultMessage="Couldn’t load subagent work."
          />
          <button
            type="button"
            className="cursor-interaction text-token-foreground underline"
            onClick={() => void work.refetch()}
          >
            <FormattedMessage
              id="conversation.agentRuntimeConversationAdapter.retry"
              defaultMessage="Retry"
            />
          </button>
        </div>
      ) : work.data.children.length === 0 ? (
        <p className="text-token-description-foreground">
          <FormattedMessage
            id="conversation.nativeChildWork.unknown"
            defaultMessage="Antigravity has no record of which subagents this call started."
          />
        </p>
      ) : (
        work.data.children.map((child) => (
          <section
            key={child.conversationId}
            className="flex flex-col gap-2 border-b border-default pb-4 last:border-b-0"
          >
            <h3 className="font-medium wrap-anywhere">
              {child.role.trim() || (
                <FormattedMessage
                  id="conversation.agentRuntimeSubagentOverview.subagent"
                  defaultMessage="Subagent"
                />
              )}
            </h3>
            {child.prompt.trim() ? (
              <p className="whitespace-pre-wrap wrap-anywhere text-token-text-secondary">
                {child.prompt}
              </p>
            ) : null}
            {child.truncated ? (
              <p className="text-token-description-foreground">
                <FormattedMessage
                  id="conversation.nativeChildWork.truncated"
                  defaultMessage="Earlier steps were omitted."
                />
              </p>
            ) : null}
            <NativeChildSteps child={child} />
          </section>
        ))
      )}
    </div>
  );
}
