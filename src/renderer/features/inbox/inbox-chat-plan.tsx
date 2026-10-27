import type { InboxDelegate } from "../../../shared/inbox";
import { CloseIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import { InboxAgentLabel, InboxAgentPicker, type InboxAgents } from "./inbox-agent-picker";
import { describeInboxAgent } from "./inbox-agent-model";

/**
 * How a planned new chat runs: each part its Agent hands to another, with that Agent's mark and
 * model, then the plan written to it. The strip reads it; the dispatch editor changes a part's
 * model or removes the part.
 */
export function InboxChatPlan({
  agents,
  delegates,
  plan,
  onChange,
}: {
  readonly agents: InboxAgents;
  readonly delegates: readonly InboxDelegate[];
  readonly plan: string | null;
  /** Present when the plan is being edited. */
  readonly onChange?: (next: { delegates: readonly InboxDelegate[]; plan: string | null }) => void;
}) {
  // Clearing the last part and the plan leaves a chat that runs as its prompt says.
  if (delegates.length === 0 && !plan) return null;
  const update = (patch: Partial<{ delegates: readonly InboxDelegate[]; plan: string | null }>) =>
    onChange?.({ delegates, plan, ...patch });
  return (
    <div
      data-testid="inbox-chat-plan"
      className="flex min-w-0 flex-col gap-1 text-[13px] leading-5 text-token-description-foreground"
    >
      {delegates.map((delegate, index) => (
        <div
          key={`${index}:${delegate.work}`}
          className={cn("flex min-h-6 min-w-0 items-center gap-1.5", onChange && "px-1")}
        >
          <span aria-hidden="true" className="shrink-0">
            ↳
          </span>
          <span className="line-clamp-2 min-w-0 flex-1 text-token-foreground">{delegate.work}</span>
          {onChange ? (
            <>
              <InboxAgentPicker
                agents={agents}
                purpose="chat"
                scope="delegate"
                value={delegate.agent}
                trigger="inline"
                onChange={(agent) =>
                  update({
                    delegates: delegates.map((entry, at) =>
                      at === index ? { ...entry, agent } : entry,
                    ),
                  })
                }
              />
              <button
                type="button"
                aria-label={`Do “${delegate.work}” without delegating`}
                onClick={() => update({ delegates: delegates.filter((_, at) => at !== index) })}
                className="cursor-interaction flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-token-list-hover-background hover:text-token-foreground"
              >
                <CloseIcon className="icon-2xs" />
              </button>
            </>
          ) : (
            <InboxAgentLabel
              presentation={describeInboxAgent(agents, delegate.agent)}
              className="max-w-[45%] shrink-0 gap-1"
            />
          )}
        </div>
      ))}
      {onChange ? (
        <textarea
          aria-label="Plan"
          rows={2}
          value={plan ?? ""}
          placeholder="How the chat’s Agent should run this work"
          onChange={(event) => update({ plan: event.currentTarget.value || null })}
          className="w-full resize-y rounded-xl bg-token-main-surface-primary px-3 py-1.5 text-[13px] leading-5 text-token-foreground outline-none shadow-[0_0_0_0.5px_var(--color-token-border)] placeholder:text-token-input-placeholder-foreground focus-visible:shadow-[0_0_0_1px_var(--color-token-focus-border)]"
        />
      ) : plan ? (
        <p className="line-clamp-3 min-w-0 whitespace-pre-line">{plan}</p>
      ) : null}
    </div>
  );
}
