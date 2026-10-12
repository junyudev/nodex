import type { Thread, ThreadInjectItemsParams } from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalTurnState } from "./codex-conversation-state/codex-conversation-state";
import {
  CODEX_VISUALIZATION_STATE_MAX_ENTRIES,
  CodexVisualizationStateEntrySchema,
  CodexVisualizationStateRecordSchema,
  codexVisualizationStateEntryKey,
  parseCodexVisualizationInteractionState,
  parseCodexVisualizationWidgetState,
  type CodexVisualizationStateScope,
} from "./codex-visualization-state";
import { areStructurallyEqual } from "./structural-equality";

export const CODEX_VISUALIZATION_PASSIVE_MAX_BYTES = 131_072;
export interface CodexVisualizationPassiveContext {
  readonly key: string;
  readonly items: ThreadInjectItemsParams["items"];
}
/** Returned only after native model-history injection has been confirmed by its physical owner. */
export interface CodexVisualizationInjectionReceipt {
  readonly passiveContextKey?: string;
}

/** Passive state belongs only to this idle admission's unbound optimistic Turn. */
export function selectCodexVisualizationPassiveContextKey(input: {
  readonly context: CodexVisualizationPassiveContext | undefined;
  readonly previousWasIdle: boolean;
  readonly clientUserMessageId: string;
  readonly latestTurn:
    | {
        readonly turnId: string | null;
        readonly params: Pick<CodexCanonicalTurnState["params"], "clientUserMessageId">;
      }
    | null
    | undefined;
  readonly currentRuntimeStatus: Thread["status"] | undefined;
  readonly admittedRuntimeStatus: Thread["status"] | undefined;
  readonly lastInjectedKey: string | undefined;
}): string | undefined {
  const { context, latestTurn, currentRuntimeStatus } = input;
  if (
    !context ||
    !input.previousWasIdle ||
    !latestTurn ||
    latestTurn.turnId !== null ||
    latestTurn.params.clientUserMessageId !== input.clientUserMessageId ||
    (currentRuntimeStatus?.type === "active" &&
      currentRuntimeStatus !== input.admittedRuntimeStatus) ||
    context.key === input.lastInjectedKey
  )
    return undefined;
  return context.key;
}
/** The app input compiler validates attachments before projecting their model context. */
export interface CodexVisualizationPassiveAttachment {
  readonly id: string;
  readonly untrusted: boolean;
  readonly structuredContent?: unknown;
}

function fingerprint(value: string): string {
  let result = 14_695_981_039_346_656_037n;
  for (const character of value) {
    result ^= BigInt(character.codePointAt(0)!);
    result = BigInt.asUintN(64, result * 1_099_511_628_211n);
  }
  return result.toString(16).padStart(16, "0");
}

/** Compiles persisted model context independently of whether its widget is currently mounted. */
export function compileCodexVisualizationPassiveContext(input: {
  readonly scope: CodexVisualizationStateScope;
  readonly stateRecord: unknown;
  readonly interactionRecord: unknown;
  readonly attachments?: readonly CodexVisualizationPassiveAttachment[];
  readonly createUUID: () => string;
}): CodexVisualizationPassiveContext | undefined {
  const records = [
    { field: "state" as const, value: input.stateRecord },
    { field: "interaction" as const, value: input.interactionRecord },
  ];
  const entries = records.flatMap(({ field, value }) =>
    Object.entries(CodexVisualizationStateRecordSchema.parse(value))
      .slice(-CODEX_VISUALIZATION_STATE_MAX_ENTRIES)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ field, key, value })),
  );
  const descriptors: { widgetId: string; field: "state" | "interaction"; state: unknown }[] = [];
  const items: ThreadInjectItemsParams["items"] = [];
  let bytes = 0;
  for (const { field, key, value } of entries) {
    const entry = CodexVisualizationStateEntrySchema.safeParse(value);
    if (
      !entry.success ||
      entry.data.hostId !== input.scope.hostId ||
      entry.data.threadId !== input.scope.threadId ||
      codexVisualizationStateEntryKey(entry.data) !== key
    )
      continue;
    const parsed =
      field === "interaction"
        ? parseCodexVisualizationInteractionState(entry.data.state)
        : parseCodexVisualizationWidgetState(entry.data.state);
    if (!parsed.ok) continue;
    const descriptor = { widgetId: key, field, state: parsed.state.modelContent };
    if (
      field === "interaction" &&
      input.attachments?.some(
        (attachment) =>
          attachment.untrusted === true &&
          attachment.id === key &&
          areStructurallyEqual(attachment.structuredContent, parsed.state.modelContent),
      )
    ) {
      descriptors.push(descriptor);
      continue;
    }
    const callId = `visualization_state_${input.createUUID()}`;
    const pair: ThreadInjectItemsParams["items"] = [
      { type: "function_call", name: "untrusted_input", arguments: "{}", call_id: callId },
      {
        type: "function_call_output",
        call_id: callId,
        output: [
          {
            type: "input_text",
            text: JSON.stringify({ path: entry.data.path, [field]: parsed.state.modelContent }),
          },
        ],
      },
    ];
    bytes += new TextEncoder().encode(JSON.stringify(pair)).byteLength;
    if (bytes > CODEX_VISUALIZATION_PASSIVE_MAX_BYTES) break;
    items.push(...pair);
    descriptors.push(descriptor);
  }
  if (descriptors.length === 0) return undefined;
  return { key: fingerprint(JSON.stringify(descriptors)), items };
}
