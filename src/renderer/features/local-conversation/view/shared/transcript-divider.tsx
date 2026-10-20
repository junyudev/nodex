import { Fragment, useSyncExternalStore, type ReactNode } from "react";
import { AgentProviderIcon } from "@/components/shared/icons/provider-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
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

type AgentHandoffNotice = Extract<CodexRuntimeNotice, { kind: "agentHandoff" }>;

const HANDOFF_CARRIED: Record<AgentHandoffNotice["carried"], string> = {
  conversation: "Carried the conversation so far.",
  missed: "Carried only the turns this Agent missed.",
  fork: "Carried the fork's work since it branched from this chat.",
  checkpoint: "Carried a summary of the conversation so far.",
  imported: "Carried the imported conversation history.",
};

/**
 * Where the chat continued on another Agent. What was carried explains itself on hover and to
 * screen readers; the carried history stays with the Agent Runtime and the transcript shows it.
 */
export function AgentHandoffDivider({ notice }: { readonly notice: AgentHandoffNotice }) {
  const { to } = notice;
  const from = notice.from.filter(
    (agent) => agent.providerInstanceId !== to.providerInstanceId || agent.model !== to.model,
  );
  const label = notice.carried === "fork" ? "Fork merged back" : "Context handoff";
  const detail = notice.failed
    ? "The handoff failed; the Agent may not have the earlier conversation."
    : `${HANDOFF_CARRIED[notice.carried]} Longer history stays readable to the Agent.`;
  return (
    <TranscriptDivider data-runtime-notice="agentHandoff">
      <NodexTooltip tooltipContent={detail}>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex min-w-0 items-center gap-1 rounded-sm focus-visible:outline-2",
            notice.failed && "text-token-charts-red",
          )}
        >
          <span>{notice.failed ? `${label} failed` : label}</span>
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
          <span className="sr-only">{detail}</span>
        </span>
      </NodexTooltip>
    </TranscriptDivider>
  );
}
