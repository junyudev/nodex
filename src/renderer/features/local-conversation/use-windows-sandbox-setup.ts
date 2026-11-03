import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { resolveCodexRendererOs } from "@/lib/codex-window-runtime";
import { windowsSandboxReadinessNotice } from "./agent-readiness-notice";

/** Setup belongs to the selected Codex instance; every window observes the same attempt. */
export function useWindowsSandboxSetup(instanceId: string | null) {
  const client = useQueryClient();
  const queryKey = ["agent-windows-sandbox", instanceId];
  const enabled = instanceId !== null && resolveCodexRendererOs() === "win32";
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: () => agentRuntimeRuntime.readWindowsSandbox({ instanceId: instanceId! }),
    staleTime: 10_000,
    refetchInterval: (query) =>
      ["checking", "settingUp"].includes(query.state.data?.status ?? "") ? 1_000 : false,
  });
  if (!enabled) return null;
  const checkAgain = async () => {
    await client.cancelQueries({ queryKey });
    client.setQueryData(
      queryKey,
      await agentRuntimeRuntime.readWindowsSandbox({ instanceId: instanceId!, refresh: true }),
    );
  };
  return windowsSandboxReadinessNotice(
    query.data,
    {
      checkAgain,
      setup: async (mode) => {
        await client.cancelQueries({ queryKey });
        client.setQueryData(
          queryKey,
          await agentRuntimeRuntime.setupWindowsSandbox({ instanceId: instanceId!, mode }),
        );
      },
      cancel: async (generation) => {
        await client.cancelQueries({ queryKey });
        client.setQueryData(
          queryKey,
          await agentRuntimeRuntime.cancelWindowsSandbox({ instanceId: instanceId!, generation }),
        );
      },
    },
    query.isError,
  );
}
