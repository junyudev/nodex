import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CoreModules } from "../../core-runtime/CoreModules";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";

/**
 * What the reading Member may do in a chat beyond replying: edit the messages they sent and stop
 * each Run's work. The Space's Core answers by the rules it applies when the action is carried
 * out; a personal Space answers for its only Member. Every Space serves this read, so a window of
 * any Space reaches it.
 */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const core = yield* CoreModules;
    yield* ipc.handleQuery("agent-runtime:session:member-actions", (_, { sessionId, runIds }) =>
      core.workspace
        .read(
          { kind: "session_member_actions", session_id: sessionId, run_ids: [...(runIds ?? [])] },
          undefined,
          null,
        )
        .pipe(
          Effect.map((read) => {
            if (read.value.kind !== "session_member_actions")
              throw new Error("Invalid chat actions");
            return read.value.actions;
          }),
        ),
    );
  }),
);
