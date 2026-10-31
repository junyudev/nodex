import * as Layer from "effect/Layer";
import { CodexConversationProjection } from "../codex-application/CodexConversationProjection";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import { CodexServerRequestResponses } from "../codex-application/CodexServerRequestResponses";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";

/** Unused native commands fail loudly; unloaded conversations have no current manager. */
export const nativeQuestionTestLayers = Layer.mergeAll(
  Layer.mock(CodexConversationProjection, {}),
  Layer.mock(CodexMainConversationManagers, {
    current: () => null,
    role: () => null,
    registerFollowerHandler: () => ({ [Symbol.dispose]: () => {} }),
  }),
  Layer.mock(CodexServerRequestResponses, {}),
  Layer.mock(CodexTurnCommands, {
    releasePreparedNativeStart: () => {},
    releasePreparedNativeSteer: () => {},
  }),
);
