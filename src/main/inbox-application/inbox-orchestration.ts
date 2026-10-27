import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { isAgentRuntimeEffortOption } from "../../shared/agent-runtime-provider";
import { resolveInboxModel, type InboxDelegate } from "../../shared/inbox";

type Provider = AgentRuntimeOperations["providers.read"]["output"][number];

/** A delegated part with the exact `delegate_task` target Nodex resolved for it. */
interface ResolvedDelegate {
  readonly work: string;
  readonly target: {
    readonly providerInstanceId: string;
    readonly model?: string;
    readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
  };
  readonly label: string;
  readonly available: boolean;
}

const resolveDelegate = (
  providers: readonly Provider[],
  delegate: InboxDelegate,
): ResolvedDelegate => {
  const resolution = resolveInboxModel(providers, delegate.agent, "chat");
  if (resolution.kind !== "ready")
    return {
      work: delegate.work,
      target: {
        providerInstanceId: delegate.agent.instanceId,
        ...(delegate.agent.model ? { model: delegate.agent.model } : {}),
      },
      label: [delegate.agent.instanceId, delegate.agent.model].filter(Boolean).join(" · "),
      available: false,
    };
  const { provider, model, selection } = resolution;
  const effortId = model.capabilities?.optionDescriptors?.find(isAgentRuntimeEffortOption)?.id;
  const effort = selection.options?.find((option) => option.id === effortId)?.value;
  return {
    work: delegate.work,
    target: {
      providerInstanceId: selection.instanceId,
      model: selection.model,
      ...(selection.options?.length ? { options: selection.options } : {}),
    },
    label: [
      provider.displayName ?? provider.instanceId,
      model.name,
      typeof effort === "string" ? effort : null,
    ]
      .filter(Boolean)
      .join(" · "),
    available: true,
  };
};

/**
 * The instructions a planned new chat's Agent reads after its task: the plan in its author's
 * words, then each delegated part with the exact `delegate_task` target Nodex resolved against
 * the live catalog. A part whose target cannot run now still reaches the Agent, which can pick
 * another with `list_agent_models` or do the part itself. Null when nothing was planned.
 */
export function renderInboxOrchestration(
  providers: readonly Provider[],
  plan: { readonly delegates: readonly InboxDelegate[]; readonly plan: string | null },
  /** The Agent the chat itself runs on; a part on that same Agent may run as its own subagent. */
  leadInstanceId: string | null = null,
): string | null {
  const delegates = plan.delegates.map((delegate) => resolveDelegate(providers, delegate));
  const sections: string[] = [];
  if (plan.plan?.trim()) sections.push(`How to run this work:\n${plan.plan.trim()}`);
  if (delegates.length > 0)
    sections.push(
      [
        "Delegate these parts with the Nodex `delegate_task` tool, one task each, using the target shown. Give every task a self-contained prompt with the context it needs, keep integration and the final review yourself, and adapt if a part turns out not to fit.",
        ...delegates.map(
          (delegate, index) =>
            `${index + 1}. ${delegate.work}\n   target: ${JSON.stringify(delegate.target)} (${delegate.label})${
              delegate.available
                ? delegate.target.providerInstanceId === leadInstanceId
                  ? "\n   This target is your own Agent; your own subagents may run it instead when they can use this model."
                  : ""
                : "\n   This target was unavailable when the chat started; choose another with `list_agent_models` or do this part yourself."
            }`,
        ),
      ].join("\n"),
    );
  return sections.length > 0 ? sections.join("\n\n") : null;
}
