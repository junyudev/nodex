import { CORE_CLIENT_REQUIREMENTS } from "@nodex/core-protocol";
import type { ProjectWorkspaceReadSnapshot } from "../types";

const timestamp = "2026-01-01T00:00:00.000Z";
const contractVersion = CORE_CLIENT_REQUIREMENTS.modules.find(
  ({ module }) => module === "project_workspace",
)!.contract_version;

export const codexLinkedRootSessionFixture = ({
  threadId,
  sessionId,
  hostId = "local",
  projectId = null,
  threadSource = null,
  title = "Chat",
}: {
  readonly threadId: string;
  readonly sessionId: string;
  readonly hostId?: string;
  readonly projectId?: string | null;
  readonly threadSource?: string | null;
  readonly title?: string;
}): ProjectWorkspaceReadSnapshot => ({
  commit_head: 0,
  contract_version: contractVersion,
  store_epoch: "epoch",
  value: {
    kind: "codex_thread_session",
    thread: {
      archived: false,
      backend_binding: { kind: "codex" },
      created_at: 0,
      dynamic_tool_catalogs: [],
      execution_host_id: hostId,
      has_unread_turn: false,
      linked_at: timestamp,
      project_id: projectId,
      recency_at: 0,
      session_id: sessionId,
      status: { status_type: "idle", active_flags: [] },
      thread_id: threadId,
      thread_preview: "",
      thread_source: threadSource,
      updated_at: 0,
      writable_roots: [],
    },
    session: {
      activity_at: 0,
      archived: false,
      can_manage: true,
      can_stop: true,
      created_at: timestamp,
      display_title: title,
      id: sessionId,
      managed: false,
      no_thread_fallback_title: title,
      pinned: false,
      project_id: projectId,
      thread_id: threadId,
      unread: false,
      updated_at: timestamp,
    },
  },
});
