import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { resolveAppToolCallingSession } from "./AppToolCallingSession";
import { sessionPresentationSchemas as schemas } from "../../shared/nodex-app-tools/session-presentation-schemas";
import type { WorkbenchCommand } from "../../shared/nodex-app-tools/workbench-commands";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import { make as makeAppToolOperation } from "./AppToolOperation";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import type { WorkbenchAppToolContext } from "./WorkbenchControl";
import { make as makeTarget, type SessionPresentationOpening } from "./SessionPresentationTarget";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";

/** What the receipt reports was opened, so an Agent never has to guess how a file is shown. */
const presentedSurface = (opening: SessionPresentationOpening) => {
  if ("existingTabId" in opening)
    return { surface: opening.surface, ...(opening.url ? { url: opening.url } : {}) };
  const { kind, config } = opening.surface;
  return { surface: kind, ...(kind === "browser" && config.url ? { url: config.url } : {}) };
};

export const make = Effect.gen(function* () {
  const admitOperation = yield* makeAppToolOperation;
  const workspace = yield* ProjectWorkspace;
  const presentation = yield* Effect.serviceOption(CodexTurnPresentation);
  const bridge = yield* WorkbenchAgentBridge;
  const resolveTarget = yield* makeTarget;
  return Effect.fn("SessionPresentationAppTools.execute")(function* (
    context: WorkbenchAppToolContext,
  ) {
    const { invocation: input, authority } = context;

    const schema = schemas[input.name as keyof typeof schemas];
    if (!schema) return toolFailure("unknown_tool");
    const parsed = parseAppToolArguments(schema, input.arguments);
    if (!parsed.success) return parsed.result;
    const caller = yield* resolveAppToolCallingSession(input.caller, workspace);
    const sessionId = parsed.data.sessionId ?? caller?.sessionId;
    if (!sessionId) return toolFailure("session_unavailable");
    const session = yield* workspace
      .getProjectSession(sessionId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!session) return toolFailure("session_unavailable");
    const anchor =
      Option.isSome(presentation) && caller?.runId != null
        ? presentation.value.read(caller.threadId, caller.runId)
        : null;
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
    const operation = yield* admitOperation(
      input,
      authority,
      context.principal.profileId,
      parsed.data,
    );
    if (!operation.success) return operation.result;
    const { operationId } = operation;
    let command: WorkbenchCommand;
    let opening: SessionPresentationOpening | null = null;
    if (input.name === "navigate_to_session") {
      command = { kind: "navigate_session", projectId: session.projectId };
    } else {
      const args = schemas.open_in_nodex.parse(input.arguments);
      opening = yield* resolveTarget({
        target: args.target,
        session,
        observation: observed.observation,
        window,
        operationId,
        authority,
        callId: input.caller.callId,
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
    const reload =
      opening && "existingTabId" in opening && !receipt.error ? opening.reload : undefined;
    const reloaded = reload ? yield* reload : undefined;
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
      ...(opening ? presentedSurface(opening) : {}),
      ...(reloaded === undefined ? {} : { reloaded }),
    });
  });
});
