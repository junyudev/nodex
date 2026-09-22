import type { ChatGptBackendIdentity } from "../codex/chatgpt-backend-auth";

export interface DictationPolicySnapshot {
  readonly composer: boolean;
  readonly global: boolean;
  readonly streaming: boolean;
  readonly sounds: boolean;
  readonly voiceDictionary: boolean;
  readonly accountId: string | null;
  readonly userId: string | null;
}

export const EMPTY_DICTATION_POLICY: DictationPolicySnapshot = {
  composer: false,
  global: false,
  streaming: false,
  sounds: false,
  voiceDictionary: false,
  accountId: null,
  userId: null,
};

export interface DictationGateValues {
  readonly composer: boolean;
  readonly global: boolean;
  readonly workspacePermissions: boolean;
  readonly streaming: boolean;
  readonly sounds: boolean;
  readonly voiceDictionary: boolean;
}

export const statsigNameHash = (name: string): string => {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = ((hash << 5) - hash + name.charCodeAt(index)) | 0;
  }
  return String(hash >>> 0);
};

const WORKSPACE_PERMISSION_PLANS = new Set([
  "business",
  "enterprise",
  "enterprise_cbp_usage_based",
  "enterprise_cbp_automation",
  "deprecated_enterprise",
  "hc",
  "finserv",
  "ent26",
  "quorum",
  "education",
  "edu_plus",
  "edu_pro",
  "edu",
  "deprecated_edu",
  "k12",
]);

export const requiresDictationWorkspacePermission = (plan: string | null): boolean =>
  plan !== null && WORKSPACE_PERMISSION_PLANS.has(plan);

export const resolveDictationPolicy = (input: {
  readonly identity: ChatGptBackendIdentity | null;
  readonly auth?: {
    readonly method: string | null;
    readonly requiresAuth: boolean;
    readonly hasToken: boolean;
  };
  readonly gates: DictationGateValues;
  readonly featureEnabled: boolean;
  readonly plan: string | null;
  readonly permissions: readonly string[] | null;
}): DictationPolicySnapshot => {
  const auth = input.auth ?? {
    method: "chatgpt",
    requiresAuth: true,
    hasToken: input.identity !== null,
  };
  const workspaceAllowed =
    auth.method !== "chatgpt" ||
    !input.gates.workspacePermissions ||
    (input.plan !== null &&
      (!requiresDictationWorkspacePermission(input.plan) ||
        input.permissions?.includes("chatgpt.workspace.feature.dictation.access") === true));
  const parent = input.featureEnabled && workspaceAllowed && input.gates.composer;
  const composer = parent && auth.method === "chatgpt";
  return {
    composer,
    global:
      parent &&
      input.gates.global &&
      (auth.method !== null || !auth.requiresAuth) &&
      (auth.method !== "chatgpt" || auth.hasToken),
    streaming: composer && input.gates.streaming,
    sounds: input.gates.sounds,
    voiceDictionary: composer && input.identity !== null && input.gates.voiceDictionary,
    accountId: input.identity?.accountId ?? null,
    userId: input.identity?.userId ?? null,
  };
};
