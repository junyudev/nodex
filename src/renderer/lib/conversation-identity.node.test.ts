import { describe, expect, test } from "vite-plus/test";
import type { CodexThreadSummary } from "../../shared/types";
import { nativeConversationIdentity } from "./conversation-identity";

const summary = (overrides: Partial<CodexThreadSummary> = {}): CodexThreadSummary => ({
  threadId: "019a0000-0000-7000-8000-000000000001",
  projectId: "project",
  sessionId: "session",
  threadName: "Release notes",
  threadPreview: "Draft the notes",
  cwd: null,
  source: null,
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  linkedAt: "2026-11-01T00:00:00.000Z",
  executionProfile: { modelId: "gpt-6.1-sol", reasoningEffort: "high", serviceTier: null },
  ...overrides,
});

describe("native conversation identity", () => {
  test("names a local Codex chat with the model it runs", () => {
    expect(nativeConversationIdentity(summary(), null)).toEqual({
      threadId: "019a0000-0000-7000-8000-000000000001",
      sessionId: "session",
      title: "Release notes",
      role: "chat",
      agent: { kind: "codex", providerInstanceId: null, model: "gpt-6.1-sol", effort: "high" },
      archived: false,
      host: null,
    });
  });

  test("carries the execution host's name for a conversation on another machine", () => {
    const remote = nativeConversationIdentity(summary({ executionHostId: "build-box" }), {
      sshHosts: [
        {
          id: "build-box",
          displayName: "Build box",
          kind: "ssh",
          sshAlias: "build",
          port: null,
          managedRoot: "/srv",
          repositoryRoots: [],
          codexBinary: null,
          codexHome: null,
          enabled: true,
        },
      ],
    });
    expect(remote.host).toEqual({ id: "build-box", name: "Build box" });
    expect(nativeConversationIdentity(summary({ executionHostId: "gone" }), null).host).toEqual({
      id: "gone",
      name: "gone",
    });
  });

  test("names a native subagent by its nickname and an untitled chat by its preview", () => {
    const child = nativeConversationIdentity(
      summary({ threadName: null, agentNickname: "Explorer", agentPath: "/root/explorer" }),
      null,
    );
    expect(child).toMatchObject({ title: "Explorer", role: "subagent" });
    expect(nativeConversationIdentity(summary({ threadName: "  " }), null).title).toBe(
      "Draft the notes",
    );
  });
});
