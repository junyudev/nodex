import type { Draft } from "immer";
import type {
  ThreadSettings,
  ThreadSettingsUpdateParams,
} from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalConversationState } from "./codex-conversation-state";
import { residentConversationTurns } from "./codex-turn-mutation";

export type CanonicalThreadSettingsPatch = Omit<ThreadSettingsUpdateParams, "threadId"> &
  Partial<Pick<ThreadSettings, "activePermissionProfile">>;

/** Applies a partial owner setting without inventing unrelated permission or model defaults. */
export function mutateCanonicalThreadSettingsPatch(
  state: Draft<CodexCanonicalConversationState>,
  patch: CanonicalThreadSettingsPatch,
): void {
  const previous = state.latestCollaborationMode;
  const collaborationMode =
    patch.collaborationMode ??
    (patch.model == null && patch.effort === undefined
      ? previous
      : {
          ...previous,
          settings: {
            ...previous.settings,
            model: patch.model ?? previous.settings.model,
            reasoning_effort:
              patch.effort === undefined ? previous.settings.reasoning_effort : patch.effort,
          },
        });
  const profile =
    patch.activePermissionProfile !== undefined
      ? { activePermissionProfile: patch.activePermissionProfile }
      : patch.sandboxPolicy !== undefined
        ? { activePermissionProfile: null }
        : patch.permissions !== undefined
          ? {
              activePermissionProfile:
                patch.permissions == null ? null : { id: patch.permissions, extends: null },
            }
          : {};
  const effort =
    patch.effort !== undefined
      ? patch.effort
      : patch.collaborationMode != null
        ? patch.collaborationMode.settings.reasoning_effort
        : state.latestThreadSettings?.effort === undefined
          ? state.latestReasoningEffort
          : state.latestThreadSettings.effort;
  state.latestThreadSettings = {
    ...state.latestThreadSettings,
    ...patch,
    ...profile,
    ...(patch.sandboxPolicy !== undefined && patch.permissions === undefined
      ? { permissions: null }
      : {}),
    model:
      patch.model ??
      patch.collaborationMode?.settings.model ??
      state.latestThreadSettings?.model ??
      state.latestModel,
    effort,
    collaborationMode,
  };
  state.latestModel = state.latestThreadSettings.model;
  state.latestReasoningEffort = effort;
  state.latestCollaborationMode = collaborationMode;
  state.cwd = patch.cwd ?? state.cwd;
  const oldModel = previous.settings.model;
  const newModel = collaborationMode.settings.model;
  if (
    residentConversationTurns(state).length === 0 ||
    oldModel.length === 0 ||
    newModel === oldModel
  )
    return;
  if (state.previousTurnModel == null) {
    state.previousTurnModel = oldModel;
    return;
  }
  if (newModel === state.previousTurnModel) state.previousTurnModel = null;
}

export interface CanonicalThreadSettingsCondition {
  readonly ifEffortEquals: ThreadSettings["effort"];
  readonly ifModelEquals?: string | null;
}

export interface CanonicalThreadSettingsClient {
  readonly getConversation: (id: string) => CodexCanonicalConversationState;
  readonly updateConversation: (
    id: string,
    recipe: (draft: Draft<CodexCanonicalConversationState>) => void,
  ) => void;
  readonly getSupport: () => "unknown" | "supported" | "unsupported";
  readonly setSupport: (support: "supported" | "unsupported") => void;
  readonly isUnsupported: (error: unknown) => boolean;
  readonly updateThread: (params: ThreadSettingsUpdateParams) => Promise<unknown>;
  readonly updateTurnReviewer: (
    threadId: string,
    turnId: string,
    reviewer: NonNullable<ThreadSettingsUpdateParams["approvalsReviewer"]>,
  ) => Promise<unknown>;
  readonly supportsTurnReviewer: () => boolean;
}

/** Caller serializes per conversation; notifications can replace the settings object during I/O. */
export async function updateCanonicalThreadSettings(
  client: CanonicalThreadSettingsClient,
  id: string,
  patch: CanonicalThreadSettingsPatch,
  condition?: CanonicalThreadSettingsCondition,
  activeTurnId?: string | null,
): Promise<boolean> {
  const before = client.getConversation(id);
  const settingsAtStart = before.latestThreadSettings;
  if (
    condition &&
    (before.latestReasoningEffort !== condition.ifEffortEquals ||
      (condition.ifModelEquals != null && before.latestModel !== condition.ifModelEquals))
  )
    return false;
  if (client.getSupport() !== "unsupported") {
    try {
      await client.updateThread({ threadId: id, ...patch });
      client.setSupport("supported");
    } catch (error) {
      if (!client.isUnsupported(error)) throw error;
      client.setSupport("unsupported");
    }
  }
  if (
    client.getSupport() === "unsupported" ||
    client.getConversation(id).latestThreadSettings === settingsAtStart
  ) {
    client.updateConversation(id, (draft) => mutateCanonicalThreadSettingsPatch(draft, patch));
  }
  if (activeTurnId != null && patch.approvalsReviewer != null && client.supportsTurnReviewer()) {
    await client.updateTurnReviewer(id, activeTurnId, patch.approvalsReviewer);
  }
  return true;
}
