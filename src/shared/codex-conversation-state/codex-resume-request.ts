import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type { ThreadResumeParams } from "@nodex/codex-app-server-protocol/v2/ThreadResumeParams";
import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2/TurnStartParams";
import { workspaceRootsForCwd } from "../codex-workspace-paths";
import {
  type CanonicalResumeOverrides,
  type CanonicalResumePreparation,
  type ConversationResumePermissionContext,
} from "./codex-resume-permissions";

type ResumeConfig = NonNullable<ThreadResumeParams["config"]>;

export const CODEX_FULL_ACCESS_EXECUTION = {
  approvalPolicy: "never",
  approvalsReviewer: "user",
  permissions: ":danger-full-access",
} as const satisfies Pick<
  ThreadResumeParams,
  "approvalPolicy" | "approvalsReviewer" | "permissions"
>;

/** Resume options describe physical workspace and model selection. */
export interface ConversationResumePreparationOptions {
  /** Model hint used to materialize model-scoped execution settings before the physical resume. */
  readonly model?: string | null;

  readonly preserveServerConfiguration?: boolean;
  readonly serviceTier?: ThreadResumeParams["serviceTier"];
  /** Manager-only resume context. It must not be projected onto ThreadResumeParams directly. */
  readonly workspaceRoots?: readonly string[];
  /** Manager-only history/context fallback captured with queued input. */
  readonly collaborationMode?: TurnStartParams["collaborationMode"] | null;
}

/** A suppressed wire field does not erase the context used to interpret the server response. */
export function prepareConversationResumePermissionContext(input: {
  readonly preparation: CanonicalResumePreparation;
  readonly request: ThreadResumeParams;
  readonly hostId: string;
  readonly status?: Thread["status"];
  readonly options: ConversationResumePreparationOptions;
}): ConversationResumePermissionContext {
  const { preparation, request, options } = input;
  const preservesConfiguration =
    input.hostId === "durable" && options.preserveServerConfiguration === true;
  const roots = preservesConfiguration
    ? []
    : workspaceRootsForCwd(preparation.overrides.cwd ?? null, request.runtimeWorkspaceRoots ?? []);
  return {
    requestedPermissions: {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      activePermissionProfile: { id: ":danger-full-access", extends: null },
      sandboxPolicy: { type: "dangerFullAccess" },
      runtimeWorkspaceRoots: roots,
    },
    runtimeWorkspaceRootCandidates: preservesConfiguration ? null : [...roots],
  };
}

/** Builds the same native request for Main and window-owned conversation preparation. */
export function buildConversationResumeRequest(
  input: ConversationResumePreparationOptions & {
    readonly hostId: string;
    readonly threadId: string;
    readonly metadata: Thread | null;
    readonly historyMode?: Thread["historyMode"];
    readonly rolloutPath?: string | null;
    readonly supportsPaginatedHistory: boolean;
    readonly overrides: CanonicalResumeOverrides;
    readonly config: ResumeConfig;
    readonly baseInstructions?: string | null;
    readonly developerInstructions?: string | null;
  },
): ThreadResumeParams {
  const durable = input.hostId === "durable";
  const execution = CODEX_FULL_ACCESS_EXECUTION;
  if (durable && input.preserveServerConfiguration === true)
    return { threadId: input.threadId, excludeTurns: false, ...execution };
  const overrides = {
    cwd: input.overrides.cwd,
    runtimeWorkspaceRoots: input.overrides.runtimeWorkspaceRoots,
    serviceTier: input.overrides.serviceTier,
    personality: input.overrides.personality,
  };
  const config = input.config;
  const entries = Object.entries(config).filter(([key, value]) => {
    if (value == null) return false;
    return (
      key !== "profiles" ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length > 0
    );
  });
  const changesConfiguration = entries.length > 0;
  const reuseIdleConfiguration =
    input.metadata?.status.type === "idle" && input.serviceTier == null && !changesConfiguration;
  const paginated =
    !durable &&
    input.supportsPaginatedHistory &&
    (input.metadata?.historyMode ?? input.historyMode) === "paginated";
  const serviceTier =
    overrides.serviceTier === undefined ? input.serviceTier : overrides.serviceTier;

  const request: ThreadResumeParams = {
    threadId: input.threadId,
    ...(overrides.runtimeWorkspaceRoots === undefined
      ? {}
      : { runtimeWorkspaceRoots: overrides.runtimeWorkspaceRoots }),
    ...(overrides.personality === undefined ? {} : { personality: overrides.personality }),
    ...execution,
    ...(serviceTier === undefined ? {} : { serviceTier }),
    history: null,
    path: input.metadata ? input.metadata.path : input.rolloutPath || null,
    model: null,
    ...(overrides.cwd != null
      ? { cwd: overrides.cwd }
      : input.metadata?.cwd
        ? { cwd: input.metadata.cwd }
        : {}),
    ...(reuseIdleConfiguration
      ? {}
      : {
          ...(input.baseInstructions == null ? {} : { baseInstructions: input.baseInstructions }),
          ...(input.developerInstructions == null
            ? {}
            : { developerInstructions: input.developerInstructions }),
          ...(entries.length === 0 ? {} : { config }),
        }),
    excludeTurns: !durable,
    ...(durable || paginated
      ? {}
      : { initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } }),
  };
  return request;
}
