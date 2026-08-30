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
} from "./types";
import type {
  SidebarSectionArchiveInput,
  SidebarSectionCreateInput,
  SidebarSectionMoveItemInput,
  SidebarSectionRenameInput,
  SidebarSectionRevisionInput,
  SidebarSectionSessionCreateInput,
} from "./sidebar-sections";

export interface OperationIdentifiedCommand<Payload> {
  readonly operationId: string;
  readonly payload: Payload;
}

export interface ProjectCreateCommandPayload {
  readonly projectId: string;
  readonly input: ProjectCreateInput;
}

export interface ProjectPinnedCommandPayload extends ProjectPinnedInput {
  readonly projectId: string;
}

export interface ProjectLifecycleCommandPayload extends ProjectLifecycleInput {
  readonly projectId: string;
}

export type ProjectCreateCommandInput = OperationIdentifiedCommand<ProjectCreateCommandPayload>;
export type ProjectReorderCommandInput = OperationIdentifiedCommand<ProjectOrderInput>;
export type ProjectPinnedCommandInput = OperationIdentifiedCommand<ProjectPinnedCommandPayload>;
export type ProjectPinnedOrderCommandInput = OperationIdentifiedCommand<ProjectPinnedOrderInput>;
export type ProjectLifecycleCommandInput =
  OperationIdentifiedCommand<ProjectLifecycleCommandPayload>;
export type ProjectLifecycleCommittedValue = Extract<
  ProjectLifecycleMutationResult,
  { readonly kind: "updated" }
>;
export interface ProjectLifecycleCommandRejected {
  readonly ok: false;
  readonly outcome: Exclude<ProjectLifecycleMutationResult, { readonly kind: "updated" }>;
}

export interface ProjectSessionIdentityPayload {
  readonly sessionId: string;
}

export interface ProjectSessionCreateCommandPayload {
  readonly sessionId: string;
  readonly input: ProjectSessionCreateInput;
}

export interface ProjectSessionEnsureDefaultDraftCommandPayload {
  readonly candidateSessionId: string;
  readonly projectId: string | null;
}

export interface ProjectSessionUpdateCommandPayload extends ProjectSessionIdentityPayload {
  readonly input: ProjectSessionUpdateInput;
}

export interface ProjectSessionRenameCommandPayload extends ProjectSessionIdentityPayload {
  readonly input: ProjectSessionRenameInput;
}

export interface ProjectSessionPinnedCommandPayload
  extends ProjectSessionIdentityPayload, ProjectSessionPinnedInput {}

export interface ProjectSessionUnreadCommandPayload
  extends ProjectSessionIdentityPayload, ProjectSessionUnreadInput {}

export interface ProjectSessionReorderCommandPayload {
  readonly projectId: string | null;
  readonly orderedSessionIds: readonly string[];
}

export interface ProjectSessionPinnedOrderCommandPayload extends ProjectSessionPinnedOrderInput {
  readonly projectId: string;
}

export type ProjectSessionCreateCommandInput =
  OperationIdentifiedCommand<ProjectSessionCreateCommandPayload>;
export type ProjectSessionEnsureDefaultDraftCommandInput =
  OperationIdentifiedCommand<ProjectSessionEnsureDefaultDraftCommandPayload>;
export type ProjectSessionUpdateCommandInput =
  OperationIdentifiedCommand<ProjectSessionUpdateCommandPayload>;
export type ProjectSessionRenameCommandInput =
  OperationIdentifiedCommand<ProjectSessionRenameCommandPayload>;
export type ProjectSessionDeleteCommandInput =
  OperationIdentifiedCommand<ProjectSessionIdentityPayload>;
export type ProjectSessionReorderCommandInput =
  OperationIdentifiedCommand<ProjectSessionReorderCommandPayload>;
export type ProjectSessionPinnedCommandInput =
  OperationIdentifiedCommand<ProjectSessionPinnedCommandPayload>;
export type ProjectSessionPinnedOrderCommandInput =
  OperationIdentifiedCommand<ProjectSessionPinnedOrderCommandPayload>;
export type ProjectSessionArchiveCommandInput =
  OperationIdentifiedCommand<ProjectSessionIdentityPayload>;
export type ProjectSessionUnreadCommandInput =
  OperationIdentifiedCommand<ProjectSessionUnreadCommandPayload>;

export interface SidebarSectionIdentityPayload {
  readonly sectionId: string;
}

export interface SidebarSectionCreateCommandPayload {
  readonly sectionId: string;
  readonly input: SidebarSectionCreateInput;
}

export interface SidebarSectionRenameCommandPayload extends SidebarSectionIdentityPayload {
  readonly input: SidebarSectionRenameInput;
}

export interface SidebarSectionRevisionCommandPayload
  extends SidebarSectionIdentityPayload, SidebarSectionRevisionInput {}

export interface SidebarSectionSessionsReorderCommandPayload extends SidebarSectionIdentityPayload {
  readonly orderedSessionIds: readonly string[];
}

export interface SidebarSectionSessionsArchiveCommandPayload extends SidebarSectionIdentityPayload {
  readonly input?: SidebarSectionArchiveInput;
  readonly replacementSessionId: string | null;
}

export interface SidebarSectionSessionCreateCommandPayload {
  readonly sessionId: string;
  readonly input: SidebarSectionSessionCreateInput;
}

export type SidebarSectionCreateCommandInput =
  OperationIdentifiedCommand<SidebarSectionCreateCommandPayload>;
export type SidebarSectionRenameCommandInput =
  OperationIdentifiedCommand<SidebarSectionRenameCommandPayload>;
export type SidebarSectionDeleteCommandInput =
  OperationIdentifiedCommand<SidebarSectionRevisionCommandPayload>;
export type SidebarSectionRestoreCommandInput =
  OperationIdentifiedCommand<SidebarSectionRevisionCommandPayload>;
export type SidebarSectionMoveItemCommandInput =
  OperationIdentifiedCommand<SidebarSectionMoveItemInput>;
export type SidebarSectionReorderCommandInput = OperationIdentifiedCommand<{
  readonly sectionIds: readonly string[];
}>;
export type SidebarSectionSessionsReorderCommandInput =
  OperationIdentifiedCommand<SidebarSectionSessionsReorderCommandPayload>;
export type SidebarSectionSessionsArchiveCommandInput =
  OperationIdentifiedCommand<SidebarSectionSessionsArchiveCommandPayload>;
export type SidebarSectionSessionCreateCommandInput =
  OperationIdentifiedCommand<SidebarSectionSessionCreateCommandPayload>;
