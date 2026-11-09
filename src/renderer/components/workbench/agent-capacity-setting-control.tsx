import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_AGENT_RUNTIME_SETTINGS } from "../../../shared/agent-runtime-settings";
import {
  agentRuntimeSettingsQueryOptions,
  updateAgentRuntimeSettings,
} from "@/lib/agent-runtime-settings";
import { NodexSettingsNumberInput } from "@/components/ui/settings";
import { toastFailure } from "@/lib/failure-toast";

export function AgentCapacitySettingControl() {
  const client = useQueryClient();
  const settings = useQuery(agentRuntimeSettingsQueryOptions());
  const [draft, setDraft] = useState<string | null>(null);
  const value = settings.data ?? DEFAULT_AGENT_RUNTIME_SETTINGS;
  const save = useMutation({
    mutationFn: (automaticWorkAtOnce: number) =>
      updateAgentRuntimeSettings(client, { ...value, automaticWorkAtOnce }),
    onError: (cause) => toastFailure("Couldn’t save the automatic work limit", cause),
    onSettled: () => setDraft(null),
  });
  const commit = () => {
    if (draft === null) return;
    const number = Number(draft);
    if (!draft.trim() || !Number.isFinite(number)) return setDraft(null);
    const next = Math.max(1, Math.min(16, Math.round(number)));
    if (next === value.automaticWorkAtOnce) return setDraft(null);
    save.mutate(next);
  };
  return (
    <NodexSettingsNumberInput
      aria-label="Automatic work at once"
      className="w-16"
      min={1}
      max={16}
      step={1}
      disabled={settings.isPending || save.isPending}
      value={draft ?? value.automaticWorkAtOnce}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
