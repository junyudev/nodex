import { expect, it, vi } from "vite-plus/test";
import { createRemoteCodexStageActions } from "./remote-codex-stage-actions";

it("keeps remote submissions and queue edits on the attached native owner", async () => {
  const startTurn = vi.fn().mockResolvedValue(undefined);
  const removeQueuedFollowUp = vi.fn().mockResolvedValue(undefined);
  const input = {
    hostId: "ssh:owned",
    threadId: "remote-thread",
    projectId: "project",
    control: { startTurn, removeQueuedFollowUp },
    host: { onQueueingEnabledChange: vi.fn(), onOpenThread: vi.fn() },
  } as unknown as Parameters<typeof createRemoteCodexStageActions>[0];
  expect(() => createRemoteCodexStageActions({ ...input, hostId: "local" })).toThrow(
    "attached remote owner",
  );
  const actions = createRemoteCodexStageActions(input);
  await actions.onSendPrompt("Continue", { promptInput: { text: "Exact input" } });
  expect(startTurn).toHaveBeenCalledWith(
    "remote-thread",
    "Continue",
    { projectId: "project", promptInput: { text: "Exact input" } },
    undefined,
  );
  await actions.onRemoveQueuedFollowUp("remote-thread", "queued-message");
  await expect(actions.onRemoveQueuedFollowUp("foreign-thread", "queued-message")).rejects.toThrow(
    "identity changed",
  );
  expect(removeQueuedFollowUp).toHaveBeenCalledExactlyOnceWith("remote-thread", "queued-message");
});
