import { describe, expect, it } from "vite-plus/test";
import { agentRuntimeForkSource, agentRuntimeMergeableRun } from "./agent-runtime-fork-merge";

type Status = Parameters<typeof agentRuntimeMergeableRun>[0][number]["status"];
const run = (ordinal: number, status: Status) => ({ id: `run:${ordinal}`, ordinal, status });

describe("Merging a fork back", () => {
  it("merges the newest finished Run, including one still capturing its checkpoint", () => {
    expect(agentRuntimeMergeableRun([run(1, "completed"), run(2, "failed")])?.id).toBe("run:1");
    expect(agentRuntimeMergeableRun([run(1, "completed"), run(2, "waiting")])?.id).toBe("run:2");
    expect(agentRuntimeMergeableRun([run(1, "failed")])).toBeNull();
  });

  it("holds the merge while a newer Run is still working", () => {
    expect(agentRuntimeMergeableRun([run(1, "completed"), run(2, "running")])).toBeNull();
    expect(agentRuntimeMergeableRun([run(1, "completed"), run(2, "queued")])?.id).toBe("run:1");
  });

  it("finds the source only from the Run a chat was forked at", () => {
    expect(
      agentRuntimeForkSource({ forkedFrom: { type: "run", threadId: "source", runId: "r" } }),
    ).toBe("source");
    expect(agentRuntimeForkSource({ forkedFrom: null })).toBeNull();
  });
});
