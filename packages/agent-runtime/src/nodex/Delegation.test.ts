import { assert, it } from "@effect/vitest";
import { ThreadId } from "@nodex/runtime-contracts";
import { delegationRefusal } from "./Delegation.ts";

const lead = ThreadId.make("lead");
const leadLineage = { parentThreadId: null, relationshipToParent: null, rootThreadId: lead };
const subagentLineage = {
  parentThreadId: lead,
  relationshipToParent: "subagent" as const,
  rootThreadId: lead,
};

it.each([
  // The conversation's lead always delegates, whatever its subagents may do.
  { caller: { lineage: leadLineage }, chosen: false, settings: false, refusal: null },
  // A fork leads its own conversation.
  {
    caller: { lineage: { ...leadLineage, relationshipToParent: "fork" as const } },
    chosen: undefined,
    settings: false,
    refusal: null,
  },
  { caller: { lineage: subagentLineage }, chosen: undefined, settings: true, refusal: null },
  { caller: { lineage: subagentLineage }, chosen: undefined, settings: false, refusal: "settings" },
  // The conversation's choice outranks Settings in both directions.
  { caller: { lineage: subagentLineage }, chosen: true, settings: false, refusal: null },
  { caller: { lineage: subagentLineage }, chosen: false, settings: true, refusal: "conversation" },
  // A delegator can only narrow, and its word comes first.
  {
    caller: { lineage: subagentLineage, mayDelegate: false },
    chosen: true,
    settings: true,
    refusal: "delegator",
  },
] as const)("refusal for $caller.lineage.relationshipToParent: $refusal", (row) => {
  assert.strictEqual(
    delegationRefusal({
      caller: row.caller,
      lead: row.chosen === undefined ? {} : { subagentsMayDelegate: row.chosen },
      subagentsMayDelegate: row.settings,
    }),
    row.refusal,
  );
});

it("an unreadable lead follows Settings", () => {
  assert.strictEqual(
    delegationRefusal({
      caller: { lineage: subagentLineage },
      lead: null,
      subagentsMayDelegate: false,
    }),
    "settings",
  );
});
