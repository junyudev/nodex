import { sameExecutionHoldScope } from "../../shared/work-application";
import * as Effect from "effect/Effect";
import type { components } from "@nodex/core-protocol";
import type { CoreModuleClients } from "../../main/core-runtime/CoreModules";
export type HoldTarget = components["schemas"]["ExecutionHoldTarget"];
export const effectiveHolds = Effect.fn("ExecutionHolds.effective")(function* (
  core: CoreModuleClients,
  target: HoldTarget,
) {
  const result = yield* core.workspace.read(
    { kind: "effective_execution_hold", target },
    undefined,
    null,
  );
  if (result.value.kind !== "effective_execution_hold")
    return yield* Effect.die(new Error("Execution hold read is unavailable"));
  return result.value.holds;
});
export const spaceHeld = Effect.fn("ExecutionHolds.spaceHeld")(function* (core: CoreModuleClients) {
  const result = yield* core.workspace.read(
    { kind: "execution_holds", after_key: "space:", limit: 1 },
    undefined,
    null,
  );
  if (result.value.kind !== "execution_holds")
    return yield* Effect.die(new Error("Execution hold read is unavailable"));
  return result.value.holds.some((h) => h.scope.kind === "space");
});
/** Resolve Core policy before Runtime startup recovery can acquire a permit. */
export const heldThreadIds = Effect.fn("ExecutionHolds.heldThreadIds")(function* (
  core: CoreModuleClients,
) {
  const roots: string[] = [];
  let after: string | null = null;
  do {
    const result: import("../../main/core-client/types").ProjectWorkspaceReadSnapshot =
      yield* core.workspace.read(
        { kind: "held_session_window", after_session_id: after, limit: 100 },
        undefined,
        null,
      );
    if (result.value.kind !== "held_session_window")
      return yield* Effect.die(new Error("Held Session read is unavailable"));
    for (const session of result.value.session_ids) {
      const found = yield* core.workspace.read(
        { kind: "agent_runtime_session_binding", session_id: session },
        undefined,
        null,
      );
      if (found.value.kind === "agent_runtime_session_binding" && found.value.binding)
        roots.push(found.value.binding.runtime_thread_id);
    }
    after = result.value.session_ids.length === 100 ? result.value.session_ids.at(-1)! : null;
  } while (after);
  return roots;
});

export const scopeHeld = Effect.fn("ExecutionHolds.scopeHeld")(function* (
  core: CoreModuleClients,
  scope: components["schemas"]["ExecutionHoldScope"],
) {
  let after: string | null = null;
  do {
    const result: import("../../main/core-client/types").ProjectWorkspaceReadSnapshot =
      yield* core.workspace.read(
        { kind: "execution_holds", after_key: after, limit: 100 },
        undefined,
        null,
      );
    if (result.value.kind !== "execution_holds")
      return yield* Effect.die(new Error("Execution holds are unavailable"));
    if (result.value.holds.some((h) => sameExecutionHoldScope(h.scope, scope))) return true;
    after = result.value.next_key ?? null;
  } while (after);
  return false;
});
