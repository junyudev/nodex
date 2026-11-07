import { enablePatches, produceWithPatches } from "immer";
import { expect, test } from "vite-plus/test";
import {
  applyCodexActiveHistoryEviction,
  planCodexActiveHistoryEviction,
} from "../../../shared/codex-conversation-state/codex-active-history-eviction";
import { buildActiveHistoryFixture } from "../../../shared/codex-conversation-state/test-fixtures/active-history";
import {
  projectCodexTranscript,
  projectCodexTranscriptUpdate,
} from "../../../shared/codex-transcript-projection";
import { CodexTranscriptReadOwner } from "./normalized-transcript-read-owner";

enablePatches();

const key = { hostId: "local", threadId: "thread" };
const capabilities = {
  supportsThreadItemAnchors: true,
  supportsPaginatedThreadHistory: true,
  isFollower: false,
  hasFollowersOrPendingReconnect: false,
};

test("a release reaches transcript readers as removed Turns, cut items and an older gap", () => {
  const before = buildActiveHistoryFixture([300, 300, 300, 300]);
  const owner = new CodexTranscriptReadOwner(key);
  owner.applyEvent({ type: "reset", value: projectCodexTranscript(before) });
  expect(owner.readItem("entity-0", "item-0-0")).not.toBeNull();

  const plan = planCodexActiveHistoryEviction(before, [], capabilities)!;
  const [after, patches] = produceWithPatches(before, (draft) =>
    applyCodexActiveHistoryEviction(draft, plan, "older-turns"),
  );
  owner.applyEvent(projectCodexTranscriptUpdate(key, before, after, { patches })!);

  const structure = owner.readStructure()!;
  expect(structure.turnEntityKeys).toEqual(["entity-2", "entity-3"]);
  expect(structure.timeline?.[0]).toMatchObject({ kind: "gap" });
  expect(structure.historyComplete).toBe(false);
  expect(owner.readItem("entity-0", "item-0-0")).toBeNull();
  expect(owner.readItem("entity-2", "item-2-99")).toBeNull();
  expect(owner.readItem("entity-2", "item-2-100")).not.toBeNull();
  expect(owner.readItemSlots("entity-2")?.length).toBe(200);
  expect(owner.readTurnDetails("entity-2")?.itemsPagination).toMatchObject({
    olderCursor: { type: "item", itemId: "item-2-100" },
    hasLoadedOldest: false,
  });
});
