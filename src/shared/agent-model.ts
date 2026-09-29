import type { ModelServiceTier } from "../../packages/codex-app-server-protocol/src/v2/ModelServiceTier";
import type { MultiAgentVersion } from "../../packages/codex-app-server-protocol/src/v2/MultiAgentVersion";

/** App picker presentation; native catalogs do not manufacture another backend's wire fields. */
export interface AgentModelOption {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  readonly defaultReasoningEffort: string;
  readonly inputModalities: string[];
  readonly isDefault: boolean;
  readonly multiAgentVersion?: MultiAgentVersion | null;
  readonly serviceTiers?: ModelServiceTier[];
  readonly defaultServiceTier?: string | null;
}
