import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import { sidebarSchemas } from "../../shared/nodex-app-tools/sidebar-schemas";
import { sessionSchemas } from "../../shared/nodex-app-tools/session-schemas";
import type {
  BuiltinSidebarLane,
  SidebarSectionItemRef,
  SidebarSectionSummary,
  SidebarSectionWindow,
} from "../../shared/sidebar-sections";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { ProjectWorkspace, ProjectWorkspaceError } from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import {
  ProjectSessionCommands,
  ProjectSessionCommandsError,
} from "../project-application/ProjectSessionCommands";
import { toolFailure, toolSuccess } from "./app-tool-result";

const builtinLane = (
  section: SidebarSectionSummary,
  itemKind: "project" | "session",
): BuiltinSidebarLane | null => {
  if (section.kind === "pinned")
    return itemKind === "project" ? "pinned_projects" : "pinned_sessions";
  if (section.kind === "projects" && itemKind === "project") return "projects";
  return null;
};

export const make = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const sessions = yield* ProjectSessionCommands;
  const turns = yield* CodexTurnAuthority;
  const identity = yield* CoreAuthority;

  const findSection = Effect.fn("WorkspaceAppTools.findSection")(function* (sectionId: string) {
    let after: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const window: SidebarSectionWindow = yield* workspace.listSidebarSections({
        after,
        first: 100,
      });
      const found = window.items.find((section) => section.sectionId === sectionId);
      if (found) return found;
      if (!window.nextCursor || window.nextCursor === after) return null;
      after = window.nextCursor;
    }
    return null;
  });

  const move = Effect.fn("WorkspaceAppTools.move")(function* (
    operationId: string,
    item: SidebarSectionItemRef,
    sectionId: string | null,
  ) {
    const section: SidebarSectionSummary | null = sectionId ? yield* findSection(sectionId) : null;
    if (sectionId && !section) return toolFailure("section_unavailable");
    if (section?.kind === "pages") return toolFailure("invalid_section_target");
    if (section?.kind === "pinned") {
      const result =
        item.kind === "project"
          ? yield* workspace.setProjectPinned({
              operationId,
              payload: { projectId: item.projectId, pinned: true },
            })
          : yield* workspace.setProjectSessionPinned({
              operationId,
              payload: { sessionId: item.sessionId, pinned: true },
            });
      return toolSuccess({ operationId, sectionId, receipt: result.apply });
    }
    if (
      (section?.kind === "projects" && item.kind !== "project") ||
      (section?.kind === "chats" && item.kind !== "session")
    )
      return toolFailure("invalid_section_target");
    const result = yield* workspace.moveSidebarSectionItem({
      operationId,
      payload: {
        item,
        sectionId: section?.kind === "custom" ? section.sectionId : null,
        placement: { kind: "end" },
      },
    });
    return toolSuccess({
      operationId,
      sectionId: section?.sectionId ?? null,
      receipt: result.apply,
    });
  });

  const dispatch = Effect.fn("WorkspaceAppTools.dispatch")(function* (
    input: AppToolInvocation,
    defaultOperationId: string,
  ): Effect.fn.Return<CallToolResult, ProjectWorkspaceError | ProjectSessionCommandsError> {
    if (input.name === "set_session_title") {
      const parsed = sessionSchemas.set_session_title.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const sessionId =
        parsed.data.sessionId ?? (yield* workspace.getThread(input.caller.threadId))?.sessionId;
      if (!sessionId) return toolFailure("session_unavailable");
      const operationId = parsed.data.operationId ?? defaultOperationId;
      const result = yield* sessions.rename({
        operationId,
        payload: { sessionId, input: { title: parsed.data.title } },
      });
      return toolSuccess({
        operationId,
        sessionId: result.value.id,
        title: result.value.displayTitle,
        receipt: result.apply,
      });
    }
    if (input.name === "set_session_archived" || input.name === "set_session_pinned") {
      const parsed = sessionSchemas[input.name].safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const sessionId =
        parsed.data.sessionId ?? (yield* workspace.getThread(input.caller.threadId))?.sessionId;
      if (!sessionId) return toolFailure("session_unavailable");
      const operationId = parsed.data.operationId ?? defaultOperationId;
      const command = { operationId, payload: { sessionId } };
      const result =
        "archived" in parsed.data
          ? yield* parsed.data.archived ? sessions.archive(command) : sessions.unarchive(command)
          : yield* sessions.setPinned({
              operationId,
              payload: { sessionId, pinned: parsed.data.pinned },
            });
      return toolSuccess({
        operationId,
        sessionId: result.value.id,
        archived: result.value.archived,
        pinned: result.value.pinned,
        receipt: result.apply,
      });
    }
    if (input.name === "list_sidebar_order") {
      const parsed = sidebarSchemas.list_sidebar_order.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const { sectionId, itemKind, ...windowInput } = parsed.data;
      const section = yield* findSection(sectionId);
      if (!section) return toolFailure("section_unavailable");
      const lane = builtinLane(section, itemKind);
      if (!lane) return toolFailure("invalid_section_target");
      const window = yield* workspace.listBuiltinSidebarOrder(lane, windowInput);
      return toolSuccess({ sectionId, itemKind, ...window });
    }
    if (input.name === "reorder_sidebar_projects") {
      const parsed = sidebarSchemas.reorder_sidebar_projects.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const {
        operationId = defaultOperationId,
        sectionId,
        projectIds,
        expectedOrderRevision,
      } = parsed.data;
      const section = yield* findSection(sectionId);
      if (!section) return toolFailure("section_unavailable");
      const lane = builtinLane(section, "project");
      if (!lane || lane === "pinned_sessions") return toolFailure("invalid_section_target");
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const result = yield* workspace.prioritizeBuiltinSidebarProjects({
        operationId,
        payload: { lane, projectIds, expectedOrderRevision },
      });
      return toolSuccess({ operationId, receipt: result.apply });
    }
    if (input.name === "list_sidebar_section_items") {
      const parsed = sidebarSchemas.list_sidebar_section_items.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const { sectionId, ...windowInput } = parsed.data;
      const window = yield* workspace.listSidebarSectionItems(sectionId, {
        ...windowInput,
        includeArchived: true,
      });
      return toolSuccess({
        ...window,
        items: window.items.map((item) => ({
          placementId: item.placementId,
          revision: item.revision,
          rankKey: item.rankKey,
          ...(item.kind === "project"
            ? {
                kind: item.kind,
                projectId: item.project.projectId,
                title: item.project.name,
                archived: item.project.lifecycle === "archived",
              }
            : {
                kind: item.kind,
                sessionId: item.session.id,
                title: item.session.displayTitle,
                archived: item.session.archived,
              }),
        })),
      });
    }
    if (input.name === "reorder_section") {
      const parsed = sidebarSchemas.reorder_section.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const { operationId = defaultOperationId, ...payload } = parsed.data;
      if ("sessionIds" in payload) {
        const section = yield* findSection(payload.sectionId);
        if (!section) return toolFailure("section_unavailable");
        if (section.kind !== "pinned") return toolFailure("invalid_section_target");
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        const result = yield* workspace.reorderBuiltinSidebarItems({
          operationId,
          payload: {
            lane: "pinned_sessions",
            itemIds: payload.sessionIds,
            expectedOrderRevision: payload.expectedOrderRevision,
          },
        });
        return toolSuccess({ operationId, receipt: result.apply });
      }
      const result = yield* workspace.reorderSidebarSectionItems({ operationId, payload });
      return toolSuccess({ operationId, receipt: result.apply });
    }
    if (input.name === "list_sidebar_sections") {
      const parsed = sidebarSchemas.list_sidebar_sections.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const window = yield* workspace.listSidebarSections(parsed.data);
      return toolSuccess({ ...window });
    }
    if (input.name === "create_sidebar_section") {
      const parsed = sidebarSchemas.create_sidebar_section.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const operationId = parsed.data.operationId ?? defaultOperationId;
      const result = yield* workspace.createSidebarSection({
        operationId,
        payload: {
          sectionId: `app-section:${createHash("sha256").update(operationId).digest("hex")}`,
          input: { name: parsed.data.name },
        },
      });
      return toolSuccess({ operationId, section: result.value, receipt: result.apply });
    }
    if (input.name === "rename_sidebar_section") {
      const parsed = sidebarSchemas.rename_sidebar_section.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const operationId = parsed.data.operationId ?? defaultOperationId;
      const result = yield* workspace.renameSidebarSection({
        operationId,
        payload: {
          sectionId: parsed.data.sectionId,
          input: { name: parsed.data.name, expectedRevision: parsed.data.expectedRevision },
        },
      });
      return toolSuccess({ operationId, section: result.value, receipt: result.apply });
    }
    if (input.name === "delete_sidebar_section") {
      const parsed = sidebarSchemas.delete_sidebar_section.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const operationId = parsed.data.operationId ?? defaultOperationId;
      const result = yield* workspace.deleteSidebarSection({
        operationId,
        payload: {
          sectionId: parsed.data.sectionId,
          expectedRevision: parsed.data.expectedRevision,
        },
      });
      return toolSuccess({ operationId, deleted: true, receipt: result.apply });
    }
    if (input.name === "move_project_to_sidebar_section") {
      const parsed = sidebarSchemas.move_project_to_sidebar_section.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      return yield* move(
        parsed.data.operationId ?? defaultOperationId,
        { kind: "project", projectId: parsed.data.projectId },
        parsed.data.sectionId,
      );
    }
    if (input.name === "move_session_to_sidebar_section") {
      const parsed = sidebarSchemas.move_session_to_sidebar_section.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      return yield* move(
        parsed.data.operationId ?? defaultOperationId,
        { kind: "session", sessionId: parsed.data.sessionId },
        parsed.data.sectionId,
      );
    }
    if (input.name === "reorder_sidebar_sections") {
      const parsed = sidebarSchemas.reorder_sidebar_sections.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const operationId = parsed.data.operationId ?? defaultOperationId;
      const result = yield* workspace.reorderSidebarSections({
        operationId,
        payload: { sectionIds: parsed.data.sectionIds },
      });
      return toolSuccess({ operationId, receipt: result.apply });
    }
    return toolFailure("unknown_tool");
  });

  return Effect.fn("WorkspaceAppTools.execute")(function* (input: AppToolInvocation) {
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    if (
      input.name === "list_sidebar_sections" ||
      input.name === "list_sidebar_section_items" ||
      input.name === "list_sidebar_order"
    )
      return yield* dispatch(input, "").pipe(
        Effect.catch(() => Effect.succeed(toolFailure("sidebar_unavailable"))),
      );
    const authority = yield* turns
      .capture(input.caller.threadId, input.caller.turnId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!authority) return toolFailure("authority_unavailable");
    if (authority.readOnly) return toolFailure("read_only_turn");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const operationId = createStableOperationId(`app.${input.name}`, authority.frozenAtMs, [
      identity.identity.profileId,
      input.caller.threadId,
      input.caller.turnId,
      input.caller.callId,
    ]);
    return yield* dispatch(input, operationId).pipe(
      Effect.provideService(
        CoreApplicationAgent,
        toCoreAgentTurnProvenance(identity.identity.profileId, authority),
      ),
      Effect.catch((error) => {
        if (error instanceof ProjectSessionCommandsError && error.committedOperationId) {
          return Effect.succeed(
            toolFailure(
              "session_reconciliation_failed",
              "The Session change committed, but backend synchronization failed. Retry with the same operationId.",
              { operationId: error.committedOperationId, committed: true },
            ),
          );
        }
        const workspaceError = error instanceof ProjectSessionCommandsError ? error.cause : error;
        const rootCause =
          workspaceError instanceof ProjectWorkspaceError ? workspaceError.cause : workspaceError;
        const cause = rootCause instanceof CoreRuntimeError ? rootCause.cause : rootCause;
        return Effect.succeed(
          cause instanceof CoreModuleResponseError
            ? toolFailure(cause.coreError.code, cause.coreError.message)
            : toolFailure("workspace_command_failed"),
        );
      }),
    );
  });
});
