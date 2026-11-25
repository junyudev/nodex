import {
  AGENT_RUNTIME_COMPOSER_CHOICES_STORAGE_KEY,
  AGENT_RUNTIME_MODEL_OPTIONS_STORAGE_KEY,
  AGENT_RUNTIME_NEW_CHAT_CHOICE_STORAGE_KEY,
} from "./agent-runtime-composer-choice-storage";
import { acpRegistryAgent } from "./agents/acp-registry";
import { repairLegacyAcpInstanceId } from "./agents/legacy-identity";
import type { PersistedAtomState } from "./ipc-api";
import { personalStateKeySpace } from "./space-personal-state";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function repairSelection(selection: unknown): unknown {
  if (!isRecord(selection) || !isRecord(selection.binding)) return selection;
  const { binding } = selection;
  const key =
    binding.driver === acpRegistryAgent.driver
      ? "instanceId"
      : binding.kind === acpRegistryAgent.settingsAnchor
        ? "runtimeInstanceId"
        : null;
  if (!key || typeof binding[key] !== "string") return selection;
  const id = repairLegacyAcpInstanceId(binding[key]);
  return id === binding[key] ? selection : { ...selection, binding: { ...binding, [key]: id } };
}

function repairChoices(choices: unknown): unknown {
  if (!isRecord(choices)) return choices;
  let next = choices;
  for (const [key, choice] of Object.entries(choices)) {
    if (!isRecord(choice)) continue;
    const selection = repairSelection(choice.selection);
    if (selection === choice.selection) continue;
    if (next === choices) next = { ...choices };
    next[key] = { ...choice, selection };
  }
  return next;
}

function repairRememberedOptions(options: unknown): unknown {
  if (!isRecord(options)) return options;
  let next = options;
  for (const [id, models] of Object.entries(options)) {
    // Model option memory uses unqualified keys. Other producers have always emitted valid IDs.
    const repaired = repairLegacyAcpInstanceId(id);
    if (repaired === id) continue;
    if (next === options) next = { ...options };
    const current = next[repaired];
    next[repaired] =
      isRecord(current) && isRecord(models) ? { ...models, ...current } : (current ?? models);
    delete next[id];
  }
  return next;
}

const isNewChatChoiceKey = (key: string): boolean =>
  key === AGENT_RUNTIME_NEW_CHAT_CHOICE_STORAGE_KEY ||
  (key.startsWith('["space",') &&
    Boolean(personalStateKeySpace(key)) &&
    (JSON.parse(key) as unknown[])[3] === AGENT_RUNTIME_NEW_CHAT_CHOICE_STORAGE_KEY);

/** Uses the settings migration's deterministic mapping, regardless of which file loads first. */
export function migrateAcpComposerChoices(state: PersistedAtomState): PersistedAtomState {
  let next = state;
  for (const [key, previous] of Object.entries(state)) {
    let repaired = previous;
    if (key === AGENT_RUNTIME_COMPOSER_CHOICES_STORAGE_KEY) repaired = repairChoices(previous);
    else if (key === AGENT_RUNTIME_MODEL_OPTIONS_STORAGE_KEY)
      repaired = repairRememberedOptions(previous);
    else if (isNewChatChoiceKey(key)) repaired = repairSelection(previous);
    if (repaired === previous) continue;
    if (next === state) next = { ...state };
    next[key] = repaired;
  }
  return next;
}
