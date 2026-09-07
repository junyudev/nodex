import * as Effect from "effect/Effect";
import { sessionPresentationSchemas as schemas } from "../../shared/nodex-app-tools/session-presentation-schemas";
import type { WorkbenchCommand } from "../../shared/nodex-app-tools/workbench-commands";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import type { WorkbenchAppToolContext } from "./WorkbenchControl";
import { make as makeTarget } from "./SessionPresentationTarget";
import { toolFailure, toolSuccess } from "./app-tool-result";

export const make = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const presentation = yield* CodexTurnPresentation;
  const bridge = yield* WorkbenchAgentBridge;
  const resolveTarget = yield* makeTarget;
  return Effect.fn("SessionPresentationAppTools.execute")(function* (
    context: WorkbenchAppToolContext,
  ) {
    const { invocation: input, authority } = context;
    if (authority.readOnly) return toolFailure("read_only_turn");
    const schema = schemas[input.name as keyof typeof schemas];
    if (!schema) return toolFailure("unknown_tool");
    const parsed = schema.safeParse(input.arguments);
    if (!parsed.success) return toolFailure("invalid_arguments");
    const caller = yield* workspace
      .getThread(input.caller.threadId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const sessionId = parsed.data.sessionId ?? caller?.sessionId;
    if (!sessionId) return toolFailure("session_unavailable");
    const session = yield* workspace
      .getProjectSession(sessionId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (
      !session ||
      (authority.scope !== "library" && session.projectId !== authority.actorProjectId)
    )
      return toolFailure("session_unavailable");
    const anchor = presentation.read(input.caller.threadId, input.caller.turnId);
    const requestedWindow = parsed.data.window ?? anchor;
    if (!requestedWindow)
      return toolSuccess({ status: "window_required", windows: bridge.registered() });
    const window = bridge
      .registered()
      .find(
        (candidate) =>
          candidate.windowSessionId === requestedWindow.windowSessionId &&
          candidate.rendererGeneration === requestedWindow.rendererGeneration,
      );
    if (!window) return toolFailure("stale_renderer");
    const sceneOwner = { kind: "session" as const, sessionId };
    const observed = yield* bridge.request(window, { kind: "observe", sceneOwner });
    const discovery =
      observed.observation === null
        ? yield* bridge.request(window, { kind: "discover", sessionId })
        : null;
    const revision = observed.observation?.presentationRevision ?? discovery!.presentationRevision;
    const selected =
      observed.observation?.selectedSceneOwner ?? discovery?.selectedSceneOwner ?? null;
    const operationId =
      parsed.data.operationId ??
      createStableOperationId(`app.${input.name}`, authority.frozenAtMs, [
        context.principal.profileId,
        input.caller.threadId,
        input.caller.turnId,
        input.caller.callId,
      ]);
    let command: WorkbenchCommand;
    if (input.name === "navigate_to_session") {
      command = { kind: "navigate_session", projectId: session.projectId };
    } else {
      const args = schemas.open_in_nodex.parse(input.arguments);
      const opening = yield* resolveTarget({
        target: args.target,
        session,
        observation: observed.observation,
        operationId,
        authority,
        callId: input.caller.callId,
        taskAccess: context.taskAccess,
      });
      if (!opening) return toolFailure("target_unavailable");
      command =
        "existingTabId" in opening
          ? { kind: "activate_surface", tabId: opening.existingTabId }
          : { kind: "open_surface", panelId: args.placement, ...opening };
    }
    if (!(yield* context.isCurrent)) return toolFailure("authority_unavailable");
    const result = yield* bridge.request(window, {
      kind: "command",
      envelope: {
        operationId,
        sceneOwner,
        expectedPresentationRevision: revision,
        command,
      },
    });
    const receipt = result.receipt;
    const isSelected =
      selected !== null && makeWorkbenchSceneKey(selected) === makeWorkbenchSceneKey(sceneOwner);
    return toolSuccess({
      status: receipt.error
        ? "failed"
        : input.name === "navigate_to_session"
          ? "navigated"
          : isSelected
            ? "opened"
            : "queued",
      window,
      sessionId,
      ...receipt,
    });
  });
});
