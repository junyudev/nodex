import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { NodexAgentResourceAccessOverlay } from "../../shared/nodex-agent-resource-access";
import type { WorkbenchObservedTab } from "../../shared/nodex-app-tools/workbench";
import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { WorkbenchContentAccess } from "./WorkbenchContentAccess";
import { workbenchObservationHandle } from "./workbench-observation-page";

export const make = Effect.gen(function* () {
  const content = yield* WorkbenchContentAccess;
  const workspace = yield* ProjectWorkspace;
  const sessionAllowed = Effect.fn("WorkbenchTabDescription.sessionAllowed")(function* (
    sessionId: string,
    authority: FrozenNodexAgentTurnAuthority,
  ) {
    const session = yield* workspace
      .getProjectSession(sessionId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return (
      session !== null &&
      (authority.scope === "library" || session.projectId === authority.actorProjectId)
    );
  });
  const sceneAllowed = Effect.fn("WorkbenchTabDescription.sceneAllowed")(function* (
    scene: WorkbenchSceneOwner,
    authority: FrozenNodexAgentTurnAuthority,
  ) {
    if (authority.scope === "library") return true;
    if (scene.kind === "session") return yield* sessionAllowed(scene.sessionId, authority);
    return scene.kind === "project" && scene.projectId === authority.actorProjectId;
  });
  return Effect.fn("WorkbenchTabDescription.describe")(function* (input: {
    readonly observationId: string;
    readonly tab: WorkbenchObservedTab;
    readonly sceneOwner: WorkbenchSceneOwner;
    readonly authority: FrozenNodexAgentTurnAuthority;
    readonly callId: string;
    readonly taskAccess?: NodexAgentResourceAccessOverlay;
    readonly requireExactTarget?: boolean;
  }): Effect.fn.Return<Record<string, unknown>> {
    const { tab, authority } = input;
    const base = {
      tabId: workbenchObservationHandle(input.observationId, "tab", tab.tabId),
      panelId: tab.panelId,
      groupId: tab.groupId
        ? workbenchObservationHandle(input.observationId, "group", tab.groupId)
        : null,
      protected: tab.protected,
      persisted: tab.persisted,
      preview: tab.preview,
      selected: tab.selected,
      visible: tab.visible,
    };
    const restricted = { ...base, status: "restricted", reason: "access_denied" };
    const surface = tab.surface;
    if (
      input.requireExactTarget &&
      surface?.kind === "db_view" &&
      surface.config.target.kind !== "database-view"
    )
      return { ...base, status: "restricted", reason: "unavailable" };
    if (
      surface &&
      (surface.kind === "page_stage" ||
        surface.kind === "db_view" ||
        surface.kind === "canvas_stage")
    ) {
      const description = yield* content.describe({
        authority,
        callId: input.callId,
        taskAccess: input.taskAccess,
        surface,
      });
      return description.status === "restricted"
        ? { ...base, ...description }
        : { ...base, ...description, title: description.title.slice(0, 300) };
    }
    if (!(yield* sceneAllowed(input.sceneOwner, authority))) return restricted;
    if (surface?.kind === "image_editor" || tab.auxiliary?.kind === "image_editor")
      return restricted;
    if (!surface)
      return {
        ...base,
        status: "authorized",
        kind: tab.auxiliary!.kind,
        title: tab.auxiliary!.title.slice(0, 300),
      };
    if (surface.kind === "conversation") {
      if (!(yield* sessionAllowed(surface.config.sessionId, authority))) return restricted;
      return {
        ...base,
        status: "authorized",
        kind: "conversation",
        sessionId: surface.config.sessionId,
        title: surface.titleSnapshot.slice(0, 300),
      };
    }
    if (surface.kind === "files" || surface.kind === "review") {
      if (authority.scope !== "library" && surface.config.projectId !== authority.actorProjectId)
        return restricted;
      return {
        ...base,
        status: "authorized",
        kind: surface.kind,
        projectId: surface.config.projectId,
        title: surface.titleSnapshot.slice(0, 300),
      };
    }
    if (surface.kind === "terminal" && surface.config.context) {
      const target = surface.config.context;
      const allowed =
        target.kind === "session"
          ? yield* sessionAllowed(target.sessionId, authority)
          : authority.scope === "library" || target.projectId === authority.actorProjectId;
      if (!allowed) return restricted;
    }
    return {
      ...base,
      status: "authorized",
      kind: surface.kind,
      title: surface.titleSnapshot.slice(0, 300),
      ...(surface.kind === "browser" ? { browserTabId: surface.config.browserTabId } : {}),
      ...(surface.kind === "terminal" ? { terminalId: surface.config.terminalSessionId } : {}),
    };
  });
});
