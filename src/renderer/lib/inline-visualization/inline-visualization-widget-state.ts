import {
  CodexVisualizationStateIdentitySchema,
  parseCodexVisualizationWidgetState,
  type CodexVisualizationStateIdentity,
  type CodexVisualizationStateFailure,
  type CodexVisualizationStateWriteResult,
  type CodexVisualizationWidgetState,
} from "../../../shared/codex-visualization-state";
import {
  defineRendererCommand,
  invokeRendererQuery,
  invokeRevisionedCommand,
} from "../renderer-command";

const writeStateCommand = defineRendererCommand({
  key: "inline_visualization.write_state",
  channel: "codex:visualization:state:write",
  authority: "main",
  owner: "InlineVisualizationWidgetState",
  protocol: { kind: "revision_fenced_local" },
});
export interface InlineVisualizationWidgetStateOwner {
  readonly identity: CodexVisualizationStateIdentity;
  readonly read: () => Promise<CodexVisualizationWidgetState | null>;
  readonly write: (
    state: CodexVisualizationWidgetState,
  ) => Promise<CodexVisualizationStateWriteResult>;
}

export function resolveInlineVisualizationStateIdentity(input: {
  readonly hostId: string;
  readonly threadId: string;
  readonly file: string;
  readonly resolvedPath: string | null;
}): CodexVisualizationStateIdentity | null {
  const declared = CodexVisualizationStateIdentitySchema.safeParse({
    hostId: input.hostId,
    threadId: input.threadId,
    path: input.file,
  });
  if (declared.success) return declared.data;
  const resolved = CodexVisualizationStateIdentitySchema.safeParse({
    hostId: input.hostId,
    threadId: input.threadId,
    path: input.resolvedPath,
  });
  return resolved.success ? resolved.data : null;
}

/** The file read source and the displayed Thread's persisted state have separate identities. */
export function createInlineVisualizationWidgetStateOwner(
  identity: CodexVisualizationStateIdentity,
): InlineVisualizationWidgetStateOwner {
  const stableIdentity = Object.freeze(CodexVisualizationStateIdentitySchema.parse(identity));
  return {
    identity: stableIdentity,
    read: () => invokeRendererQuery("codex:visualization:state:read", stableIdentity),
    write: (state) =>
      invokeRevisionedCommand(writeStateCommand, {
        identity: stableIdentity,
        state,
        mutationId: crypto.randomUUID(),
      }),
  };
}

type UpdateFailure =
  | CodexVisualizationStateFailure
  | { readonly ok: false; readonly retryable: false };
/** Guest arguments may update state for this attempt, never select its storage identity. */
export function createInlineVisualizationStateUpdateHandler(input: {
  readonly owner?: InlineVisualizationWidgetStateOwner;
  readonly widgetId: string;
  readonly signal: AbortSignal;
  readonly allowInteractions?: () => boolean;
}): (widgetId: unknown, state: unknown) => Promise<void | UpdateFailure> {
  return async (widgetId, state) => {
    if (
      !input.owner ||
      input.signal.aborted ||
      input.allowInteractions?.() === false ||
      widgetId !== input.widgetId
    )
      return { ok: false, retryable: false };
    const parsed = parseCodexVisualizationWidgetState(state);
    if (!parsed.ok) return parsed;
    try {
      const result = await input.owner.write(parsed.state);
      if (!result.ok) return result;
    } catch {
      return { ok: false, code: "storage_unavailable", retryable: false };
    }
  };
}
