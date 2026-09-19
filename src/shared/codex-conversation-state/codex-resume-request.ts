import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type { ThreadResumeParams } from "@nodex/codex-app-server-protocol/v2/ThreadResumeParams";
import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2/TurnStartParams";
import { workspaceRootsForCwd } from "../codex-workspace-paths";
import {
  withExplicitResumePermissions,
  type CanonicalResumeOverrides,
  type CanonicalResumePreparation,
  type ConversationResumePermissionContext,
} from "./codex-resume-permissions";
import type { CodexCanonicalHydratedPermissionContext } from "./codex-conversation-state";

type ResumeConfig = NonNullable<ThreadResumeParams["config"]>;

/** Caller intent stays separate from permission fields reconstructed from conversation history. */
export interface ConversationResumePreparationOptions {
  /** Model hint used to materialize model-scoped execution settings before the physical resume. */
  readonly model?: string | null;
  readonly permissions?: CodexCanonicalHydratedPermissionContext | null;
  readonly useAppServerPermissionDefault?: boolean;
  readonly preserveServerConfiguration?: boolean;
  readonly serviceTier?: ThreadResumeParams["serviceTier"];
  /** Manager-only resume context. It must not be projected onto ThreadResumeParams directly. */
  readonly workspaceRoots?: readonly string[];
  /** Manager-only history/context fallback captured with queued input. */
  readonly collaborationMode?: TurnStartParams["collaborationMode"] | null;
}

const preservesActiveDurablePermissions = (
  hostId: string,
  status: Thread["status"] | undefined,
  options: ConversationResumePreparationOptions,
): boolean => hostId === "durable" && status?.type === "active" && options.permissions == null;

/** A suppressed wire field does not erase the context used to interpret the server response. */
export function prepareConversationResumePermissionContext(input: {
  readonly preparation: CanonicalResumePreparation;
  readonly request: ThreadResumeParams;
  readonly hostId: string;
  readonly status?: Thread["status"];
  readonly options: ConversationResumePreparationOptions;
}): ConversationResumePermissionContext {
  const { preparation, request, options } = input;
  const selected = options.permissions ?? preparation.permissions;
  const preservesConfiguration =
    input.hostId === "durable" && options.preserveServerConfiguration === true;
  const preparedRoots =
    preservesConfiguration || selected.activePermissionProfile == null
      ? []
      : selected.runtimeWorkspaceRoots;
  const sentPermissions = request.approvalPolicy != null;
  const canInfer =
    !preservesConfiguration &&
    !preservesActiveDurablePermissions(input.hostId, input.status, options) &&
    (!sentPermissions || request.permissions != null);
  return structuredClone({
    requestedPermissions: {
      ...selected,
      runtimeWorkspaceRoots: workspaceRootsForCwd(preparation.overrides.cwd ?? null, preparedRoots),
    },
    runtimeWorkspaceRootCandidates: canInfer
      ? sentPermissions
        ? [...preparedRoots]
        : [...preparation.permissionWorkspaceRoots]
      : null,
  });
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
  if (durable && input.preserveServerConfiguration === true)
    return { threadId: input.threadId, excludeTurns: false };
  const explicitPermissions = input.permissions != null;
  const selectedOverrides =
    input.permissions == null
      ? input.overrides
      : withExplicitResumePermissions(
          input.overrides,
          input.permissions,
          input.overrides.cwd ?? input.metadata?.cwd ?? null,
        );
  const { config: permissionConfig, ...overrides } = selectedOverrides;
  const preserveServerPermissions =
    input.useAppServerPermissionDefault === true ||
    preservesActiveDurablePermissions(input.hostId, input.metadata?.status, input);
  if (preserveServerPermissions) {
    delete overrides.approvalPolicy;
    delete overrides.approvalsReviewer;
    delete overrides.permissions;
    delete overrides.runtimeWorkspaceRoots;
    delete overrides.sandbox;
  }
  const config = { ...input.config, ...permissionConfig };
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
    input.metadata?.status.type === "idle" &&
    !explicitPermissions &&
    input.serviceTier == null &&
    overrides.permissions == null &&
    !changesConfiguration;
  const paginated =
    !durable &&
    input.supportsPaginatedHistory &&
    (input.metadata?.historyMode ?? input.historyMode) === "paginated";
  const serviceTier =
    overrides.serviceTier === undefined ? input.serviceTier : overrides.serviceTier;

  const request: ThreadResumeParams = {
    threadId: input.threadId,
    ...overrides,
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
