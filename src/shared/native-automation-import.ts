import type { NativeSessionSource } from "./native-session-catalog";

/** Retain the 50 newest runs by creation time for each task, with no age cutoff. */
export const NATIVE_AUTOMATION_RUN_LIMIT = 50;

export type NativeAutomationAgent = "codex" | "claude";

export interface NativeAutomationOrigin {
  readonly agent: NativeAutomationAgent;
  /** Canonical Codex home or Claude Desktop account/organization directory. */
  readonly sourceHome: string;
  readonly sourceAutomationId: string;
}

export type NativeAutomationScheduleProblem = "one-shot" | "manual" | "cron-day-or" | "invalid";

export type NativeAutomationSchedule =
  | { readonly kind: "rrule"; readonly rrule: string }
  | { readonly kind: "unsupported"; readonly reason: NativeAutomationScheduleProblem };

interface NativeAutomationConversation {
  readonly nativeSessionId: string;
}

export interface NativeAutomationRun extends NativeAutomationConversation {
  readonly title?: string;
  readonly cwd?: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
}

export type NativeAutomationConversationSource = NativeSessionSource & {
  /** The catalog's canonical history home, used as expectedHome for import. */
  readonly nativeHome: string;
};

interface NativeAutomationDefinition {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: NativeAutomationSchedule;
  readonly sourceStatus: "active" | "paused";
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly executionEnvironment: "local" | "worktree";
  readonly folders: readonly string[];
  readonly notificationPolicy?: string;
  readonly runs: readonly NativeAutomationRun[];
}

export type NativeAutomationCandidate = NativeAutomationOrigin &
  NativeAutomationDefinition &
  (
    | {
        readonly agent: "codex";
        readonly conversationSource: NativeAutomationConversationSource & {
          readonly backendKind: "codex";
        };
        readonly memory?: string;
        readonly localEnvironmentConfigPath?: string;
      }
    | {
        readonly agent: "claude";
        readonly conversationSource: NativeAutomationConversationSource & {
          readonly backendKind: "claude";
        };
        /** Additional folder access granted to one run. */
        readonly additionalFolders?: readonly string[];
      }
  ) &
  (
    | { readonly kind: "cron"; readonly heartbeatTarget?: never }
    | { readonly kind: "heartbeat"; readonly heartbeatTarget?: NativeAutomationConversation }
  );

/** The automation-linked conversations in the returned window, keyed by physical history home. */
export function nativeAutomationConversationIds(
  candidates: readonly NativeAutomationCandidate[],
): ReadonlyMap<NativeAutomationAgent, ReadonlyMap<string, ReadonlySet<string>>> {
  const byAgent = new Map<NativeAutomationAgent, Map<string, Set<string>>>();
  for (const candidate of candidates) {
    const idsByHome = byAgent.get(candidate.agent) ?? new Map<string, Set<string>>();
    const { nativeHome } = candidate.conversationSource;
    const ids = idsByHome.get(nativeHome) ?? new Set<string>();
    for (const run of candidate.runs) ids.add(run.nativeSessionId);
    if (candidate.heartbeatTarget) ids.add(candidate.heartbeatTarget.nativeSessionId);
    if (ids.size === 0) continue;
    idsByHome.set(nativeHome, ids);
    byAgent.set(candidate.agent, idsByHome);
  }
  return byAgent;
}
