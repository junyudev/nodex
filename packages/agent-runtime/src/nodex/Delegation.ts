import type { OrchestrationV2AppThread, ThreadId } from "@nodex/runtime-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/**
 * Who kept a subagent from delegating. The conversation leader always may; a subagent may unless
 * the Agent that delegated it said otherwise, then as the person chose for the conversation, then
 * as the Profile setting says.
 */
export type DelegationRefusal = "delegator" | "conversation" | "settings";

type Caller = Pick<OrchestrationV2AppThread, "lineage" | "mayDelegate">;
type Lead = Pick<OrchestrationV2AppThread, "subagentsMayDelegate">;

export const delegationRefusal = (input: {
  readonly caller: Caller;
  /** The caller's conversation lead; null when it is no longer readable. */
  readonly lead: Lead | null;
  readonly subagentsMayDelegate: boolean;
}): DelegationRefusal | null => {
  if (input.caller.lineage.relationshipToParent !== "subagent") return null;
  if (input.caller.mayDelegate === false) return "delegator";
  const chosen = input.lead?.subagentsMayDelegate;
  if (chosen !== undefined) return chosen ? null : "conversation";
  return input.subagentsMayDelegate ? null : "settings";
};

const NEXT_STEP =
  "Do the work yourself, and say in your result what else would need another Agent.";

/** What a refused Agent reads; it names who decided so the Agent does not retry another way. */
export const DELEGATION_REFUSAL_MESSAGE: Record<DelegationRefusal, string> = {
  delegator: `The Agent that delegated this task asked that it not delegate further. ${NEXT_STEP}`,
  conversation: `The person turned off delegation by subagents in this conversation. ${NEXT_STEP}`,
  settings: `The person turned off delegation by subagents in Settings. ${NEXT_STEP}`,
};

const service = (
  current: Effect.Effect<boolean>,
  replace: (subagentsMayDelegate: boolean) => Effect.Effect<void>,
) => ({
  /** The Profile setting: whether subagents may delegate where a conversation has not chosen. */
  subagentsMayDelegate: current,
  replace,
});

/** The Profile's delegation setting, replaced live as the person changes it. */
export const RuntimeDelegation = Context.Reference<ReturnType<typeof service>>(
  "nodex/RuntimeDelegation",
  { defaultValue: () => service(Effect.succeed(true), () => Effect.void) },
);

export const make = Effect.fn("RuntimeDelegation.make")(function* (subagentsMayDelegate: boolean) {
  const state = yield* Ref.make(subagentsMayDelegate);
  return service(Ref.get(state), (next) => Ref.set(state, next));
});

/** Reads the caller's lead only for a subagent, since a lead and other Threads always may. */
export const refusalOf = <E, R>(
  caller: Caller & Pick<OrchestrationV2AppThread, "id">,
  readLead: (threadId: ThreadId) => Effect.Effect<Lead | null, E, R>,
): Effect.Effect<DelegationRefusal | null, never, R> =>
  Effect.gen(function* () {
    if (caller.lineage.relationshipToParent !== "subagent") return null;
    const lead = yield* readLead(caller.lineage.rootThreadId).pipe(
      Effect.orElseSucceed(() => null),
    );
    const { subagentsMayDelegate } = yield* RuntimeDelegation;
    return delegationRefusal({
      caller,
      lead,
      subagentsMayDelegate: yield* subagentsMayDelegate,
    });
  });
