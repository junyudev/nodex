import { expect, test, vi } from "vite-plus/test";
import type { ThreadStageActions } from "./thread-stage-types";
import { composeNativeThreadStageActions } from "./native-thread-stage-actions";

test("native execution has no implicit Codex handlers while shared Session navigation stays available", async () => {
  const codexExecution = vi.fn();
  const nativePrompt = vi.fn().mockResolvedValue(undefined);
  const archive = vi.fn();
  const open = vi.fn();
  const host = {
    onArchiveThread: archive,
    onOpenThread: open,
    onQueueingEnabledChange: vi.fn(),
    onCompactThread: codexExecution,
    onPermissionModeChange: codexExecution,
    onRespondPermissionRequest: codexExecution,
    onRetryThreadAttachment: codexExecution,
    onRespondSetupCodexStep: codexExecution,
    onUploadFeedback: codexExecution,
  } as unknown as ThreadStageActions;
  const actions = composeNativeThreadStageActions(host, { onSendPrompt: nativePrompt });
  await actions.onSendPrompt("hello");
  expect(nativePrompt).toHaveBeenCalledWith("hello");
  await actions.onArchiveThread?.();
  await actions.onOpenThread("target");
  expect(archive).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith("target");
  for (const key of [
    "onCompactThread",
    "onRespondPermissionRequest",
    "onRetryThreadAttachment",
    "onRespondSetupCodexStep",
    "onUploadFeedback",
  ] as const)
    expect(actions[key]).toBeUndefined();
  await expect(actions.onPermissionModeChange("full-access")).rejects.toThrow("unavailable");
  expect(codexExecution).not.toHaveBeenCalled();
});
