import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { NodexAgentResourceAccessOverlay } from "../../shared/nodex-agent-resource-access";
import { workbenchControlSchemas as schemas } from "../../shared/nodex-app-tools/workbench-control-schemas";
import type { WorkbenchCommand } from "../../shared/nodex-app-tools/workbench-commands";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import { WorkbenchObservation, type WorkbenchObservationPrincipal } from "./WorkbenchObservation";
import { make as makeDescription } from "./WorkbenchTabDescription";
import { make as makeOpenTarget } from "./WorkbenchOpenTarget";
import { workbenchObservationHandle } from "./workbench-observation-page";
import { toolFailure, toolSuccess } from "./app-tool-result";

export interface WorkbenchAppToolContext {
  readonly invocation: AppToolInvocation;
  readonly principal: WorkbenchObservationPrincipal;
  readonly authority: FrozenNodexAgentTurnAuthority;
  readonly taskAccess?: NodexAgentResourceAccessOverlay;
  readonly isCurrent: Effect.Effect<boolean>;
}

export const make = Effect.gen(function* () {
  const observations = yield* WorkbenchObservation;
  const bridge = yield* WorkbenchAgentBridge;
  const describe = yield* makeDescription;
  const openTarget = yield* makeOpenTarget;
  const workspace = yield* ProjectWorkspace;
  return Effect.fn("WorkbenchControl.execute")(function* (context: WorkbenchAppToolContext) {
    const { invocation: input, authority, principal } = context;
    if (authority.readOnly) return toolFailure("read_only_turn");
    const schema = schemas[input.name as keyof typeof schemas];
    if (!schema) return toolFailure("unknown_tool");
    const parsed = schema.safeParse(input.arguments);
    if (!parsed.success) return toolFailure("invalid_arguments");
    const record = yield* observations.forCommand(principal, parsed.data.observationId);
    const scene = record.reference.sceneOwner;
    if (
      authority.scope !== "library" &&
      scene.kind === "project" &&
      scene.projectId !== authority.actorProjectId
    )
      return toolFailure("access_denied");
    if (authority.scope !== "library" && scene.kind === "session") {
      const session = yield* workspace
        .getProjectSession(scene.sessionId)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!session || session.projectId !== authority.actorProjectId)
        return toolFailure("access_denied");
    }
    const operationId =
      parsed.data.operationId ??
      createStableOperationId(`app.${input.name}`, authority.frozenAtMs, [
        principal.profileId,
        input.caller.threadId,
        input.caller.turnId,
        input.caller.callId,
      ]);
    const tabFor = (handle: string) =>
      record.observation.tabs.find(
        (tab) => workbenchObservationHandle(record.observationId, "tab", tab.tabId) === handle,
      );
    const groupFor = (handle: string, panelId: "right" | "bottom") =>
      record.observation.groups.find(
        (group) =>
          group.panelId === panelId &&
          workbenchObservationHandle(record.observationId, "group", group.groupId) === handle,
      );
    const allowedTab = Effect.fn("WorkbenchControl.allowedTab")(function* (handle: string) {
      const tab = tabFor(handle);
      if (!tab) return null;
      const result = yield* describe({
        observationId: record.observationId,
        sceneOwner: record.reference.sceneOwner,
        tab,
        authority,
        callId: input.caller.callId,
        taskAccess: context.taskAccess,
      });
      return result.status === "authorized" ? tab : null;
    });
    const translate = Effect.gen(function* (): Effect.fn.Return<WorkbenchCommand | null> {
      if (input.name === "activate_tab" || input.name === "close_tab") {
        const args = schemas[input.name].parse(input.arguments);
        const tab = yield* allowedTab(args.tabId);
        return tab ? { kind: input.name, tabId: tab.tabId } : null;
      }
      if (input.name === "open_tab") {
        const args = schemas.open_tab.parse(input.arguments);
        const group = groupFor(args.groupId, args.panelId);
        if (!group) return null;
        const surface = yield* openTarget({
          target: args.target,
          sceneOwner: record.reference.sceneOwner,
          operationId,
          authority,
          callId: input.caller.callId,
          taskAccess: context.taskAccess,
        });
        return surface
          ? { kind: "open_tab", panelId: args.panelId, groupId: group.groupId, surface }
          : null;
      }
      if (input.name === "move_tab") {
        const args = schemas.move_tab.parse(input.arguments);
        const group = groupFor(args.groupId, args.panelId);
        const tab = yield* allowedTab(args.tabId);
        return group && tab
          ? {
              kind: "move_tab",
              tabId: tab.tabId,
              panelId: args.panelId,
              groupId: group.groupId,
              index: args.index,
              splitSide: args.splitSide,
            }
          : null;
      }
      // Layout-wide commands require read access to every tab they may relocate or reveal.
      const accessible = yield* Effect.forEach(
        record.observation.tabs,
        (tab) => allowedTab(workbenchObservationHandle(record.observationId, "tab", tab.tabId)),
        { concurrency: 4 },
      );
      if (accessible.some((tab) => tab === null)) return null;
      if (input.name === "reorder_tabs") {
        const args = schemas.reorder_tabs.parse(input.arguments);
        const group = groupFor(args.groupId, args.panelId);
        const tabs = args.tabIds.map(tabFor);
        if (
          !group ||
          tabs.some((tab) => !tab || tab.groupId !== group.groupId || tab.panelId !== group.panelId)
        )
          return null;
        return {
          kind: "reorder_tabs",
          panelId: args.panelId,
          groupId: group.groupId,
          tabIds: tabs.map((tab) => tab!.tabId),
        };
      }
      if (input.name === "split_tab_group") {
        const args = schemas.split_tab_group.parse(input.arguments);
        const group = groupFor(args.groupId, args.panelId);
        const tab = args.tabId ? tabFor(args.tabId) : undefined;
        if (!group || (args.tabId && !tab)) return null;
        return {
          kind: "split_group",
          panelId: args.panelId,
          groupId: group.groupId,
          side: args.side,
          tabId: tab?.tabId,
        };
      }
      if (input.name === "merge_tab_group") {
        const args = schemas.merge_tab_group.parse(input.arguments);
        const group = groupFor(args.groupId, args.panelId);
        return group
          ? { kind: "merge_group", panelId: args.panelId, groupId: group.groupId }
          : null;
      }
      if (input.name === "set_panel_state") {
        const args = schemas.set_panel_state.parse(input.arguments);
        const maximized = args.maximizedGroupId
          ? groupFor(args.maximizedGroupId, args.panelId)
          : null;
        if (args.maximizedGroupId && !maximized) return null;
        return {
          kind: "set_panel_state",
          panelId: args.panelId,
          collapsed: args.collapsed,
          size: args.size,
          ...(args.maximizedGroupId !== undefined
            ? { maximizedGroupId: maximized?.groupId ?? null }
            : {}),
        };
      }
      return null;
    });
    const command = yield* translate;
    if (!command) return toolFailure("target_unavailable");
    if (!(yield* context.isCurrent)) return toolFailure("authority_unavailable");
    const result = yield* bridge.request(record.reference, {
      kind: "command",
      envelope: {
        operationId,
        sceneOwner: record.reference.sceneOwner,
        expectedPresentationRevision: record.observation.presentationRevision,
        command,
      },
    });
    const { receipt } = result;
    const outcome = {
      operationId: receipt.operationId,
      applied: receipt.applied,
      persisted: receipt.persisted,
      presentationRevision: receipt.presentationRevision,
      layoutRevision: receipt.layoutRevision,
      refreshRequired: receipt.applied,
    };
    return receipt.error
      ? toolFailure(receipt.error, receipt.error, outcome)
      : toolSuccess(outcome);
  });
});
