export type StageThreadsBusyAction = "send" | "interrupt" | "login" | "refresh" | "logout" | null;
export type StageThreadsComposerAction = "send" | "stop";

interface ResolveComposerActionInput {
  canSendPrompt: boolean;
  isThreadRunning: boolean;
  busyAction: StageThreadsBusyAction;
  prompt: string;
}

interface ResolvedComposerActionState {
  action: StageThreadsComposerAction;
  label: "Send prompt" | "Stop Codex";
  disabled: boolean;
}

export function resolveStageThreadsComposerActionState(
  input: ResolveComposerActionInput,
): ResolvedComposerActionState {
  if (input.isThreadRunning) {
    return {
      action: "stop",
      label: "Stop Codex",
      disabled: !input.canSendPrompt || input.busyAction === "interrupt",
    };
  }

  return {
    action: "send",
    label: "Send prompt",
    disabled: !input.canSendPrompt || input.busyAction !== null || input.prompt.trim().length === 0,
  };
}
