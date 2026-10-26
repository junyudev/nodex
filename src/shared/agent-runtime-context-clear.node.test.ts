import { describe, expect, it } from "vite-plus/test";
import { agentRuntimeContextClearRefusal } from "./agent-runtime-context-clear";

type Projection = Parameters<typeof agentRuntimeContextClearRefusal>[0];
const idle = {
  runs: [{ id: "run", status: "completed" }],
  providerThreads: [{ id: "provider-thread", pendingBackgroundTasks: [] }],
  subagents: [{ id: "task", status: "completed" }],
} as unknown as Projection;

describe("Clearing a chat's context", () => {
  it("clears a finished chat, including one whose latest reply failed or stopped", () => {
    expect(agentRuntimeContextClearRefusal(idle)).toBeNull();
    for (const status of ["failed", "interrupted", "cancelled"])
      expect(
        agentRuntimeContextClearRefusal({
          ...idle,
          runs: [{ ...idle.runs[0]!, status }],
        } as unknown as Projection),
      ).toBeNull();
  });

  it("waits for anything that could still add to the context", () => {
    for (const status of ["preparing", "queued", "starting", "running", "waiting"])
      expect(
        agentRuntimeContextClearRefusal({
          ...idle,
          runs: [...idle.runs, { id: "next", status }],
        } as unknown as Projection),
      ).toMatch(/Wait for the reply and queued messages/u);
    expect(
      agentRuntimeContextClearRefusal({
        ...idle,
        providerThreads: [{ id: "provider-thread", pendingBackgroundTasks: [{ id: "shell" }] }],
      } as unknown as Projection),
    ).toMatch(/Stop background work/u);
    expect(
      agentRuntimeContextClearRefusal({
        ...idle,
        subagents: [{ id: "task", status: "running" }],
      } as unknown as Projection),
    ).toMatch(/subagents to report back/u);
  });

  it("has nothing to clear before a message or after every Run was rewound", () => {
    expect(agentRuntimeContextClearRefusal({ ...idle, runs: [] })).toMatch(/Send a message/u);
    expect(
      agentRuntimeContextClearRefusal({
        ...idle,
        runs: [{ id: "run", status: "rolled_back" }],
      } as unknown as Projection),
    ).toMatch(/Send a message/u);
  });
});
