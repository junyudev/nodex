import { useQuery } from "@tanstack/react-query";
import { invokeRendererQuery } from "./renderer-command";
import { isRemoteSpace, spaceQueryKey } from "./renderer-space";

/** Availability is scoped to this renderer's Space; personal execution is embedded in Main. */
export function useSpaceHostAvailable(): boolean {
  const remote = isRemoteSpace();
  const host = useQuery({
    queryKey: spaceQueryKey(["execution-host"]),
    queryFn: () => invokeRendererQuery("work:host-status"),
    enabled: remote,
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: false,
  });
  return !remote || host.data?.available === true;
}
