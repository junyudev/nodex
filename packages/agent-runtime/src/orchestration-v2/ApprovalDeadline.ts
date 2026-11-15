import type { OrchestrationV2TurnItem } from "@nodex/runtime-contracts";

/**
 * A settled approval has no deadline. The field is removed, not set to `undefined`, so
 * an emitted event equals the form the event store reads back for a replayed command.
 */
export const withoutAutoDeclineDeadline = (
  item: OrchestrationV2TurnItem,
): OrchestrationV2TurnItem => {
  if (item.type !== "approval_request") return item;
  const { autoDeclineAt: _deadline, ...settled } = item;
  return settled;
};
