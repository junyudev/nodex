import type { RuntimeMode } from "@nodex/agent-runtime/contracts";
import { AgentRuntimeModeSchema } from "../../../shared/schemas/agent-runtime-api";
import { z } from "zod";
import { persistedAtom, type PersistedAtomDefinition } from "@/lib/maitai";
import { rendererSpace, spaceStorageKeyFor } from "@/lib/renderer-space";
import type { SpaceConnectionSummary } from "../../../shared/space-connection";
import type { AgentModelSelection } from "../../../shared/agent-model-catalog";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import { AgentBackendBindingSchema } from "../../../shared/schemas/agent-backend";

type ModelOptions = NonNullable<AgentModelSelection["options"]>;

/**
 * A Composer choice that has not reached execution: an unstarted Session's Agent and mode, or
 * a started chat's Agent and model for its next message. It persists beside the prompt draft.
 */
export interface AgentRuntimeComposerChoice {
  readonly selection?: AgentModelSelection;
  readonly interactionMode?: "default" | "plan";
  readonly runtimeMode?: RuntimeMode;
}
export type AgentRuntimeComposerChoices = Readonly<Record<string, AgentRuntimeComposerChoice>>;
/** The options last chosen for each Agent model, by provider instance and then model. */
export type AgentRuntimeModelOptionMemory = Readonly<
  Record<string, Readonly<Record<string, ModelOptions>>>
>;

const CHOICE_LIMIT = 256;
const REMEMBERED_MODEL_LIMIT = 64;
const options = z
  .array(
    z.strictObject({ id: z.string().min(1).max(128), value: z.union([z.string(), z.boolean()]) }),
  )
  .max(32);
const selection = z.strictObject({
  binding: AgentBackendBindingSchema,
  model: z.string().trim().min(1).max(256),
  options: options.optional(),
  modeId: z.string().min(1).max(256).optional(),
});
const choice = z.strictObject({
  selection: selection.optional(),
  interactionMode: z.enum(["default", "plan"]).optional(),
  runtimeMode: AgentRuntimeModeSchema.optional(),
});

/** Keys for the choices a Composer can hold before execution applies them. */
export const agentRuntimeChoiceKey = {
  draft: (sessionId: string, modelProjectId: string | null) =>
    JSON.stringify([sessionId, modelProjectId]),
  chat: (threadId: string) => JSON.stringify(["thread", threadId]),
};

/**
 * Writes one key's choice and keeps the newest ones; an empty choice is removed. Unrelated keys
 * keep their identity so other Composers do not re-render.
 */
export function withAgentRuntimeComposerChoice(
  current: AgentRuntimeComposerChoices,
  key: string,
  patch: Partial<AgentRuntimeComposerChoice>,
): AgentRuntimeComposerChoices {
  const { [key]: previous, ...others } = current;
  const next = Object.fromEntries(
    Object.entries({ ...previous, ...patch }).filter(([, value]) => value !== undefined),
  ) as AgentRuntimeComposerChoice;
  if (Object.keys(next).length === 0) return previous === undefined ? current : others;
  return Object.fromEntries([...Object.entries(others), [key, next]].slice(-CHOICE_LIMIT));
}

/** The options last chosen for this Agent model, if any. */
export function rememberedAgentModelOptions(
  memory: AgentRuntimeModelOptionMemory,
  chosen: Pick<AgentModelSelection, "binding" | "model">,
): ModelOptions | undefined {
  const instanceId = agentRuntimeProviderId(chosen.binding);
  return instanceId ? memory[instanceId]?.[chosen.model] : undefined;
}

/** Remembers a choice's options for its model; each Agent keeps its most recent models. */
export function rememberAgentModelOptions(
  current: AgentRuntimeModelOptionMemory,
  chosen: AgentModelSelection,
): AgentRuntimeModelOptionMemory {
  const instanceId = agentRuntimeProviderId(chosen.binding);
  if (!instanceId) return current;
  const { [chosen.model]: _previous, ...others } = current[instanceId] ?? {};
  const models = Object.fromEntries(
    [...Object.entries(others), [chosen.model, chosen.options ?? []] as const].slice(
      -REMEMBERED_MODEL_LIMIT,
    ),
  );
  return { ...current, [instanceId]: models };
}

/** Keeps each entry that still decodes; one stale entry never discards the others. */
const decodeEntries = <Value>(value: unknown, decode: (entry: unknown) => Value | undefined) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([key, entry]) => {
          const decoded = decode(entry);
          return key && decoded !== undefined ? [[key, decoded] as const] : [];
        }),
      )
    : {};
const decodeWith =
  <Value>(schema: z.ZodType<Value>) =>
  (entry: unknown): Value | undefined => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? parsed.data : undefined;
  };

export const agentRuntimeComposerChoicesAtom = persistedAtom<AgentRuntimeComposerChoices>({
  debugLabel: "agent-runtime-composer-choices",
  storageKey: "agent-runtime-composer-choices-v1",
  defaultValue: {},
  hydration: "eager",
  synchronization: "cross-window",
  decode: (value) => decodeEntries(value, decodeWith(choice)),
});

export const agentRuntimeModelOptionMemoryAtom = persistedAtom<AgentRuntimeModelOptionMemory>({
  debugLabel: "agent-runtime-model-option-memory",
  storageKey: "agent-runtime-model-options-v1",
  defaultValue: {},
  hydration: "eager",
  synchronization: "cross-window",
  decode: (value) => decodeEntries(value, (models) => decodeEntries(models, decodeWith(options))),
});

const NEW_CHAT_CHOICE_KEY = "agent-runtime-new-chat-choice-v1";

/**
 * Where a Space remembers what its new chats start on. Hosts offer different Agents and models,
 * so each team Space keeps its own choice for its Member; the personal Space keeps the desktop's.
 */
export const newChatChoiceStorageKey = (
  space: Pick<SpaceConnectionSummary, "kind" | "spaceId" | "memberId">,
): string =>
  space.kind === "team" ? spaceStorageKeyFor(space, NEW_CHAT_CHOICE_KEY) : NEW_CHAT_CHOICE_KEY;

const newChatChoiceAtoms = new Map<string, PersistedAtomDefinition<AgentModelSelection | null>>();

/**
 * What a new chat starts on in this window's Space: the last choice made in any of its unstarted
 * chats' Composers, on any Agent. It stands apart from the Composer choices so eviction there can
 * never forget it.
 */
export function agentRuntimeNewChatChoiceAtom(): PersistedAtomDefinition<AgentModelSelection | null> {
  const storageKey = newChatChoiceStorageKey(rendererSpace());
  const existing = newChatChoiceAtoms.get(storageKey);
  if (existing) return existing;
  const definition = persistedAtom<AgentModelSelection | null>({
    debugLabel: "agent-runtime-new-chat-choice",
    storageKey,
    defaultValue: null,
    hydration: "eager",
    synchronization: "cross-window",
    decode: (value) => decodeWith(selection)(value) ?? null,
  });
  newChatChoiceAtoms.set(storageKey, definition);
  return definition;
}
