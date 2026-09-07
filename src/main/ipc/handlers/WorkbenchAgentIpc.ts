import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { CodexTurnPresentationCaptureInputSchema } from "../../../shared/nodex-app-tools/turn-presentation";
import { CodexTurnPresentation } from "../../codex-application/CodexTurnPresentation";
import {
  WorkbenchAgentRegisterSchema,
  WorkbenchWindowReferenceSchema,
} from "../../../shared/nodex-app-tools/workbench";
import { MainConfig } from "../../app/MainConfig";
import { WorkbenchAgentBridge } from "../../app-tools/WorkbenchAgentBridge";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

class WorkbenchAgentIpcError extends Schema.TaggedError<WorkbenchAgentIpcError>()(
  "WorkbenchAgentIpcError",
  { cause: Schema.Defect() },
) {}

/** A narrow, sender-bound capability; renderer input cannot route to another window. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const bridge = yield* WorkbenchAgentBridge;
    const presentation = yield* CodexTurnPresentation;
    const config = yield* MainConfig;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () =>
          requireTrustedAppRendererSender(event, "Workbench presentation", config.rendererUrl),
        catch: (cause) => new WorkbenchAgentIpcError({ cause }),
      });
    yield* ipc.handleControl("codex:turn-presentation:capture", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.try({
            try: () => CodexTurnPresentationCaptureInputSchema.parse(input),
            catch: (cause) => new WorkbenchAgentIpcError({ cause }),
          }),
        ),
        Effect.flatMap((capture) => presentation.capture(event.sender.id, capture)),
      ),
    );
    yield* ipc.handleControl("workbench-agent:register", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.try({
            try: () => WorkbenchAgentRegisterSchema.parse(input),
            catch: (cause) => new WorkbenchAgentIpcError({ cause }),
          }),
        ),
        Effect.flatMap(({ ownerId }) => bridge.register(event.sender.id, ownerId)),
      ),
    );
    yield* ipc.handleControl("workbench-agent:release", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.try({
            try: () => WorkbenchWindowReferenceSchema.parse(input),
            catch: (cause) => new WorkbenchAgentIpcError({ cause }),
          }),
        ),
        Effect.flatMap((reference) => bridge.release(event.sender.id, reference)),
      ),
    );
    yield* ipc.handleControl("workbench-agent:reply", (event, input) =>
      authorize(event).pipe(Effect.andThen(bridge.reply(event.sender.id, input))),
    );
  }),
);
