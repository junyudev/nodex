import { describe, expect, test } from "vitest";
import {
  projectCodexSubagentOverviewRow,
  projectCodexSubagentOverviewWindow,
} from "./CodexSubagentDirectoryProjection";

const thread = {
  thread_id: "019agent",
  parent_thread_id: "root",
  thread_name: null,
  thread_preview:
    "  Investigate    renderer subscription pressure and return only the actionable findings.  ",
  model_provider: "openai",
  model_id: "gpt-5.6-sol",
  agent_nickname: "@Scout",
  agent_role: "explorer",
  agent_path: "root/scout",
  archived: false,
  created_at: 80,
  updated_at: 120,
  recency_at: 100,
};

describe("CodexSubagentDirectoryProjection", () => {
  test("projects only lightweight row metadata and never exposes an answer body", () => {
    const row = projectCodexSubagentOverviewRow({ thread, status: "active" });
    expect(row).toMatchObject({
      threadId: "019agent",
      displayName: "Scout",
      objective: "Investigate renderer subscription pressure and return only…",
      statusSummary: "Working",
      lastActivityAtMs: 120,
      canOpen: true,
      canInteract: true,
    });
    expect(row).not.toHaveProperty("conversation");
    expect(row).not.toHaveProperty("transcript");
  });

  test("publishes unknown rows in the active window without claiming an incomplete total", () => {
    const window = projectCodexSubagentOverviewWindow({
      universe: { generation: 7, root_thread_id: "root" },
      active: { items: [{ thread, status: "unknown" }], next_cursor: "active-next" },
      done: { items: [], next_cursor: null },
      known_active_count: 20,
      known_done_count: 0,
      discovery_complete: false,
      discovery_continuation: "discovery-next",
      projection_revision: 42,
    });

    expect(window).toMatchObject({
      rootThreadId: "root",
      revision: 42,
      generation: 7,
      completeness: "incomplete",
      active: { knownCount: 20, totalCount: null, continuation: "active-next" },
      done: { knownCount: 0, totalCount: null, continuation: null },
    });
    expect(window.active.rows[0]?.status).toBe("unknown");
  });

  test("keeps completed children interactive until Thread authority is revoked", () => {
    expect(projectCodexSubagentOverviewRow({ thread, status: "done" })).toMatchObject({
      status: "done",
      canOpen: true,
      canInteract: true,
    });
    expect(
      projectCodexSubagentOverviewRow({
        thread: { ...thread, archived: true },
        status: "done",
      }),
    ).toMatchObject({
      status: "done",
      canOpen: false,
      canInteract: false,
    });
  });
});
