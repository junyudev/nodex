import { describe, expect, test } from "bun:test";
import { resolveStageThreadsComposerActionState } from "./stage-threads-composer-action";

describe("resolveStageThreadsComposerActionState", () => {
  test("switches to stop action while a turn is active", () => {
    const result = resolveStageThreadsComposerActionState({
      canSendPrompt: true,
      isThreadRunning: true,
      busyAction: null,
      prompt: "",
    });

    expect(result.action).toBe("stop");
    expect(result.label).toBe("Stop Codex");
    expect(result.disabled).toBeFalse();
  });

  test("disables stop action while an interrupt request is pending", () => {
    const result = resolveStageThreadsComposerActionState({
      canSendPrompt: true,
      isThreadRunning: true,
      busyAction: "interrupt",
      prompt: "ignored",
    });

    expect(result.action).toBe("stop");
    expect(result.disabled).toBeTrue();
  });

  test("keeps stop action enabled while running even when turn hydration is delayed", () => {
    const result = resolveStageThreadsComposerActionState({
      canSendPrompt: true,
      isThreadRunning: true,
      busyAction: null,
      prompt: "",
    });

    expect(result.action).toBe("stop");
    expect(result.disabled).toBeFalse();
  });

  test("uses send action when idle and enables it only for non-empty prompts", () => {
    const disabled = resolveStageThreadsComposerActionState({
      canSendPrompt: true,
      isThreadRunning: false,
      busyAction: null,
      prompt: "   ",
    });
    const enabled = resolveStageThreadsComposerActionState({
      canSendPrompt: true,
      isThreadRunning: false,
      busyAction: null,
      prompt: "Please refactor this",
    });

    expect(disabled.action).toBe("send");
    expect(disabled.label).toBe("Send prompt");
    expect(disabled.disabled).toBeTrue();
    expect(enabled.action).toBe("send");
    expect(enabled.disabled).toBeFalse();
  });

  test("allows send in new-thread mode when a target card exists", () => {
    const enabled = resolveStageThreadsComposerActionState({
      canSendPrompt: true,
      isThreadRunning: false,
      busyAction: null,
      prompt: "Kick this off",
    });
    const disabled = resolveStageThreadsComposerActionState({
      canSendPrompt: false,
      isThreadRunning: false,
      busyAction: null,
      prompt: "Kick this off",
    });

    expect(enabled.disabled).toBeFalse();
    expect(disabled.disabled).toBeTrue();
  });
});
