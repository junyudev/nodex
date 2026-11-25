import type { AgentsMapReadInput } from "../../shared/agents-map";
import { invokeRendererQuery } from "./renderer-command";
import { isRemoteSpace } from "./renderer-space";
import { resolveRendererTransport } from "./renderer-transport";

export const readAgentsMap = (input: AgentsMapReadInput) =>
  invokeRendererQuery("agent-runtime:agents-map:read", input);

export const subscribeAgentsMapChanges = (listener: (revision?: number) => void) => {
  const transport = resolveRendererTransport();
  return isRemoteSpace()
    ? transport.subscribeProjectSessionChanges(() => listener())
    : transport.subscribeAgentsMapChanges?.(listener);
};
