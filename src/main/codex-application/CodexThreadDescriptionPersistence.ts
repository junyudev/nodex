import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { normalizeCodexGeneratedThreadDescription } from "../../shared/codex-thread-title";
import type { PersistedAtomStore } from "../local-store/persisted-atoms";

export const CODEX_THREAD_DESCRIPTIONS_ATOM_KEY = "thread-descriptions-v1";

export class CodexThreadDescriptionPersistenceError extends Schema.TaggedError<CodexThreadDescriptionPersistenceError>()(
  "CodexThreadDescriptionPersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface CodexThreadDescriptionPersistenceService {
  readonly set: (input: {
    readonly threadId: string;
    readonly description: string;
  }) => Effect.Effect<void, CodexThreadDescriptionPersistenceError>;
  readonly get: (
    threadId: string,
  ) => Effect.Effect<string | null, CodexThreadDescriptionPersistenceError>;
}

export class CodexThreadDescriptionPersistence extends Context.Service<
  CodexThreadDescriptionPersistence,
  CodexThreadDescriptionPersistenceService
>()("nodex/main/codex-application/CodexThreadDescriptionPersistence") {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const make = (store: PersistedAtomStore): CodexThreadDescriptionPersistenceService => {
  const readDescriptions = (): Record<string, string> => {
    const raw = store.readState()[CODEX_THREAD_DESCRIPTIONS_ATOM_KEY];
    if (!isRecord(raw)) return {};
    const descriptions: Record<string, string> = {};
    for (const [threadId, description] of Object.entries(raw)) {
      const normalizedThreadId = threadId.trim();
      const normalizedDescription =
        typeof description === "string"
          ? (normalizeCodexGeneratedThreadDescription(description) ?? "")
          : "";
      if (normalizedThreadId && normalizedDescription) {
        descriptions[normalizedThreadId] = normalizedDescription;
      }
    }
    return descriptions;
  };

  const attempt = <A>(operation: string, evaluate: () => A) =>
    Effect.try({
      try: evaluate,
      catch: (cause) => new CodexThreadDescriptionPersistenceError({ operation, cause }),
    });

  return {
    set: ({ threadId, description }) =>
      attempt("set", () => {
        const normalizedThreadId = threadId.trim();
        const normalizedDescription = normalizeCodexGeneratedThreadDescription(description) ?? "";
        if (!normalizedThreadId || !normalizedDescription) return;
        store.update({
          key: CODEX_THREAD_DESCRIPTIONS_ATOM_KEY,
          value: {
            ...readDescriptions(),
            [normalizedThreadId]: normalizedDescription,
          },
        });
      }),
    get: (threadId) => attempt("get", () => readDescriptions()[threadId.trim()] ?? null),
  };
};
