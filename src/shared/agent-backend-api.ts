export interface AgentBackendHistoryImageInput {
  readonly threadId: string;
  readonly expectedSessionId: string;
  readonly nativeMessageId: string;
  readonly index: number;
}

export interface AgentBackendToolOutputInput {
  readonly threadId: string;
  readonly expectedSessionId: string;
  readonly nativeMessageId: string;
  readonly toolUseId: string;
}

export interface AgentBackendHistoryReadInput {
  readonly threadId: string;
  readonly before?: string;
  /** Native message hint, 1–50; a page may extend to its owning prompt boundary. */
  readonly limit?: number;
}

export interface AgentNativeHistoryInspection {
  readonly backendBinding: import("./agent-backend").AgentBackendBinding;
  readonly nativeSessionId: string;
  readonly nativeHome: string | null;
  readonly cwd: string | null;
}
