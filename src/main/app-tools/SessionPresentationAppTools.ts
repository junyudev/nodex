import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { resolveAppToolCallingSession } from "./AppToolCallingSession";
import { sessionPresentationSchemas as schemas } from "../../shared/nodex-app-tools/session-presentation-schemas";
import type { WorkbenchCommand } from "../../shared/nodex-app-tools/workbench-commands";
import type { WorkbenchWindowReference } from "../../shared/nodex-app-tools/workbench";
import { makeWorkbenchSceneKey } from "../../shared/workbench-scene";
import { make as makeAppToolOperation } from "./AppToolOperation";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexTurnPresentation } from "../../host/TurnPresentation";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import type { WorkbenchAppToolContext } from "./WorkbenchControl";
import { make as makeTarget, type SessionPresentationOpening } from "./SessionPresentationTarget";
import { make as makeWindowSelection } from "./SessionPresentationWindow";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";
import { isAgentPresentedBrowserUrl } from "../../shared/browser-url-policy";

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
  const selectWindow = yield* makeWindowSelection;
  return Effect.fn("SessionPresentationAppTools.execute")(function* (
    context: WorkbenchAppToolContext,
  ) {
    const { invocation: input, authority } = context;

    const schema = schemas[input.name as keyof typeof schemas];
    if (!schema) return toolFailure("unknown_tool");
    const parsed = parseAppToolArguments(schema, input.arguments);
    if (!parsed.success) return parsed.result;
    const target = "target" in parsed.data ? parsed.data.target : null;
    if (target?.kind === "browser" && target.url && !isAgentPresentedBrowserUrl(target.url))
      return toolFailure("invalid_arguments", "Correct the listed argument fields and try again.", {
        issues: [{ path: ["target", "url"], message: "File URLs must name a file on this device" }],
      });
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
    const findCurrent = (reference: WorkbenchWindowReference | null) =>
      reference
        ? bridge
            .registered()
            .find(
              (candidate) =>
                candidate.windowSessionId === reference.windowSessionId &&
                candidate.rendererGeneration === reference.rendererGeneration,
            )
        : undefined;
    const requestedWindow = parsed.data.window ?? anchor;
    // Opening a tab never asks an Agent to choose a window unless it named one that is gone;
    // navigating moves the user, so it keeps its exact window or asks.
    const selectsWindow = input.name === "open_in_nodex" && !parsed.data.window;
    const window =
      findCurrent(requestedWindow) ?? (selectsWindow ? yield* selectWindow(sessionId) : null);
    if (!window) {
      if (selectsWindow) return toolFailure("window_unavailable", "No Nodex window is open");
      return requestedWindow
        ? toolFailure("stale_renderer")
        : toolSuccess({ status: "window_required", windows: bridge.registered() });
    }
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
