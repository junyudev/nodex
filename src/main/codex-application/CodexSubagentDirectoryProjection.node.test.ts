import { describe, expect, test } from "vitest";
import {
  projectCodexSubagentOverviewWindow,
  type CoreSubagentOverviewLike,
  type CoreSubagentOverviewThreadLike,
} from "./CodexSubagentDirectoryProjection";

const thread: CoreSubagentOverviewThreadLike = {
  thread_id: "child",
  parent_thread_id: "root",
  thread_preview: "Stored preview",
  agent_nickname: "@Scout",
  agent_role: "explorer",
  archived: false,
  created_at: 80,
  updated_at: 120,
  recency_at: 100,
  status: { status_type: "notLoaded" },
};
function overview(
  threads: CoreSubagentOverviewThreadLike[],
  complete = true,
): CoreSubagentOverviewLike {
  return {
    universe: { generation: 7, root_thread_id: "root" },
    active: { items: threads.map((thread) => ({ thread, status: "unknown" })) },
    done: { items: [] },
    known_active_count: threads.length,
    known_done_count: 0,
    discovery_complete: complete,
    projection_revision: 42,
  };
}
describe("subagent overview shared projection", () => {
  test("regroups runtime-notLoaded metadata into done and omits unnamed or archived rows", () => {
    const result = projectCodexSubagentOverviewWindow(
      overview([
        thread,
        { ...thread, thread_id: "unnamed", agent_nickname: null },
        { ...thread, thread_id: "archived", archived: true },
      ]),
    );
    expect(result.active.rows).toEqual([]);
    expect(result.done).toMatchObject({ knownCount: 1, totalCount: 1 });
    expect(result.done.rows[0]).toMatchObject({
      displayName: "Scout",
      status: "done",
      canInteract: false,
      canOpen: true,
      spawnModel: null,
    });
  });
  test("resident runtime overrides stored evidence and never leaks an answer body", () => {
    const result = projectCodexSubagentOverviewWindow(overview([thread]), () => false, {
      parentTurns: [],
      knownConversationsById: {
        child: {
          turns: [],
          threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
        },
      },
    });
    expect(result.active.rows[0]).toMatchObject({ status: "active", startedAtMs: 80 });
    expect(result.active.rows[0]).not.toHaveProperty("lastAssistantMessage");
    expect(result.active.rows[0]).not.toHaveProperty("turns");
  });
  test("incomplete discovery preserves a lower-bound total and uses active fallback only without runtime", () => {
    const result = projectCodexSubagentOverviewWindow(
      overview([{ ...thread, status: undefined }], false),
    );
    expect(result.active).toMatchObject({ knownCount: 1, totalCount: null });
    expect(result.active.rows[0]?.status).toBe("active");
  });
  test("runtime system error hides identity independently of durable done evidence", () => {
    const result = projectCodexSubagentOverviewWindow(
      overview([{ ...thread, status: { status_type: "systemError" } }]),
    );
    expect(result.active.rows).toEqual([]);
    expect(result.done.rows).toEqual([]);
  });
  test("source order prefers cached descendants while display sections sort recency", () => {
    const old = { ...thread, thread_id: "old", created_at: 1, recency_at: 1, updated_at: 1 };
    const recent = {
      ...thread,
      thread_id: "recent",
      created_at: 10,
      recency_at: 10,
      updated_at: 10,
    };
    const result = projectCodexSubagentOverviewWindow(overview([recent, old]), () => false, {
      parentTurns: [],
      knownConversationsById: { old: { turns: [] } },
      cachedConversationIds: ["old"],
      sourceLinkedThreadIds: ["recent", "old"],
    });
    expect(result.rows?.map((row) => row.threadId)).toEqual(["old", "recent"]);
    expect(result.done.rows.map((row) => row.threadId)).toEqual(["recent", "old"]);
  });
  test("conversation titles never replace agent nicknames or name an unnamed source child", () => {
    const result = projectCodexSubagentOverviewWindow(
      overview([
        { ...thread, thread_name: "Custom title" },
        { ...thread, thread_id: "unnamed", thread_name: "Another title", agent_nickname: null },
      ]),
    );
    expect(result.rows?.map((row) => row.displayName)).toEqual(["Scout", ""]);
    expect(result.done.rows.map((row) => row.threadId)).toEqual(["child"]);
  });
});
