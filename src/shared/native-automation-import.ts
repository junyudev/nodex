import { claudeAgent } from "./agents/claude";
import { codexAgent } from "./agents/codex";
import type { AutomationInput } from "./core-modules/automation-module";
import type { FolderPlacement } from "./folder-placement";
import type { NativeSessionSource } from "./native-session-catalog";

/** Bound detailed run metadata while retaining linked conversation identities separately. */
export const NATIVE_AUTOMATION_RUN_LIMIT = 50;

export type NativeAutomationOrigin = NonNullable<AutomationInput["import_origin"]>;
export type NativeAutomationAgent = NativeAutomationOrigin["agent"];

/** The histories scheduled tasks come from, named as their Agents name their native history. */
export const CODEX_AUTOMATIONS = codexAgent.capabilities.nativeHistory;
export const CLAUDE_AUTOMATIONS = claudeAgent.capabilities.nativeHistory;

/** How the Agent a task came from names itself. */
export const nativeAutomationAgentLabel = (agent: NativeAutomationAgent): string =>
  agent === CODEX_AUTOMATIONS ? codexAgent.label : claudeAgent.label;

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
  readonly runConversationIds?: readonly string[];
}

export type NativeAutomationCandidate = NativeAutomationOrigin &
  NativeAutomationDefinition &
  (
    | {
        readonly agent: typeof CODEX_AUTOMATIONS;
        readonly conversationSource: NativeAutomationConversationSource & {
          readonly backendKind: typeof CODEX_AUTOMATIONS;
        };
        readonly memory?: string;
        readonly localEnvironmentConfigPath?: string;
      }
    | {
        readonly agent: typeof CLAUDE_AUTOMATIONS;
        readonly conversationSource: {
          readonly backendKind: typeof CLAUDE_AUTOMATIONS;
          readonly nativeHome: string;
          readonly instanceConfigId?: string;
        };
        /** Additional folder access granted to one run. */
        readonly additionalFolders?: readonly string[];
      }
  ) &
  (
    | { readonly kind: "cron"; readonly heartbeatTarget?: never }
    | { readonly kind: "heartbeat"; readonly heartbeatTarget?: NativeAutomationConversation }
  );

export interface NativeAutomationSelection {
  readonly sourceKey: string;
  readonly folders: readonly string[];
}

export type NativeAutomationBlocker =
  | NativeAutomationScheduleProblem
  | "missing-folder"
  | "no-claude-profile"
  | "missing-heartbeat"
  | "unsupported-task"
  | "deleted-automation";

export interface NativeAutomationImportRow {
  readonly id: string;
  readonly selection: NativeAutomationSelection;
  readonly agent: NativeAutomationAgent;
  readonly kind: NativeAutomationCandidate["kind"];
  readonly name: string;
  readonly schedule: NativeAutomationSchedule;
  readonly placement: FolderPlacement;
  readonly runCount: number;
  readonly status:
    | { readonly kind: "ready" }
    | { readonly kind: "imported"; readonly automationId: string }
    | { readonly kind: "unavailable"; readonly reason: NativeAutomationBlocker };
}

export interface NativeAutomationCatalogResult {
  readonly rows: readonly NativeAutomationImportRow[];
  readonly cronConversationKeys: readonly string[];
}

export type NativeAutomationImportResult =
  | { readonly kind: "imported"; readonly automationIds: readonly string[] }
  | { readonly kind: "failed"; readonly message: string };

export const nativeAutomationConversationKey = (agent: string, nativeHome: string, id: string) =>
  JSON.stringify([agent, nativeHome, id.toLowerCase()]);

/** Cron conversations belong to their tasks. Heartbeat targets remain ordinary chats. */
export function nativeAutomationConversationIds(
  candidates: readonly NativeAutomationCandidate[],
): ReadonlyMap<NativeAutomationAgent, ReadonlyMap<string, ReadonlySet<string>>> {
  const byAgent = new Map<NativeAutomationAgent, Map<string, Set<string>>>();
  for (const candidate of candidates) {
    if (candidate.kind !== "cron") continue;
    const idsByHome = byAgent.get(candidate.agent) ?? new Map<string, Set<string>>();
    const { nativeHome } = candidate.conversationSource;
    const ids = idsByHome.get(nativeHome) ?? new Set<string>();
    for (const id of candidate.runConversationIds ??
      candidate.runs.map((run) => run.nativeSessionId))
      ids.add(id);
    if (ids.size === 0) continue;
    idsByHome.set(nativeHome, ids);
    byAgent.set(candidate.agent, idsByHome);
  }
  return byAgent;
}
