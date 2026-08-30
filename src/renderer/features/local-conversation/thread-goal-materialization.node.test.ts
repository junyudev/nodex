import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const transport = vi.hoisted(() => ({
  command: vi.fn(),
  control: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/renderer-command", () => ({
  defineRendererCommand: <Definition>(definition: Definition) => definition,
  invokePlainCommand: transport.command,
  invokeRendererControl: transport.control,
  invokeRendererQuery: transport.query,
}));

import {
  cleanupMaterializedThreadGoalDraft,
  materializeThreadGoalDraft,
  readThreadGoalEditableObjective,
  runBestEffortThreadGoalCleanup,
} from "./thread-goal-materialization";

describe("thread goal materialization boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test("rejects a draft with no objective or attachments", async () => {
    let error: unknown = null;

    try {
      await materializeThreadGoalDraft({
        objective: " \n ",
        pastedTextAttachments: [],
        imageAttachments: [],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error instanceof Error ? error.message : null).toBe("Goal objective must not be empty");
  });

  test("keeps short attachment-free goals local", async () => {
    await expect(
      materializeThreadGoalDraft({
        objective: "  Ship the causal contract  ",
        pastedTextAttachments: [],
        imageAttachments: [],
      }),
    ).resolves.toEqual({
      objective: "Ship the causal contract",
      attachmentDirectory: null,
    });
    expect(transport.command).not.toHaveBeenCalled();
  });

  test("materializes attachment goals as a registered pending operation", async () => {
    const draft = {
      objective: "Use this screenshot",
      pastedTextAttachments: [],
      imageAttachments: [{ src: "data:image/png;base64,example" }],
    } as const;
    transport.command.mockResolvedValue({
      objective: "Use this screenshot\n\n[attached image]",
      attachmentDirectory: "/tmp/nodex-goal",
    });

    await expect(materializeThreadGoalDraft(draft)).resolves.toEqual({
      objective: "Use this screenshot\n\n[attached image]",
      attachmentDirectory: "/tmp/nodex-goal",
    });
    expect(transport.command).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "thread_goal.materialize_draft",
        channel: "codex:thread:goal:materialize-draft",
        authority: "external",
        protocol: { kind: "pending_operation" },
      }),
      draft,
    );
  });

  test("routes cleanup through the control boundary and keeps failure best effort", async () => {
    transport.control.mockRejectedValue(new Error("cleanup failed"));

    await expect(
      cleanupMaterializedThreadGoalDraft({
        objective: "Goal",
        attachmentDirectory: "/tmp/nodex-goal",
      }),
    ).resolves.toBeUndefined();
    expect(transport.control).toHaveBeenCalledWith(
      "codex:thread:goal:materialized-cleanup",
      "/tmp/nodex-goal",
    );
  });

  test("reads editable objectives through the query boundary", async () => {
    transport.query.mockResolvedValue("Editable goal");

    await expect(readThreadGoalEditableObjective("stored goal")).resolves.toBe("Editable goal");
    expect(transport.query).toHaveBeenCalledWith(
      "codex:thread:goal:editable-objective:read",
      "stored goal",
    );
  });

  test("treats materialized-directory cleanup as best effort", async () => {
    let cleanupCalls = 0;
    await runBestEffortThreadGoalCleanup(async () => {
      cleanupCalls += 1;
      throw new Error("cleanup failed");
    });
    expect(cleanupCalls).toBe(1);
  });
});
