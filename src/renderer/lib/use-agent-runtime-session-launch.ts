import { useCallback } from "react";
import {
  agentRuntimeChoiceKey,
  agentRuntimeComposerChoicesAtom,
  agentRuntimeNewChatChoiceAtom,
} from "../features/local-conversation/agent-runtime-composer-choices";
import { agentRuntimeModelSelection } from "../../shared/agent-runtime-provider";
import {
  getConcretePersistedAtom,
  preloadPersistedAtom,
  useMaitaiStore,
  type PersistedAtomDefinition,
} from "./maitai";
import { useCodexServiceTierSettings } from "./use-codex-service-tier-settings";
import { launchAgentRuntimeSession } from "./agent-runtime-session-launch";

/** Page and Automations launches read the same hydrated choices as the chat Composer. */
export function useAgentRuntimeSessionLaunch() {
  const store = useMaitaiStore();
  const { serviceTierSettings } = useCodexServiceTierSettings();
  return useCallback(
    async (input: Parameters<typeof launchAgentRuntimeSession>[0]) => {
      const hydrated = async <Value>(definition: PersistedAtomDefinition<Value>) => {
        await preloadPersistedAtom(store, definition);
        const loaded = store.jotaiStore.get(getConcretePersistedAtom(store, definition));
        if (loaded.status !== "ready")
          throw loaded.error ?? new Error("The chat's Agent choice is not available yet");
        return loaded.value;
      };
      const [choices, newChatChoice] = await Promise.all([
        hydrated(agentRuntimeComposerChoicesAtom),
        hydrated(agentRuntimeNewChatChoiceAtom),
      ]);
      const draft = choices[agentRuntimeChoiceKey.draft(input.sessionId, input.projectId)];
      const selected = input.modelSelection ? undefined : draft?.selection;
      const modelSelection = selected
        ? agentRuntimeModelSelection(selected.binding, selected.model, selected.options)
        : undefined;
      if (selected && !modelSelection)
        throw new Error(
          "The selected Agent or model is unavailable. Choose an available Agent model.",
        );
      return await launchAgentRuntimeSession({
        ...input,
        modelSelection: input.modelSelection ?? modelSelection ?? undefined,
        interactionMode: input.interactionMode ?? draft?.interactionMode,
        newChatDefaults: input.newChatDefaults ?? {
          remembered: newChatChoice,
          codexServiceTier: serviceTierSettings.serviceTier,
        },
      });
    },
    [store, serviceTierSettings.serviceTier],
  );
}
