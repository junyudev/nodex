import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { WorkbenchObservedTab } from "../../shared/nodex-app-tools/workbench";
import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { WorkbenchContentRouting } from "./WorkbenchContentRouting";
import { workbenchObservationHandle } from "./workbench-observation-page";

export const make = Effect.gen(function* () {
  const content = yield* WorkbenchContentRouting;
  return Effect.fn("WorkbenchTabDescription.describe")(function* (input: {
    readonly observationId: string;
    readonly tab: WorkbenchObservedTab;
    readonly sceneOwner: WorkbenchSceneOwner;
    readonly authority: NodexAgentTurnContext;
    readonly callId: string;

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
    const unavailable = { ...base, status: "unavailable" };
    const surface = tab.surface;
    if (
      input.requireExactTarget &&
      surface?.kind === "db_view" &&
      surface.config.target.kind !== "database-view"
    )
      return { ...base, status: "unavailable" };
    if (
      surface &&
      (surface.kind === "page_stage" ||
        surface.kind === "db_view" ||
        surface.kind === "canvas_stage")
    ) {
      const description = yield* content.describe({
        authority,
        callId: input.callId,

        surface,
      });
      return description.status === "unavailable"
        ? { ...base, ...description }
        : { ...base, ...description, title: description.title.slice(0, 300) };
    }
    if (surface?.kind === "image_editor" || tab.auxiliary?.kind === "image_editor")
      return unavailable;
    if (!surface)
      return {
        ...base,
        status: "available",
        kind: tab.auxiliary!.kind,
        title: tab.auxiliary!.title.slice(0, 300),
      };
    if (surface.kind === "conversation") {
      return {
        ...base,
        status: "available",
        kind: "conversation",
        sessionId: surface.config.sessionId,
        title: surface.titleSnapshot.slice(0, 300),
      };
    }
    if (surface.kind === "files" || surface.kind === "review") {
      return {
        ...base,
        status: "available",
        kind: surface.kind,
        projectId: surface.config.projectId,
        ...(surface.kind === "files"
          ? {
              hostId: surface.config.hostId,
              path: surface.config.path ?? null,
              workspaceRoot: surface.config.workspaceRoot,
              cwd: surface.config.cwd,
            }
          : {}),
        title: surface.titleSnapshot.slice(0, 300),
      };
    }
    return {
      ...base,
      status: "available",
      kind: surface.kind,
      title: surface.titleSnapshot.slice(0, 300),
      ...(surface.kind === "browser" ? { browserTabId: surface.config.browserTabId } : {}),
      ...(surface.kind === "terminal" ? { terminalId: surface.config.terminalSessionId } : {}),
    };
  });
});
