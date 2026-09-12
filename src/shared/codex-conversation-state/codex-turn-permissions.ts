import type { ActivePermissionProfile, TurnStartParams } from "@nodex/codex-app-server-protocol/v2";
import type { ConversationFollowerTurnStart } from "../codex-thread-follower-request";
import { areWorkspacePathsEquivalent, workspaceRootsForCwd } from "../codex-workspace-paths";
import {
  createCodexCanonicalWorkspacePermissionContext,
  type CodexCanonicalConversationState,
  type CodexCanonicalPermissionContext,
} from "./codex-conversation-state";
import { latestAssignedConversationTurn } from "./codex-turn-selectors";

type PermissionFields = Pick<
  TurnStartParams,
  "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy" | "permissions" | "runtimeWorkspaceRoots"
>;

export interface CodexTurnPermissionWorkspaceTransition {
  readonly appliedRoots: readonly string[];
  readonly pendingRoots: readonly string[];
}

const unionRoots = (...groups: readonly (readonly string[])[]): string[] => [
  ...new Set(groups.flat()),
];

const replaceWorkspaceRoots = (
  roots: readonly string[],
  appliedRoots: readonly string[],
  pendingRoots: readonly string[],
): string[] =>
  unionRoots(
    roots.filter(
      (root) => !appliedRoots.some((applied) => areWorkspacePathsEquivalent(root, applied)),
    ),
    pendingRoots,
  );

function profileProvenance(
  id: string | null,
  selected: ActivePermissionProfile | null | undefined,
  current: ActivePermissionProfile | null | undefined,
): ActivePermissionProfile | null {
  if (id === null) return null;
  if (selected?.id === id) return selected;
  if (current?.id === id) return current;
  return { id, extends: null };
}

/** Keeps native overrides, resident Turn parameters and effective permission provenance coherent. */
export function resolveConversationTurnPermissions(input: {
  readonly state: CodexCanonicalConversationState;
  readonly request: PermissionFields;
  readonly context?: ConversationFollowerTurnStart["context"];
  readonly cwd: string | null;
  readonly writableRoots: readonly string[];
  readonly workspaceKind?: "project" | "projectless" | null;
  readonly workspaceBrowserRoot?: string | null;
  readonly workspaceTransition?: CodexTurnPermissionWorkspaceTransition;
}) {
  const { state, request, context, cwd, writableRoots, workspaceTransition } = input;
  const inherit = context?.inheritThreadSettings !== false;
  const selection = context?.usePermissionSelection === true;
  const latest = latestAssignedConversationTurn(state)?.params;
  const inherited = inherit ? latest : null;
  const settings = inherit
    ? (state.latestThreadSettings ?? state.hydrationContext?.latestThreadSettings)
    : null;
  const current = state.currentPermissions;
  const hasExplicitPermissions =
    request.approvalPolicy != null ||
    request.approvalsReviewer != null ||
    request.sandboxPolicy != null ||
    request.permissions !== undefined;
  const useAppServerPermissionDefault =
    selection ||
    (context?.useAppServerPermissionDefault ??
      (!hasExplicitPermissions &&
        inherit &&
        latest != null &&
        "useAppServerPermissionDefault" in latest &&
        latest.useAppServerPermissionDefault === true));
  const workspaceKind = input.workspaceKind ?? state.workspaceKind;
  const projectless = workspaceKind === "projectless";
  const browserRoot = projectless
    ? (input.workspaceBrowserRoot ?? state.workspaceBrowserRoot ?? null)
    : null;
  const defaults = createCodexCanonicalWorkspacePermissionContext(
    browserRoot != null && browserRoot !== "~" ? [browserRoot] : [],
  );
  const approvalPolicy =
    request.approvalPolicy ??
    settings?.approvalPolicy ??
    latest?.approvalPolicy ??
    current?.approvalPolicy ??
    defaults.approvalPolicy;
  const approvalsReviewer =
    request.approvalsReviewer ??
    settings?.approvalsReviewer ??
    latest?.approvalsReviewer ??
    current?.approvalsReviewer ??
    defaults.approvalsReviewer;
  const profileHint =
    request.permissions ??
    settings?.activePermissionProfile?.id ??
    settings?.permissions ??
    current?.activePermissionProfile?.id ??
    inherited?.permissions;
  const rootHint =
    request.runtimeWorkspaceRoots ??
    current?.runtimeWorkspaceRoots ??
    inherited?.runtimeWorkspaceRoots;
  const profileSandbox =
    profileHint === ":danger-full-access"
      ? { type: "dangerFullAccess" as const }
      : profileHint === ":workspace" && rootHint != null
        ? createCodexCanonicalWorkspacePermissionContext([...rootHint]).sandboxPolicy
        : null;
  const originalSandbox =
    request.sandboxPolicy ??
    profileSandbox ??
    settings?.sandboxPolicy ??
    latest?.sandboxPolicy ??
    current?.sandboxPolicy ??
    defaults.sandboxPolicy;
  const expandsSandbox =
    originalSandbox.type === "workspaceWrite" &&
    writableRoots.some((root) => !originalSandbox.writableRoots.includes(root));
  const expandedSandboxPolicy =
    originalSandbox.type === "workspaceWrite"
      ? {
          ...originalSandbox,
          writableRoots: workspaceRootsForCwd(
            cwd,
            unionRoots(originalSandbox.writableRoots, writableRoots),
          ),
        }
      : originalSandbox;
  const sandboxPolicy =
    workspaceTransition && expandedSandboxPolicy.type === "workspaceWrite"
      ? {
          ...expandedSandboxPolicy,
          writableRoots: workspaceRootsForCwd(
            cwd,
            replaceWorkspaceRoots(
              expandedSandboxPolicy.writableRoots,
              workspaceTransition.appliedRoots,
              workspaceTransition.pendingRoots,
            ),
          ),
        }
      : expandedSandboxPolicy;
  const forceSandbox =
    !selection && (projectless || (!useAppServerPermissionDefault && expandsSandbox));
  const explicitPolicy =
    !useAppServerPermissionDefault &&
    (forceSandbox || request.approvalPolicy != null || request.sandboxPolicy != null);
  const inheritedPolicy = !useAppServerPermissionDefault && (settings != null || inherited != null);
  let profileId: string | null = null;
  if (!useAppServerPermissionDefault) {
    if (request.permissions !== undefined) profileId = request.permissions;
    else if (request.sandboxPolicy == null) {
      profileId =
        settings?.activePermissionProfile !== undefined
          ? (settings.activePermissionProfile?.id ?? null)
          : settings?.permissions !== undefined
            ? settings.permissions
            : (current?.activePermissionProfile?.id ?? inherited?.permissions ?? null);
    }
  }
  const effectiveProfileId =
    profileId ?? (useAppServerPermissionDefault ? current?.activePermissionProfile?.id : null);
  const fixedSandbox = current?.sandboxPolicy;
  const transitionWritableRoots =
    selection && workspaceTransition
      ? replaceWorkspaceRoots(
          writableRoots,
          workspaceTransition.appliedRoots,
          workspaceTransition.pendingRoots,
        )
      : writableRoots;
  const additionalRoots =
    effectiveProfileId != null &&
    effectiveProfileId === current?.activePermissionProfile?.id &&
    fixedSandbox?.type === "workspaceWrite"
      ? transitionWritableRoots.filter(
          (root) =>
            !fixedSandbox.writableRoots.some((fixed) => areWorkspacePathsEquivalent(fixed, root)),
        )
      : transitionWritableRoots;
  const carryRoots =
    projectless || profileId != null || (useAppServerPermissionDefault && writableRoots.length > 0);
  const directories = [state.cwd, cwd].filter(
    (value): value is string => value != null && value !== "~",
  );
  const runtimeWorkspaceRoots = workspaceTransition
    ? workspaceRootsForCwd(
        cwd,
        selection
          ? unionRoots(workspaceTransition.pendingRoots, additionalRoots)
          : workspaceTransition.pendingRoots,
      )
    : carryRoots
      ? workspaceRootsForCwd(
          cwd,
          unionRoots(
            request.runtimeWorkspaceRoots ??
              current?.runtimeWorkspaceRoots ??
              inherited?.runtimeWorkspaceRoots ??
              (state.cwd == null ? [] : [state.cwd]),
            additionalRoots,
            directories,
          ),
        )
      : null;
  const workspaceCommitRoots = workspaceRootsForCwd(
    cwd,
    workspaceTransition
      ? replaceWorkspaceRoots(
          sandboxPolicy.type === "workspaceWrite" ? sandboxPolicy.writableRoots : writableRoots,
          workspaceTransition.appliedRoots,
          workspaceTransition.pendingRoots,
        )
      : sandboxPolicy.type === "workspaceWrite"
        ? unionRoots(sandboxPolicy.writableRoots, directories)
        : [],
  );
  const params = {
    approvalPolicy,
    approvalsReviewer,
    sandboxPolicy,
    permissions: profileId,
    runtimeWorkspaceRoots,
    useAppServerPermissionDefault,
  };
  const nativeRequest = {
    approvalPolicy: inheritedPolicy || explicitPolicy ? approvalPolicy : null,
    approvalsReviewer: useAppServerPermissionDefault ? null : approvalsReviewer,
    sandboxPolicy:
      profileId == null && (forceSandbox || inheritedPolicy || explicitPolicy)
        ? sandboxPolicy
        : null,
    permissions: profileId,
    runtimeWorkspaceRoots,
  } satisfies Required<PermissionFields>;
  let permissions: CodexCanonicalPermissionContext;
  if (
    selection &&
    settings?.approvalPolicy != null &&
    settings.approvalsReviewer != null &&
    settings.sandboxPolicy != null
  ) {
    permissions = {
      activePermissionProfile: settings.activePermissionProfile,
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: settings.approvalsReviewer,
      sandboxPolicy: settings.sandboxPolicy,
      runtimeWorkspaceRoots: runtimeWorkspaceRoots ?? current?.runtimeWorkspaceRoots,
    };
  } else if (useAppServerPermissionDefault && current != null) {
    permissions = {
      ...current,
      runtimeWorkspaceRoots: runtimeWorkspaceRoots ?? current.runtimeWorkspaceRoots,
    };
  } else {
    if (selection) throw new Error("Missing permission settings for the next turn");
    permissions = {
      activePermissionProfile: profileProvenance(
        profileId,
        settings?.activePermissionProfile,
        current?.activePermissionProfile,
      ),
      approvalPolicy,
      approvalsReviewer,
      sandboxPolicy,
      runtimeWorkspaceRoots: runtimeWorkspaceRoots ?? current?.runtimeWorkspaceRoots,
    };
  }
  return { request: nativeRequest, params, permissions, workspaceCommitRoots };
}
