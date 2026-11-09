import type { CodexHeartbeatAutomationCollaborationMode, Automation } from "../../shared/types";

export const CLOCK_AUTOMATION_INTERVAL_MS = 30_000;
export const CLOCK_AUTOMATION_MAX_PER_TICK = 3;
export const CLOCK_AUTOMATION_LEASE_DURATION_MS = 15 * 60_000;
export const HEARTBEAT_RENDERER_STATE_TTL_MS = 2 * 60_000;

export interface AutomationRunContext {
  readonly now: number;
  readonly reason: "scheduled";
  readonly leaseId?: string;
  readonly dispatchId?: string;
  readonly admission?: AutomationAdmission | null;
  readonly automationRevision?: number;
  readonly deadlineMs?: number;
  readonly heartbeat?: AutomationHeartbeatRunContext;
}

export class AutomationRetryError extends Error {
  constructor(
    message: string,
    readonly retryDelayMs: number | null,
    readonly reasonCode: string,
  ) {
    super(message);
    this.name = "AutomationRetryError";
  }
}

export interface AutomationHeartbeatRendererState {
  readonly rendererClientId: string;
  readonly isEligible: boolean;
  readonly reason: string | null;
  readonly updatedAtMs: number;
}

export interface AutomationHeartbeatRunContext {
  readonly automationsEnabled: boolean;
  readonly rendererState: AutomationHeartbeatRendererState | null;
  readonly collaborationMode: CodexHeartbeatAutomationCollaborationMode | null;
}

export interface AutomationHeartbeatThreadStateInput {
  readonly sessionId: string;
  readonly rendererClientId: string;
  readonly streamRole: "owner" | "follower" | null;
  readonly isEligible: boolean;
  readonly reason?: string | null;
  readonly collaborationMode?: CodexHeartbeatAutomationCollaborationMode | null;
}

export interface ClockAutomationHeartbeatState {
  readonly automationsEnabled: boolean;
  readonly rendererStates: ReadonlyMap<string, AutomationHeartbeatRendererState>;
  readonly collaborationModes: ReadonlyMap<string, CodexHeartbeatAutomationCollaborationMode>;
}

export const emptyHeartbeatState = (): ClockAutomationHeartbeatState => ({
  automationsEnabled: false,
  rendererStates: new Map(),
  collaborationModes: new Map(),
});

export const updateHeartbeatEnabled = (
  state: ClockAutomationHeartbeatState,
  enabled: boolean,
): ClockAutomationHeartbeatState =>
  enabled
    ? { ...state, automationsEnabled: true }
    : {
        automationsEnabled: false,
        rendererStates: new Map(),
        collaborationModes: new Map(),
      };

export const updateHeartbeatThreadState = (
  state: ClockAutomationHeartbeatState,
  input: AutomationHeartbeatThreadStateInput,
  now: number,
): ClockAutomationHeartbeatState => {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return state;

  const rendererStates = new Map(state.rendererStates).set(sessionId, {
    rendererClientId: input.rendererClientId,
    isEligible: input.streamRole === "owner" && input.isEligible,
    reason: input.streamRole === "owner" ? input.reason?.trim() || null : "not_conversation_owner",
    updatedAtMs: now,
  });
  const collaborationModes = new Map(state.collaborationModes);
  if (input.collaborationMode == null) collaborationModes.delete(sessionId);
  else collaborationModes.set(sessionId, input.collaborationMode);
  return { ...state, rendererStates, collaborationModes };
};

export const heartbeatRunContext = (input: {
  readonly automation: Automation;
  readonly state: ClockAutomationHeartbeatState;
  readonly now: number;
}): AutomationHeartbeatRunContext => {
  const targetSessionId = input.automation.targetSessionId?.trim() ?? "";
  const rendererState = input.state.rendererStates.get(targetSessionId) ?? null;
  return {
    automationsEnabled: input.state.automationsEnabled,
    rendererState:
      rendererState !== null &&
      input.now - rendererState.updatedAtMs <= HEARTBEAT_RENDERER_STATE_TTL_MS
        ? rendererState
        : null,
    collaborationMode: input.state.collaborationModes.get(targetSessionId) ?? null,
  };
};
