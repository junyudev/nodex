import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { z } from "zod";
import type { PersistedAtomEvent } from "../../shared/ipc-api";
import {
  CODEX_VISUALIZATION_STATE_MAX_ENTRIES,
  CodexVisualizationStateIdentitySchema,
  codexVisualizationStateAtomKey,
  codexVisualizationStateEntryKey,
  parseCodexVisualizationWidgetState,
  type CodexVisualizationStateIdentity,
  type CodexVisualizationStateWriteInput,
  type CodexVisualizationStateWriteResult,
  type CodexVisualizationWidgetState,
} from "../../shared/codex-visualization-state";
import { ProfilePersistedAtoms } from "../local-store/ProfilePersistedAtoms";

export class CodexVisualizationStateError extends Schema.TaggedError<CodexVisualizationStateError>()(
  "CodexVisualizationStateError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}
type WriteCommit = {
  readonly result: CodexVisualizationStateWriteResult;
  readonly event: PersistedAtomEvent | null;
};
export class CodexVisualizationState extends Context.Service<
  CodexVisualizationState,
  {
    readonly read: (
      identity: CodexVisualizationStateIdentity,
    ) => Effect.Effect<CodexVisualizationWidgetState | null, CodexVisualizationStateError>;
    readonly write: (
      input: CodexVisualizationStateWriteInput,
      originRendererId: string,
    ) => Effect.Effect<WriteCommit, CodexVisualizationStateError>;
  }
>()("nodex/main/codex-application/CodexVisualizationState") {}

const recordSchema = z.record(z.string(), z.unknown()).catch({});
const entrySchema = CodexVisualizationStateIdentitySchema.extend({ state: z.unknown() });

/** Read and single-entry commit share the Profile repository's atomic transaction. */
export const live: Layer.Layer<CodexVisualizationState, never, ProfilePersistedAtoms> =
  Layer.effect(
    CodexVisualizationState,
    Effect.gen(function* () {
      const store = yield* ProfilePersistedAtoms;
      const read = Effect.fn("CodexVisualizationState.read")(
        (raw: CodexVisualizationStateIdentity) =>
          Effect.try({
            try: () => {
              const identity = CodexVisualizationStateIdentitySchema.parse(raw);
              const key = codexVisualizationStateEntryKey(identity);
              const record = recordSchema.parse(
                store.readState()[codexVisualizationStateAtomKey(identity)],
              );
              const entry = entrySchema.safeParse(record[key]);
              if (
                !entry.success ||
                entry.data.hostId !== identity.hostId ||
                entry.data.threadId !== identity.threadId ||
                codexVisualizationStateEntryKey(entry.data) !== key
              )
                return null;
              const parsed = parseCodexVisualizationWidgetState(entry.data.state);
              return parsed.ok ? parsed.state : null;
            },
            catch: (cause) => new CodexVisualizationStateError({ operation: "read", cause }),
          }),
      );
      const write = Effect.fn("CodexVisualizationState.write")(
        (input: CodexVisualizationStateWriteInput, originRendererId: string) =>
          Effect.try({
            try: (): WriteCommit => {
              const identity = CodexVisualizationStateIdentitySchema.parse(input.identity);
              const mutationId = z.string().trim().min(1).parse(input.mutationId);
              const parsed = parseCodexVisualizationWidgetState(input.state);
              if (!parsed.ok) return { result: parsed, event: null };
              try {
                const atomKey = codexVisualizationStateAtomKey(identity);
                const key = codexVisualizationStateEntryKey(identity);
                const entries = new Map(
                  Object.entries(recordSchema.parse(store.readState()[atomKey])),
                );
                entries.delete(key);
                entries.set(key, { ...identity, state: parsed.state });
                const value = Object.fromEntries(
                  [...entries].slice(-CODEX_VISUALIZATION_STATE_MAX_ENTRIES),
                );
                const event = store.commitMutation(
                  { key: atomKey, value, mutationId },
                  originRendererId,
                );
                return {
                  result: { ok: true, revision: event.revision, value: parsed.state },
                  event,
                };
              } catch {
                return {
                  result: { ok: false, code: "storage_unavailable", retryable: false },
                  event: null,
                };
              }
            },
            catch: (cause) => new CodexVisualizationStateError({ operation: "write", cause }),
          }),
      );
      return CodexVisualizationState.of({ read, write });
    }),
  );
