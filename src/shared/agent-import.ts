export type AgentImportSourceKind = "claude-code" | "codex";

export type AgentImportItemKind =
  | "instructions"
  | "settings"
  | "skills"
  | "plugins"
  | "mcpServers"
  | "subagents"
  | "hooks"
  | "commands"
  | "memory"
  | "sessions";

export interface AgentImportScanInput {
  readonly sourceKind: AgentImportSourceKind;
}

export interface AgentImportScanItem {
  readonly id: string;
  readonly kind: AgentImportItemKind;
  readonly label: string;
  readonly description: string;
  readonly count: number;
  readonly defaultSelected: boolean;
}

export interface AgentImportScan {
  readonly scanId: string;
  readonly sourceKind: AgentImportSourceKind;
  readonly sourceLabel: string;
  readonly sourceHome: string;
  readonly expiresAt: number;
  readonly items: readonly AgentImportScanItem[];
  readonly skippedAlreadyImportedSessions: number;
}

export interface AgentImportApplyInput {
  readonly scanId: string;
  readonly itemIds: readonly string[];
}

export interface AgentImportItemOutcome {
  readonly itemId: string;
  readonly kind: AgentImportItemKind;
  readonly label: string;
  readonly successCount: number;
  readonly skippedCount: number;
  readonly failureCount: number;
  readonly messages: readonly string[];
}

export interface AgentImportResult {
  readonly importId: string;
  readonly sourceKind: AgentImportSourceKind;
  readonly sourceLabel: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly outcomes: readonly AgentImportItemOutcome[];
  readonly importedThreadIds: readonly string[];
}

export interface AgentImportProgress {
  readonly importId: string;
  readonly sourceKind: AgentImportSourceKind;
  readonly completedItems: number;
  readonly totalItems: number;
  readonly activeItemLabel: string | null;
  readonly completed: boolean;
}
