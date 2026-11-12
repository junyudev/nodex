import { ProviderSessionId, type ProviderInstanceId } from "@nodex/runtime-contracts";

const projectSessionPrefix = "provider-session:codex-project:";

export const codexProjectSessionId = (instanceId: ProviderInstanceId, projectId: string) =>
  ProviderSessionId.make(projectSessionPrefix + JSON.stringify([instanceId, projectId]));

export const isCodexProjectSession = (id: ProviderSessionId | null | undefined) =>
  id?.startsWith(projectSessionPrefix) === true;
