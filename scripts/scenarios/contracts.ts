import type {
  CodexThreadActiveFlag,
  CodexThreadStatusType,
  PageChatActivitySummaryResult,
  PageChatWindow,
  Project,
  ProjectCreateInput,
} from "../../src/shared/types";
import type { WorkflowStatus } from "../../src/shared/workflow-status";
import type {
  DatabaseApplyResultV2,
  DatabaseApplyV2,
  DatabaseModuleReadRequestV2,
  DatabaseModuleReadResultV2,
} from "../../src/shared/database-module-v2";
import type {
  SidebarSectionCreateInput,
  SidebarSectionItemWindow,
  SidebarSectionMoveItemInput,
  SidebarSectionSessionCreateInput,
  SidebarSectionSummary,
} from "../../src/shared/sidebar-sections";
import type { ProjectSession } from "../../src/shared/types";
import type {
  LibraryFile,
  LibraryPageFileEntryReceipt,
  LibraryPageFileInventory,
} from "../../src/shared/library-files";

export const SCENARIO_MANIFEST_VERSION = 1 as const;

export interface ScenarioPageSeed {
  readonly key: string;
  readonly pageId: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly status: WorkflowStatus;
  readonly title: string;
  readonly nfm: string;
}

export interface ScenarioStandalonePageSeed {
  readonly parentPageId?: string;
  readonly beforeBlockId?: string;
  readonly pageId: string;
  readonly documentId: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly title: string;
}

export interface ScenarioDocumentReplacement {
  readonly mutationId: string;
  readonly operationId: string;
  readonly clientSessionId: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly nfm: string;
}

export interface ScenarioLibraryFileSeed {
  readonly operationId: string;
  readonly projectId: string;
  readonly fileId: string;
  readonly defaultName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ScenarioPageFileEntrySeed {
  readonly operationId: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly fileId: string;
  readonly logicalPath: string;
  readonly expectedManifestRevision: number;
}

export interface ScenarioDocumentCheckpointSeed {
  readonly operationId: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly documentId: string;
  readonly label: string;
}

export interface ScenarioPageObservation {
  readonly pageId: string;
  readonly title: string;
  readonly descriptionPreview: string;
  readonly documentReadiness: "pending_genesis" | "ready" | "failed";
  readonly commitSeq: number;
}

export interface ScenarioBoardObservation {
  readonly totalRows: number;
  readonly commitSeq: number;
  readonly groups: Readonly<Record<WorkflowStatus, number>>;
}

/** A production-shaped Chat seed. Page links are committed with Session creation. */
export interface ScenarioRelatedChatSeed {
  readonly projectId: string;
  readonly initialPageIds: readonly string[];
  readonly noThreadFallbackTitle: string;
  readonly thread?: {
    readonly threadId: string;
    readonly threadName: string;
    readonly threadPreview: string;
    readonly statusType: CodexThreadStatusType;
    readonly statusActiveFlags: readonly CodexThreadActiveFlag[];
    readonly unread: boolean;
  };
}

export interface ScenarioRelatedChatSeedResult {
  readonly sessionId: string;
  readonly threadId: string | null;
}

export interface ScenarioSeedPort {
  createProject(input: ProjectCreateInput): Promise<Project>;
  createPage(input: ScenarioPageSeed): Promise<{ readonly documentId: string }>;
  createStandalonePage(input: ScenarioStandalonePageSeed): Promise<void>;
  createStandaloneCanvas(input: {
    readonly projectId: string;
    readonly canvasId: string;
    readonly documentId: string;
    readonly name: string;
  }): Promise<void>;
  ensurePrimaryDataSourcePropertyCount(
    projectId: string,
    count: number,
  ): Promise<{ readonly commitSeq: number; readonly propertyCount: number }>;
  readPrimaryDataSourcePropertyCount(projectId: string): Promise<number>;
  readDatabase(request: DatabaseModuleReadRequestV2): Promise<DatabaseModuleReadResultV2>;
  applyDatabase(request: DatabaseApplyV2): Promise<DatabaseApplyResultV2>;
  replaceOwnedDocument(
    input: ScenarioDocumentReplacement,
  ): Promise<{ readonly commitSeq: number; readonly createdBlockIds: readonly string[] }>;
  createLibraryFile(input: ScenarioLibraryFileSeed): Promise<LibraryFile>;
  addPageFileEntry(input: ScenarioPageFileEntrySeed): Promise<LibraryPageFileEntryReceipt>;
  readPageFileInventory(projectId: string, pageId: string): Promise<LibraryPageFileInventory>;
  createDocumentCheckpoint(input: ScenarioDocumentCheckpointSeed): Promise<string>;
  readPage(
    projectId: string,
    pageId: string,
    minimumCommitSeq?: number,
  ): Promise<ScenarioPageObservation>;
  readBoard(
    projectId: string,
    databaseViewId: string,
    minimumCommitSeq?: number,
  ): Promise<ScenarioBoardObservation>;
  createRelatedChat(input: ScenarioRelatedChatSeed): Promise<ScenarioRelatedChatSeedResult>;
  readPageChatActivity(
    projectId: string,
    pageIds: readonly string[],
  ): Promise<PageChatActivitySummaryResult>;
  readPageChats(projectId: string, pageId: string): Promise<PageChatWindow>;
  createSidebarSection(input: SidebarSectionCreateInput): Promise<SidebarSectionSummary>;
  createSessionInSidebarSection(input: SidebarSectionSessionCreateInput): Promise<ProjectSession>;
  moveSidebarSectionItem(input: SidebarSectionMoveItemInput): Promise<void>;
  listSidebarSections(): Promise<readonly SidebarSectionSummary[]>;
  listSidebarSectionItems(sectionId: string): Promise<SidebarSectionItemWindow>;
}

export interface ScenarioManifest {
  readonly version: typeof SCENARIO_MANIFEST_VERSION;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly projectId: string;
  readonly databaseViewId: string;
  readonly pageIdsByKey: Readonly<Record<string, string>>;
  /** Stable identities for non-Page entities needed by inspection and UI acceptance. */
  readonly entityIdsByKey?: Readonly<Record<string, string>>;
  readonly minimumCommitSeq: number;
  readonly materializedAt: string;
}

export interface ScenarioFacts {
  readonly scenarioId: string;
  readonly scenarioRevision: number;
}

export interface ScenarioDomainRecipe {
  readonly id: string;
  readonly revision: number;
  materialize(port: ScenarioSeedPort, workspace: string): Promise<ScenarioManifest>;
  inspect(port: ScenarioSeedPort, manifest: ScenarioManifest): Promise<ScenarioFacts>;
  parseFacts(value: unknown): ScenarioFacts;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const parseScenarioManifest = (value: unknown): ScenarioManifest => {
  if (!isRecord(value) || value.version !== SCENARIO_MANIFEST_VERSION) {
    throw new Error("Scenario manifest is invalid or unsupported");
  }
  if (
    !isNonEmptyString(value.scenarioId) ||
    typeof value.scenarioRevision !== "number" ||
    !isNonEmptyString(value.projectId) ||
    !isNonEmptyString(value.databaseViewId) ||
    typeof value.minimumCommitSeq !== "number" ||
    value.minimumCommitSeq < 0 ||
    !isNonEmptyString(value.materializedAt) ||
    !isRecord(value.pageIdsByKey) ||
    !Object.values(value.pageIdsByKey).every(isNonEmptyString) ||
    (value.entityIdsByKey !== undefined &&
      (!isRecord(value.entityIdsByKey) ||
        !Object.values(value.entityIdsByKey).every(isNonEmptyString)))
  ) {
    throw new Error("Scenario manifest is invalid or unsupported");
  }
  return value as unknown as ScenarioManifest;
};

export const parseScenarioFacts = (value: unknown): ScenarioFacts => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.scenarioId) ||
    typeof value.scenarioRevision !== "number"
  ) {
    throw new Error("Scenario facts are invalid");
  }
  return value as unknown as ScenarioFacts;
};
