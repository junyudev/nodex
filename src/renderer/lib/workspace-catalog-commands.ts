import { createBoundedOperationId } from "../../shared/operation-identity";
import type {
  SidebarSectionArchiveInput,
  SidebarSectionCreateInput,
  SidebarSectionMoveItemInput,
  SidebarSectionRenameInput,
  SidebarSectionRevisionInput,
  SidebarSectionSessionCreateInput,
} from "../../shared/sidebar-sections";
import type {
  ProjectCreateInput,
  ProjectLifecycleInput,
  ProjectLifecycleMutationResult,
  ProjectOrderInput,
  ProjectPinnedInput,
  ProjectPinnedOrderInput,
  ProjectSessionCreateInput,
  ProjectSessionPinnedInput,
  ProjectSessionPinnedOrderInput,
  ProjectSessionRenameInput,
  ProjectSessionUnreadInput,
  ProjectSessionUpdateInput,
} from "../../shared/types";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  defineLocalCommitRendererCommand,
  invokeLocalCommitCommand,
  RendererCommandRejectedError,
} from "./renderer-command";

const receiptFenced = (presentation: "required" | "placeholder" | "pending") =>
  ({ kind: "receipt_fenced_projection", presentation }) as const;

export const workspaceCatalogCommandDefinitions = {
  projectCreate: defineLocalCommitRendererCommand({
    key: "workspace.project.create",
    channel: "projects:create",
    authority: "core",
    owner: "project-catalog",
    protocol: receiptFenced("placeholder"),
  }),
  projectReorder: defineLocalCommitRendererCommand({
    key: "workspace.project.reorder",
    channel: "projects:reorder",
    authority: "core",
    owner: "project-catalog",
    protocol: receiptFenced("pending"),
  }),
  projectSetPinned: defineLocalCommitRendererCommand({
    key: "workspace.project.set-pinned",
    channel: "projects:set-pinned",
    authority: "core",
    owner: "project-catalog",
    protocol: receiptFenced("pending"),
  }),
  projectSetPinnedOrder: defineLocalCommitRendererCommand({
    key: "workspace.project.set-pinned-order",
    channel: "projects:set-pinned-order",
    authority: "core",
    owner: "project-catalog",
    protocol: receiptFenced("pending"),
  }),
  projectSetLifecycle: defineLocalCommitRendererCommand({
    key: "workspace.project.set-lifecycle",
    channel: "projects:set-lifecycle",
    authority: "core",
    owner: "project-catalog",
    protocol: receiptFenced("pending"),
  }),
  sessionCreate: defineLocalCommitRendererCommand({
    key: "workspace.session.create",
    channel: "project-sessions:create",
    authority: "core",
    owner: "workbench-session-catalog",
    protocol: receiptFenced("placeholder"),
  }),
  sessionEnsureDefaultDraft: defineLocalCommitRendererCommand({
    key: "workspace.session.ensure-default-draft",
    channel: "project-sessions:ensure-default-draft",
    authority: "core",
    owner: "workbench-session-catalog",
    protocol: receiptFenced("placeholder"),
  }),
  sessionUpdate: defineLocalCommitRendererCommand({
    key: "workspace.session.update",
    channel: "project-sessions:update",
    authority: "core",
    owner: "workbench-session-catalog",
    protocol: receiptFenced("pending"),
  }),
  sessionRename: defineLocalCommitRendererCommand({
    key: "workspace.session.rename",
    channel: "project-sessions:rename",
    authority: "core",
    owner: "workbench-session-catalog",
    protocol: receiptFenced("pending"),
  }),
  sessionDelete: defineLocalCommitRendererCommand({
    key: "workspace.session.delete",
    channel: "project-sessions:delete",
    authority: "core",
    owner: "workbench-session-catalog",
    protocol: receiptFenced("pending"),
  }),
  sessionReorder: defineLocalCommitRendererCommand({
    key: "workspace.session.reorder",
    channel: "project-sessions:reorder",
    authority: "core",
    owner: "workbench-session-catalog",
    protocol: receiptFenced("pending"),
  }),
  sessionSetPinned: defineLocalCommitRendererCommand({
    key: "workspace.session.set-pinned",
    channel: "project-sessions:set-pinned",
    authority: "core",
    owner: "workbench-session-catalog",
    protocol: receiptFenced("pending"),
  }),
  sessionSetPinnedOrder: defineLocalCommitRendererCommand({
    key: "workspace.session.set-pinned-order",
    channel: "project-sessions:set-pinned-order",
    authority: "core",
    owner: "workbench-session-catalog",
    protocol: receiptFenced("pending"),
  }),
  sessionArchive: defineLocalCommitRendererCommand({
    key: "workspace.session.archive",
    channel: "project-sessions:archive",
    authority: "core",
    owner: "workbench-session-catalog",
    protocol: receiptFenced("pending"),
  }),
  sessionUnarchive: defineLocalCommitRendererCommand({
    key: "workspace.session.unarchive",
    channel: "project-sessions:unarchive",
    authority: "core",
    owner: "workbench-session-catalog",
    protocol: receiptFenced("pending"),
  }),
  sessionMarkUnread: defineLocalCommitRendererCommand({
    key: "workspace.session.mark-unread",
    channel: "project-sessions:mark-unread",
    authority: "core",
    owner: "workbench-session-catalog",
    protocol: receiptFenced("pending"),
  }),
  sidebarCreate: defineLocalCommitRendererCommand({
    key: "workspace.sidebar-section.create",
    channel: "sidebar-sections:create",
    authority: "core",
    owner: "sidebar-sections-catalog",
    protocol: receiptFenced("placeholder"),
  }),
  sidebarRename: defineLocalCommitRendererCommand({
    key: "workspace.sidebar-section.rename",
    channel: "sidebar-sections:rename",
    authority: "core",
    owner: "sidebar-sections-catalog",
    protocol: receiptFenced("pending"),
  }),
  sidebarDelete: defineLocalCommitRendererCommand({
    key: "workspace.sidebar-section.delete",
    channel: "sidebar-sections:delete",
    authority: "core",
    owner: "sidebar-sections-catalog",
    protocol: receiptFenced("pending"),
  }),
  sidebarRestore: defineLocalCommitRendererCommand({
    key: "workspace.sidebar-section.restore",
    channel: "sidebar-sections:restore",
    authority: "core",
    owner: "sidebar-sections-catalog",
    protocol: receiptFenced("pending"),
  }),
  sidebarMoveItem: defineLocalCommitRendererCommand({
    key: "workspace.sidebar-section.move-item",
    channel: "sidebar-sections:item:move",
    authority: "core",
    owner: "sidebar-sections-catalog",
    protocol: receiptFenced("pending"),
  }),
  sidebarReorder: defineLocalCommitRendererCommand({
    key: "workspace.sidebar-section.reorder",
    channel: "sidebar-sections:reorder",
    authority: "core",
    owner: "sidebar-sections-catalog",
    protocol: receiptFenced("pending"),
  }),
  sidebarReorderSessions: defineLocalCommitRendererCommand({
    key: "workspace.sidebar-section.reorder-sessions",
    channel: "sidebar-sections:sessions:reorder",
    authority: "core",
    owner: "sidebar-sections-catalog",
    protocol: receiptFenced("pending"),
  }),
  sidebarArchiveSessions: defineLocalCommitRendererCommand({
    key: "workspace.sidebar-section.archive-sessions",
    channel: "sidebar-sections:sessions:archive-all",
    authority: "core",
    owner: "sidebar-sections-catalog",
    protocol: receiptFenced("pending"),
  }),
  sidebarCreateSession: defineLocalCommitRendererCommand({
    key: "workspace.sidebar-section.create-session",
    channel: "sidebar-sections:sessions:create",
    authority: "core",
    owner: "sidebar-sections-catalog",
    protocol: receiptFenced("placeholder"),
  }),
} as const;

const {
  projectCreate: projectCreateCommand,
  projectReorder: projectReorderCommand,
  projectSetPinned: projectSetPinnedCommand,
  projectSetPinnedOrder: projectSetPinnedOrderCommand,
  projectSetLifecycle: projectSetLifecycleCommand,
  sessionCreate: sessionCreateCommand,
  sessionEnsureDefaultDraft: sessionEnsureDefaultDraftCommand,
  sessionUpdate: sessionUpdateCommand,
  sessionRename: sessionRenameCommand,
  sessionDelete: sessionDeleteCommand,
  sessionReorder: sessionReorderCommand,
  sessionSetPinned: sessionSetPinnedCommand,
  sessionSetPinnedOrder: sessionSetPinnedOrderCommand,
  sessionArchive: sessionArchiveCommand,
  sessionUnarchive: sessionUnarchiveCommand,
  sessionMarkUnread: sessionMarkUnreadCommand,
  sidebarCreate: sidebarCreateCommand,
  sidebarRename: sidebarRenameCommand,
  sidebarDelete: sidebarDeleteCommand,
  sidebarRestore: sidebarRestoreCommand,
  sidebarMoveItem: sidebarMoveItemCommand,
  sidebarReorder: sidebarReorderCommand,
  sidebarReorderSessions: sidebarReorderSessionsCommand,
  sidebarArchiveSessions: sidebarArchiveSessionsCommand,
  sidebarCreateSession: sidebarCreateSessionCommand,
} = workspaceCatalogCommandDefinitions;

const operation = (scope: string) => createBoundedOperationId(`renderer.${scope}`);

export const workspaceProjectCommands = {
  create: async (input: ProjectCreateInput) =>
    (
      await invokeLocalCommitCommand(projectCreateCommand, {
        operationId: operation("project.create"),
        payload: { projectId: createUuidV7(), input },
      })
    ).value,
  reorder: async (input: ProjectOrderInput) =>
    (
      await invokeLocalCommitCommand(projectReorderCommand, {
        operationId: operation("project.reorder"),
        payload: input,
      })
    ).value,
  setPinned: async (projectId: string, input: ProjectPinnedInput) =>
    (
      await invokeLocalCommitCommand(projectSetPinnedCommand, {
        operationId: operation("project.set-pinned"),
        payload: { projectId, ...input },
      })
    ).value,
  setPinnedOrder: async (input: ProjectPinnedOrderInput) =>
    (
      await invokeLocalCommitCommand(projectSetPinnedOrderCommand, {
        operationId: operation("project.set-pinned-order"),
        payload: input,
      })
    ).value,
  setLifecycle: async (
    projectId: string,
    input: ProjectLifecycleInput,
  ): Promise<ProjectLifecycleMutationResult> => {
    try {
      return (
        await invokeLocalCommitCommand(projectSetLifecycleCommand, {
          operationId: operation("project.set-lifecycle"),
          payload: { projectId, ...input },
        })
      ).value;
    } catch (cause) {
      if (cause instanceof RendererCommandRejectedError && "outcome" in cause.result) {
        return cause.result.outcome as ProjectLifecycleMutationResult;
      }
      throw cause;
    }
  },
};

export const workspaceSessionCommands = {
  create: async (input: ProjectSessionCreateInput) =>
    (
      await invokeLocalCommitCommand(sessionCreateCommand, {
        operationId: operation("session.create"),
        payload: { sessionId: createUuidV7(), input },
      })
    ).value,
  ensureDefaultDraft: async (projectId: string | null) =>
    (
      await invokeLocalCommitCommand(sessionEnsureDefaultDraftCommand, {
        operationId: operation("session.ensure-default-draft"),
        payload: { candidateSessionId: createUuidV7(), projectId },
      })
    ).value,
  update: async (sessionId: string, input: ProjectSessionUpdateInput) =>
    (
      await invokeLocalCommitCommand(sessionUpdateCommand, {
        operationId: operation("session.update"),
        payload: { sessionId, input },
      })
    ).value,
  rename: async (sessionId: string, input: ProjectSessionRenameInput) =>
    (
      await invokeLocalCommitCommand(sessionRenameCommand, {
        operationId: operation("session.rename"),
        payload: { sessionId, input },
      })
    ).value,
  delete: async (sessionId: string) =>
    (
      await invokeLocalCommitCommand(sessionDeleteCommand, {
        operationId: operation("session.delete"),
        payload: { sessionId },
      })
    ).value,
  reorder: async (projectId: string | null, orderedSessionIds: readonly string[]) =>
    (
      await invokeLocalCommitCommand(sessionReorderCommand, {
        operationId: operation("session.reorder"),
        payload: { projectId, orderedSessionIds },
      })
    ).value,
  setPinned: async (sessionId: string, input: ProjectSessionPinnedInput) =>
    (
      await invokeLocalCommitCommand(sessionSetPinnedCommand, {
        operationId: operation("session.set-pinned"),
        payload: { sessionId, ...input },
      })
    ).value,
  setPinnedOrder: async (projectId: string, input: ProjectSessionPinnedOrderInput) =>
    (
      await invokeLocalCommitCommand(sessionSetPinnedOrderCommand, {
        operationId: operation("session.set-pinned-order"),
        payload: { projectId, ...input },
      })
    ).value,
  archive: async (sessionId: string) =>
    (
      await invokeLocalCommitCommand(sessionArchiveCommand, {
        operationId: operation("session.archive"),
        payload: { sessionId },
      })
    ).value,
  unarchive: async (sessionId: string) =>
    (
      await invokeLocalCommitCommand(sessionUnarchiveCommand, {
        operationId: operation("session.unarchive"),
        payload: { sessionId },
      })
    ).value,
  markUnread: async (sessionId: string, input: ProjectSessionUnreadInput) =>
    (
      await invokeLocalCommitCommand(sessionMarkUnreadCommand, {
        operationId: operation("session.mark-unread"),
        payload: { sessionId, ...input },
      })
    ).value,
};

export const workspaceSidebarCommands = {
  create: async (input: SidebarSectionCreateInput) =>
    (
      await invokeLocalCommitCommand(sidebarCreateCommand, {
        operationId: operation("sidebar-section.create"),
        payload: { sectionId: createUuidV7(), input },
      })
    ).value,
  rename: async (sectionId: string, input: SidebarSectionRenameInput) =>
    (
      await invokeLocalCommitCommand(sidebarRenameCommand, {
        operationId: operation("sidebar-section.rename"),
        payload: { sectionId, input },
      })
    ).value,
  delete: async (sectionId: string, input: SidebarSectionRevisionInput) =>
    (
      await invokeLocalCommitCommand(sidebarDeleteCommand, {
        operationId: operation("sidebar-section.delete"),
        payload: { sectionId, ...input },
      })
    ).value,
  restore: async (sectionId: string, input: SidebarSectionRevisionInput) =>
    (
      await invokeLocalCommitCommand(sidebarRestoreCommand, {
        operationId: operation("sidebar-section.restore"),
        payload: { sectionId, ...input },
      })
    ).value,
  moveItem: async (input: SidebarSectionMoveItemInput) =>
    (
      await invokeLocalCommitCommand(sidebarMoveItemCommand, {
        operationId: operation("sidebar-section.move-item"),
        payload: input,
      })
    ).value,
  reorder: async (sectionIds: readonly string[]) =>
    (
      await invokeLocalCommitCommand(sidebarReorderCommand, {
        operationId: operation("sidebar-section.reorder"),
        payload: { sectionIds },
      })
    ).value,
  reorderSessions: async (sectionId: string, orderedSessionIds: readonly string[]) =>
    (
      await invokeLocalCommitCommand(sidebarReorderSessionsCommand, {
        operationId: operation("sidebar-section.reorder-sessions"),
        payload: { sectionId, orderedSessionIds },
      })
    ).value,
  archiveSessions: async (sectionId: string, input?: SidebarSectionArchiveInput) =>
    (
      await invokeLocalCommitCommand(sidebarArchiveSessionsCommand, {
        operationId: operation("sidebar-section.archive-sessions"),
        payload: {
          sectionId,
          input,
          replacementSessionId: input?.createReplacement ? createUuidV7() : null,
        },
      })
    ).value,
  createSession: async (input: SidebarSectionSessionCreateInput) =>
    (
      await invokeLocalCommitCommand(sidebarCreateSessionCommand, {
        operationId: operation("sidebar-section.create-session"),
        payload: { sessionId: createUuidV7(), input },
      })
    ).value,
};
