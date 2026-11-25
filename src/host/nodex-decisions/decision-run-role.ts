import * as Effect from "effect/Effect";
import type { CoreModules } from "../../main/core-runtime/CoreModules";

export const readDecisionRunState = Effect.fn("NodexDecisionRun.read")(function* (
  core: CoreModules["Service"],
  sessionId: string,
) {
  const snapshot = yield* core.workspace.read({ kind: "decision_run", session_id: sessionId });
  if (snapshot.value.kind !== "decision_run") return yield* Effect.die("Invalid decision run read");
  return snapshot.value;
});

export const readDecisionRun = (core: CoreModules["Service"], sessionId: string) =>
  readDecisionRunState(core, sessionId).pipe(Effect.map((state) => state.decision_run ?? null));
