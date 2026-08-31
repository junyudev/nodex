import { describe, expect, it } from "vitest";
import { resolveSidebarThreadMutationAuthority } from "./sidebar-thread-backend-routing";

describe("sidebar Thread mutation authority", () => {
  it("keeps Codex Threads on their native owner", () => {
    expect(
      resolveSidebarThreadMutationAuthority({
        backendBinding: { kind: "codex" },
        sessionId: "session-codex",
        threadId: "thread-codex",
      }),
    ).toEqual({ kind: "codex", threadId: "thread-codex" });
  });

  it("routes ACP Threads through their durable workspace Session", () => {
    expect(
      resolveSidebarThreadMutationAuthority({
        backendBinding: {
          kind: "acp",
          agentDefinitionId: "claude-code",
          instanceConfigId: null,
        },
        sessionId: "session-acp",
        threadId: "thread-acp",
      }),
    ).toEqual({ kind: "workspace", sessionId: "session-acp" });
  });

  it("fails closed when a non-Codex projection has no durable Session identity", () => {
    expect(
      resolveSidebarThreadMutationAuthority({
        backendBinding: {
          kind: "acp",
          agentDefinitionId: "claude-code",
          instanceConfigId: null,
        },
        sessionId: null,
        threadId: "thread-acp",
      }),
    ).toEqual({ kind: "unavailable" });
  });
});
