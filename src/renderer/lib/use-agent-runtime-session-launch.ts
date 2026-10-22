import { useCallback } from "react";
import {
  agentRuntimeChoiceKey,
  agentRuntimeComposerChoicesAtom,
} from "../features/local-conversation/agent-runtime-composer-choices";
import { agentRuntimeModelSelection } from "../../shared/agent-runtime-provider";
import { getConcretePersistedAtom, preloadPersistedAtom, useMaitaiStore } from "./maitai";
import { useCodexThreadSettings } from "./use-codex-thread-settings";
import { useCodexServiceTierSettings } from "./use-codex-service-tier-settings";
import { launchAgentRuntimeSession } from "./agent-runtime-session-launch";

/** Page and Scheduled launches read the same hydrated draft choice as the chat Composer. */
export function useAgentRuntimeSessionLaunch() {
  const store = useMaitaiStore();
  const { settings } = useCodexThreadSettings();
  const { serviceTierSettings } = useCodexServiceTierSettings();
  return useCallback(
    async (input: Parameters<typeof launchAgentRuntimeSession>[0]) => {
      await preloadPersistedAtom(store, agentRuntimeComposerChoicesAtom);
      const choices = store.jotaiStore.get(
        getConcretePersistedAtom(store, agentRuntimeComposerChoicesAtom),
      );
      if (choices.status !== "ready")
        throw choices.error ?? new Error("The chat's Agent choice is not available yet");
      const draft = choices.value[agentRuntimeChoiceKey.draft(input.sessionId, input.projectId)];
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
        codexDefaults: input.codexDefaults ?? {
          ...settings,
          serviceTier: serviceTierSettings.serviceTier,
        },
      });
    },
    [store, settings, serviceTierSettings.serviceTier],
  );
}
