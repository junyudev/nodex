export interface RealtimeVoiceGateValues {
  readonly entryPoint: boolean;
  readonly blocked: boolean;
  readonly clientOwnedCall: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly sessionConfig: Readonly<Record<string, unknown>>;
}

export interface RealtimeVoiceProductPolicy {
  readonly status: "unknown" | "ready";
  readonly accountId: string | null;
  readonly userId: string | null;
  readonly entryPoint: boolean;
  readonly accessAllowed: boolean;
  readonly clientOwnedCall: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly sessionConfig: Readonly<Record<string, unknown>>;
}

export const EMPTY_REALTIME_VOICE_PRODUCT_POLICY: RealtimeVoiceProductPolicy = {
  status: "unknown",
  accountId: null,
  userId: null,
  entryPoint: false,
  accessAllowed: false,
  clientOwnedCall: false,
  config: {},
  sessionConfig: {},
};

const PERSONAL_PLANS = new Set(["free", "go", "plus", "prolite", "pro", "promax"]);

export const realtimeVoiceNeedsWorkspace = (plan: string | null): boolean =>
  plan !== null && !PERSONAL_PLANS.has(plan);

/** Product access is separate from rollout and native-host capability. */
export const resolveRealtimeVoiceProductPolicy = (input: {
  readonly identity: { readonly accountId: string; readonly userId: string } | null;
  readonly authMethod: string | null;
  readonly plan: string | null;
  readonly gates: RealtimeVoiceGateValues;
  readonly workspace: {
    readonly localAccess: boolean | undefined;
    readonly permissions: readonly string[] | undefined;
  } | null;
}): RealtimeVoiceProductPolicy => {
  if (input.authMethod !== "chatgpt" || input.identity === null || input.plan === null)
    return EMPTY_REALTIME_VOICE_PRODUCT_POLICY;
  const personal = PERSONAL_PLANS.has(input.plan);
  if (!personal && input.workspace === null) return EMPTY_REALTIME_VOICE_PRODUCT_POLICY;
  const workspace = input.workspace;
  const allowed =
    personal ||
    (workspace?.localAccess === true &&
      (workspace.permissions === undefined ||
        workspace.permissions.includes("chatgpt.workspace.feature.voice.access")));
  return {
    status: "ready",
    ...input.identity,
    entryPoint: input.gates.entryPoint && !input.gates.blocked,
    accessAllowed: allowed,
    clientOwnedCall: input.gates.clientOwnedCall,
    config: input.gates.config,
    sessionConfig: input.gates.sessionConfig,
  };
};
