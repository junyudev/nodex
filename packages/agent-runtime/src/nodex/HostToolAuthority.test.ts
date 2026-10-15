import { describe, expect, it } from "vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { hostToolAuthorityRefusal, type HostToolAuthorityView } from "./HostToolAuthority.ts";
import type { AgentHostTurnIdentity } from "./Interface.ts";

const threadId = ThreadId.make("thread:test");
const projectId = ProjectId.make("project:test");
const providerThreadId = ProviderThreadId.make("provider-thread:test");
const runId = RunId.make("run:test");
const attemptId = RunAttemptId.make("attempt:test");
const providerInstanceId = ProviderInstanceId.make("claude-work");
const providerSessionId = ProviderSessionId.make("session:test");
const nativeThreadRef = {
  driver: ProviderDriverKind.make("claude-code"),
  nativeId: "native:test",
  strength: "strong" as const,
};
const identity: AgentHostTurnIdentity = {
  runtimeId: "runtime:test",
  runtimeGeneration: "process:test",
  projectId,
  threadId,
  runId,
  attemptId,
  providerInstanceId,
  providerSessionId,
  providerThreadId,
  nativeGeneration: 4,
  nativeThreadRef,
  cwd: "/workspace",
};
const state: HostToolAuthorityView = {
  thread: { id: threadId, projectId, activeProviderThreadId: providerThreadId, deletedAt: null },
  runs: [
    {
      id: runId,
      ordinal: 1,
      activeAttemptId: attemptId,
      providerThreadId,
      providerInstanceId,
      status: "running",
    },
  ],
  providerThreads: [
    {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId,
      nativeThreadRef,
    },
  ],
  subagents: [],
};

describe("captured native execution identity", () => {
  it("admits the exact running attempt and app-owned delegated child", () => {
    expect(hostToolAuthorityRefusal(state, identity, 4)).toBeUndefined();
    expect(
      hostToolAuthorityRefusal(
        {
          ...state,
          subagents: [{ origin: "app_owned", status: "running", providerThreadId }],
        },
        identity,
        4,
      ),
    ).toBeUndefined();
  });

  it("admits a live earlier Run when another Run starts", () => {
    expect(
      hostToolAuthorityRefusal(
        {
          ...state,
          runs: [
            ...state.runs,
            {
              ...state.runs[0]!,
              id: RunId.make("run:next"),
              activeAttemptId: RunAttemptId.make("attempt:next"),
              ordinal: 2,
            },
          ],
        },
        identity,
        4,
      ),
    ).toBeUndefined();
  });

  it("rejects session replacement and interrupted attempts", () => {
    expect(hostToolAuthorityRefusal(state, identity, 5)).toMatch(/generation/);
    expect(
      hostToolAuthorityRefusal(
        { ...state, runs: [{ ...state.runs[0]!, status: "interrupted" }] },
        identity,
        4,
      ),
    ).toBeDefined();
  });

  it("admits provider background work under its original identity", () => {
    expect(
      hostToolAuthorityRefusal(
        { ...state, runs: [{ ...state.runs[0]!, status: "completed" }] },
        identity,
        4,
      ),
    ).toBeUndefined();
    expect(
      hostToolAuthorityRefusal(
        {
          ...state,
          subagents: [
            {
              origin: "provider_native",
              status: "waiting",
              providerThreadId,
            },
          ],
        },
        identity,
        4,
      ),
    ).toBeUndefined();
  });
  it("refuses cancelled calls without borrowing the next Run", () => {
    expect(
      hostToolAuthorityRefusal(
        {
          ...state,
          runs: [
            { ...state.runs[0]!, status: "cancelled" },
            { ...state.runs[0]!, id: RunId.make("run:next"), ordinal: 2 },
          ],
        },
        identity,
        4,
      ),
    ).toBeDefined();
  });
});
