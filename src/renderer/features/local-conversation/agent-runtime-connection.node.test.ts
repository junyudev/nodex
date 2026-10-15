import { describe, expect, it } from "vite-plus/test";
import { projectAgentRuntimeConnection } from "./agent-runtime-conversation-adapter";

describe("Runtime chat connection", () => {
  it("reports one shared execution process without inventing per-chat reconnects", () => {
    expect(projectAgentRuntimeConnection({ status: "idle" }).status).toBe("connected");
    expect(projectAgentRuntimeConnection({ status: "ready", generation: "g" }).status).toBe(
      "connected",
    );
    expect(projectAgentRuntimeConnection({ status: "starting" }).status).toBe("starting");
    expect(projectAgentRuntimeConnection({ status: "restarting", attempt: 2 })).toMatchObject({
      status: "disconnected",
      retries: 2,
    });
    expect(
      projectAgentRuntimeConnection({ status: "failed", message: "Execution keeps crashing" }),
    ).toMatchObject({ status: "error", message: "Execution keeps crashing" });
  });

  it("keeps a stable view per state so subscribers do not re-render without a change", () => {
    const failed = { status: "failed", message: "x" } as const;
    expect(projectAgentRuntimeConnection(failed)).toBe(projectAgentRuntimeConnection(failed));
  });
});
