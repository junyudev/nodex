import { Fragment, useSyncExternalStore, type ReactNode } from "react";
import { AgentProviderIcon } from "@/components/shared/icons/provider-icons";
import type {
  CodexRuntimeNotice,
  CodexRuntimeNoticeAgent,
} from "../../../../../shared/codex-conversation-state/codex-conversation-state";
import { useConversationRuntimeOverride } from "../../conversation-runtime";

/** A conversation-level event between Turns, centered on a rule across the transcript. */
export function TranscriptDivider({
  children,
  ...props
}: { readonly children: ReactNode } & { readonly [data: `data-${string}`]: string }) {
  return (
    <div
      className="text-size-chat my-2 flex items-center gap-2 text-token-text-secondary"
      {...props}
    >
      <div className="flex-1 border-t border-current/20" />
      <div className="flex min-w-0 items-center gap-1 whitespace-nowrap">{children}</div>
      <div className="flex-1 border-t border-current/20" />
    </div>
  );
}

const noSubscription = () => () => {};

/** Names a configured Agent and model; a catalog that loads later renames it in place. */
function HandoffAgent({ agent }: { readonly agent: CodexRuntimeNoticeAgent }) {
  const labels = useConversationRuntimeOverride()?.agentLabels;
  const subscribe = labels?.subscribe ?? noSubscription;
  const label = useSyncExternalStore(
    subscribe,
    () => labels?.label(agent.providerInstanceId, agent.model) ?? null,
  );
  const kind = useSyncExternalStore(
    subscribe,
    () => labels?.kind(agent.providerInstanceId) ?? null,
  );
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-token-text-primary">
      {kind ? <AgentProviderIcon kind={kind} className="size-3 shrink-0" /> : null}
      <span className="truncate">{label ?? "Agent"}</span>
    </span>
  );
}

/**
 * Where the chat continued on another Agent with the conversation so far. The carried history
 * stays with the Agent Runtime; the transcript already shows it.
 */
export function AgentHandoffDivider({
  notice,
}: {
  readonly notice: Extract<CodexRuntimeNotice, { kind: "agentHandoff" }>;
}) {
  const { to } = notice;
  const from = notice.from.filter(
    (agent) => agent.providerInstanceId !== to.providerInstanceId || agent.model !== to.model,
  );
  return (
    <TranscriptDivider data-runtime-notice="agentHandoff">
      <span>Context handoff</span>
      <span aria-hidden="true">·</span>
      {from.map((agent, index) => (
        <Fragment key={`${agent.providerInstanceId}\0${agent.model ?? ""}`}>
          {index > 0 ? <span aria-hidden="true">,</span> : null}
          <HandoffAgent agent={agent} />
        </Fragment>
      ))}
      {from.length > 0 ? (
        <>
          <span aria-hidden="true">→</span>
          <span className="sr-only">to</span>
        </>
      ) : null}
      <HandoffAgent agent={to} />
    </TranscriptDivider>
  );
}
