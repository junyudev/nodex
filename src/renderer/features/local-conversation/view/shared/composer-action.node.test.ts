import { describe, expect, test } from "vite-plus/test";
import {
  resolveComposerSubmitIntentFromKeyDown,
  resolveStageThreadsComposerActionState,
} from "./composer-action";

describe("resolveStageThreadsComposerActionState", () => {
  const baseInput = {
    canSendPrompt: true,
    isThreadRunning: false,
    busyAction: null,
    hasDraftContent: false,
    hasThreadGoal: false,
    isQueueingEnabled: false,
    latestTurnStatus: null,
    canResumeInterruptedTurn: true,
  } as const;

  test("keeps stop only while a turn is active and the draft is empty", () => {
    const result = resolveStageThreadsComposerActionState({
      ...baseInput,
      isThreadRunning: true,
    });

    expect(result.action).toBe("stop");
    expect(result.label).toBe("Stop");
    expect(result.disabled).toBe(false);
  });

  test("preserves stop with a draft when the runtime cannot steer or queue", () => {
    expect(
      resolveStageThreadsComposerActionState({
        ...baseInput,
        isThreadRunning: true,
        hasDraftContent: true,
        supportsRunningFollowUps: false,
      }),
    ).toMatchObject({
      action: "stop",
      disabled: false,
      primarySubmitAction: null,
      alternateSubmitAction: null,
    });
  });

  test("disables stop action while an interrupt request is pending", () => {
    const result = resolveStageThreadsComposerActionState({
      ...baseInput,
      busyAction: "interrupt",
    });

    expect(result.action).toBe("stop");
    expect(result.disabled).toBe(true);
  });

  test("switches to steer submit while running when queue mode is off and draft exists", () => {
    const result = resolveStageThreadsComposerActionState({
      ...baseInput,
      isThreadRunning: true,
      hasDraftContent: true,
    });

    expect(result.action).toBe("send");
    expect(result.primarySubmitAction).toBe("steer");
    expect(result.alternateSubmitAction).toBe("queue");
    expect(result.label).toBe("Steer follow-up");
    expect(result.disabled).toBe(false);
  });

  test("switches to queue submit while running when queue mode is on and draft exists", () => {
    const result = resolveStageThreadsComposerActionState({
      ...baseInput,
      isThreadRunning: true,
      hasDraftContent: true,
      isQueueingEnabled: true,
    });

    expect(result.action).toBe("send");
    expect(result.primarySubmitAction).toBe("queue");
    expect(result.alternateSubmitAction).toBe("steer");
    expect(result.label).toBe("Queue follow-up");
    expect(result.disabled).toBe(false);
  });

  test("uses send action when idle and enables it only for non-empty prompts", () => {
    const disabled = resolveStageThreadsComposerActionState({
      ...baseInput,
    });
    const enabled = resolveStageThreadsComposerActionState({
      ...baseInput,
      hasDraftContent: true,
    });

    expect(disabled.action).toBe("send");
    expect(disabled.primarySubmitAction).toBe("send");
    expect(disabled.label).toBe("Send prompt");
    expect(disabled.disabled).toBe(true);
    expect(enabled.action).toBe("send");
    expect(enabled.primarySubmitAction).toBe("send");
    expect(enabled.disabled).toBe(false);
  });

  test("allows send in new-thread mode when a target card exists", () => {
    const enabled = resolveStageThreadsComposerActionState({
      ...baseInput,
      hasDraftContent: true,
    });
    const disabled = resolveStageThreadsComposerActionState({
      ...baseInput,
      canSendPrompt: false,
      hasDraftContent: true,
    });

    expect(enabled.disabled).toBe(false);
    expect(disabled.disabled).toBe(true);
  });

  test("offers Resume for an idle interrupted thread with an empty composer", () => {
    const result = resolveStageThreadsComposerActionState({
      ...baseInput,
      latestTurnStatus: "interrupted",
    });

    expect(result).toEqual({
      action: "resume",
      primarySubmitAction: null,
      alternateSubmitAction: null,
      label: "Resume",
      disabled: false,
    });
  });

  test("keeps Resume pending while the optimistic empty turn becomes active", () => {
    const result = resolveStageThreadsComposerActionState({
      ...baseInput,
      busyAction: "resume",
      isThreadRunning: true,
      latestTurnStatus: "inProgress",
    });

    expect(result.action).toBe("resume");
    expect(result.disabled).toBe(true);
  });

  test.each([
    { name: "a draft", hasDraftContent: true },
    { name: "a saved thread goal", hasThreadGoal: true },
    { name: "no resume capability", canResumeInterruptedTurn: false },
    { name: "another submit blocker", canSendPrompt: false },
  ])("suppresses Resume with $name", (override) => {
    const result = resolveStageThreadsComposerActionState({
      ...baseInput,
      latestTurnStatus: "interrupted",
      ...override,
    });

    expect(result.action).toBe("send");
  });
});

describe("resolveComposerSubmitIntentFromKeyDown", () => {
  test("uses cmd-enter as alternate queue when running in enter mode with queueing off", () => {
    const result = resolveComposerSubmitIntentFromKeyDown({
      enterBehavior: "enter",
      hasMultilinePrompt: false,
      isThreadRunning: true,
      primarySubmitAction: "steer",
      alternateSubmitAction: "queue",
      key: "Enter",
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
      altKey: false,
    });

    expect(result?.submitAction).toBe("queue");
    expect(result?.shortcutRole).toBe("alternate");
  });

  test("uses enter as primary queue when running in enter mode with queueing on", () => {
    const result = resolveComposerSubmitIntentFromKeyDown({
      enterBehavior: "enter",
      hasMultilinePrompt: false,
      isThreadRunning: true,
      primarySubmitAction: "queue",
      alternateSubmitAction: "steer",
      key: "Enter",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    });

    expect(result?.submitAction).toBe("queue");
    expect(result?.shortcutRole).toBe("primary");
  });

  test("separates primary cmd-enter and alternate cmd-shift-enter for multiline cmdIfMultiline drafts", () => {
    const primary = resolveComposerSubmitIntentFromKeyDown({
      enterBehavior: "cmdIfMultiline",
      hasMultilinePrompt: true,
      isThreadRunning: true,
      primarySubmitAction: "steer",
      alternateSubmitAction: "queue",
      key: "Enter",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    });
    const alternate = resolveComposerSubmitIntentFromKeyDown({
      enterBehavior: "cmdIfMultiline",
      hasMultilinePrompt: true,
      isThreadRunning: true,
      primarySubmitAction: "steer",
      alternateSubmitAction: "queue",
      key: "Enter",
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
    });

    expect(primary?.submitAction).toBe("steer");
    expect(primary?.shortcutRole).toBe("primary");
    expect(alternate?.submitAction).toBe("queue");
    expect(alternate?.shortcutRole).toBe("alternate");
  });

  test("does not submit for composing, alt, or wrong modifiers", () => {
    const base = {
      enterBehavior: "cmdIfMultiline" as const,
      hasMultilinePrompt: false,
      isThreadRunning: true,
      primarySubmitAction: "steer" as const,
      alternateSubmitAction: "queue" as const,
      key: "Enter",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    };

    expect(resolveComposerSubmitIntentFromKeyDown({ ...base, isComposing: true })).toBe(null);
    expect(resolveComposerSubmitIntentFromKeyDown({ ...base, altKey: true })).toBe(null);
    expect(resolveComposerSubmitIntentFromKeyDown(base)).toBe(null);
  });
});
